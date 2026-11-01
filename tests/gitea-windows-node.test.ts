import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

interface WorkflowStep {
	name?: string;
	shell?: string;
	run: string;
	if?: string;
	"continue-on-error"?: boolean;
}

const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
	engines: { node: string };
};
const workflow = parseYaml(fs.readFileSync(".gitea/workflows/ci.yml", "utf8")) as {
	jobs: { "test-windows": { steps: WorkflowStep[] } };
};
const windowsSteps = workflow.jobs["test-windows"].steps;
const guardStep = windowsSteps.find((step) => step.name?.startsWith("Verify host Node"));
if (!guardStep) throw new Error("Windows host Node verification step is missing");

const powershellExecutable = process.env.PWSH_PATH ?? "pwsh";
const powershellProbe = spawnSync(powershellExecutable, [
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	"exit 0",
]);
const skipPowerShell = powershellProbe.status !== 0 && process.platform !== "win32";
const powerShellIt = it.skipIf(skipPowerShell);
if (skipPowerShell) {
	console.info("pwsh is unavailable; skipping executable Windows guard cases on this non-Windows host.");
}

const runGuard = (versionOutput: string, versionExitCode = 0) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-windows-node-"));
	try {
		const binaryDirectory = path.join(directory, "bin");
		fs.mkdirSync(binaryDirectory);
		fs.copyFileSync("package.json", path.join(directory, "package.json"));
		const major = /^\d+/.exec(versionOutput.replace(/^v/, ""))?.[0] ?? "22";
		const script = process.platform === "win32" ? "node.cmd" : "node";
		const contents =
			process.platform === "win32"
				? [
						"@echo off",
						'if "%~1"=="--version" (',
						"echo %FAKE_NODE_VERSION%",
						"exit /b %FAKE_NODE_EXIT%",
						")",
						'if "%~1"=="-e" (',
						"echo %FAKE_NODE_MAJOR%",
						"exit /b 0",
						")",
						"exit /b 64",
					]
				: [
						"#!/bin/sh",
						'if [ "$1" = "--version" ]; then',
						'printf \'%s\\n\' "$FAKE_NODE_VERSION"',
						'exit "$FAKE_NODE_EXIT"',
						"fi",
						'if [ "$1" = "-e" ]; then',
						'printf \'%s\\n\' "$FAKE_NODE_MAJOR"',
						"exit 0",
						"fi",
						"exit 64",
					];
		fs.writeFileSync(path.join(binaryDirectory, script), contents.join("\n"), { mode: 0o755 });
		return spawnSync(
			powershellExecutable,
			["-NoProfile", "-NonInteractive", "-Command", guardStep.run],
			{
				cwd: directory,
				encoding: "utf8",
				env: {
					...process.env,
					PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
					FAKE_NODE_VERSION: versionOutput,
					FAKE_NODE_EXIT: String(versionExitCode),
					FAKE_NODE_MAJOR: major,
				},
			},
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
};

describe("Gitea Windows host Node supported-range guard", () => {
	it("runs unconditionally before Corepack, installation, and build steps", () => {
		const guardIndex = windowsSteps.indexOf(guardStep);
		const laterStepIndexes = windowsSteps.flatMap((step, index) =>
			step.name?.startsWith("Activate pnpm") ||
			step.name === "Install dependencies" ||
			step.name === "Build"
				? [index]
				: [],
		);

		expect(guardStep.name).toContain("supported range");
		expect(guardStep.shell).toBe("pwsh");
		expect(guardStep.if).toBeUndefined();
		expect(guardStep["continue-on-error"]).toBeUndefined();
		expect(laterStepIndexes).toHaveLength(3);
		for (const index of laterStepIndexes) expect(guardIndex).toBeLessThan(index);
	});

	it("keeps the bounded predicate coupled to the manifest engine policy", () => {
		// Changing this policy requires deliberately updating the two PowerShell intervals.
		expect(packageManifest.engines.node).toBe("^22.18.0 || >=24.11.0");
	});

	powerShellIt.each([
		{ version: "18.20.0", expectedStatus: 1 },
		{ version: "20.19.0", expectedStatus: 1 },
		{ version: "21.7.0", expectedStatus: 1 },
		{ version: "22.17.0", expectedStatus: 1 },
		{ version: "22.17.99", expectedStatus: 1 },
		{ version: "23.0.0", expectedStatus: 1 },
		{ version: "24.0.0", expectedStatus: 1 },
		{ version: "24.10.0", expectedStatus: 1 },
		{ version: "24.10.99", expectedStatus: 1 },
		{ version: "22.18.0-rc.1", expectedStatus: 1 },
		{ version: "24.11.0-rc.1", expectedStatus: 1 },
		{ version: "25.0.0-rc.1", expectedStatus: 1 },
		{ version: "22.18.0", expectedStatus: 0 },
		{ version: "22.18.1", expectedStatus: 0 },
		{ version: "22.23.3", expectedStatus: 0 },
		{ version: "24.11.0", expectedStatus: 0 },
		{ version: "24.11.1", expectedStatus: 0 },
		{ version: "25.0.0", expectedStatus: 0 },
		{ version: "24.11.0+build.1", expectedStatus: 0 },
	])("enforces engines.node boundaries (issue 181): $version", ({ version, expectedStatus }) => {
		const result = runGuard(`v${version}`);
		const output = result.stdout + result.stderr;

		expect(result.error).toBeUndefined();
		expect(result.status, output).toBe(expectedStatus);
		if (expectedStatus === 0) {
			expect(result.stdout).toContain(`v${version}`);
		} else {
			expect(output).toContain(`v${version}`);
			expect(output).toContain(packageManifest.engines.node);
			expect(output).not.toContain("< 20");
		}
	});

	powerShellIt.each([
		{ name: "native version command failure", output: "v22.18.0", exitCode: 1 },
		{ name: "malformed version output", output: "not-a-version", exitCode: 0 },
	])("rejects a $name", ({ output, exitCode }) => {
		const result = runGuard(output, exitCode);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stdout + result.stderr).not.toBe(0);
	});
});
