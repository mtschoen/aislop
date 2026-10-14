import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import vitestConfiguration from "../vitest.config.js";

const executeFile = promisify(execFile);

const captureStatusPost = async (
	reportPath: string,
): Promise<{ body: Record<string, string>; stderr: string; stdout: string }> => {
	let resolveBody: ((body: Record<string, string>) => void) | undefined;
	const receivedBody = new Promise<Record<string, string>>((resolve) => {
		resolveBody = resolve;
	});
	const server = http.createServer((request, response) => {
		let requestBody = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			requestBody += chunk;
		});
		request.on("end", () => {
			resolveBody?.(JSON.parse(requestBody));
			response.writeHead(201).end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		const { stderr, stdout } = await executeFile(
			"python3",
			["ci/post-coverage-status.py", "--cobertura", reportPath],
			{
				env: {
					...process.env,
					GITHUB_SERVER_URL: `http://127.0.0.1:${port}`,
					GITHUB_REPOSITORY: "schoen/aislop",
					GITHUB_SHA: "abc123",
					GITHUB_RUN_ID: "42",
					GITHUB_TOKEN: "test-token",
				},
			},
		);
		return { body: await receivedBody, stderr, stdout };
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
};

describe("Gitea coverage status", () => {
	it("measures source coverage and always posts the pr-crew status", async () => {
		const workflow = parseYaml(fs.readFileSync(".gitea/workflows/ci.yml", "utf8"));
		const coverageJob = workflow.jobs.coverage;

		expect(coverageJob.permissions).toEqual({ contents: "write" });
		expect(coverageJob.steps).toContainEqual(
			expect.objectContaining({
				name: "Measure coverage",
				// The step must go through the test:coverage script so vitest.config.ts's
				// coverage reporters apply; extra vitest flags after it are allowed.
				run: expect.stringMatching(/^pnpm test:coverage(\s|$)/),
			}),
		);
		expect(coverageJob.steps).toContainEqual(
			expect.objectContaining({
				name: "Post coverage status",
				if: "${{ always() }}",
				env: { GITHUB_TOKEN: "${{ github.token }}" },
				run: 'python3 ci/post-coverage-status.py --cobertura "coverage/cobertura-coverage.xml"',
			}),
		);

		const qualityGateJob = workflow.jobs["quality-gate"];
		const toolProvisionStep = qualityGateJob.steps.find(
			(step: { name?: string }) =>
				step.name?.toLowerCase().includes("provision") || step.name?.toLowerCase().includes("ruff"),
		);
		expect(toolProvisionStep).toBeDefined();
		expect(toolProvisionStep.run).not.toContain("install-tools.mjs");
		expect(toolProvisionStep.run).toContain("ruff --version");
		expect(toolProvisionStep.run).toContain("read-tool-pin.mjs ruff");
		expect(toolProvisionStep.run).toContain("read-tool-pin.mjs golangci-lint");
		expect(toolProvisionStep.run).toContain("golangci-lint version");

		const ruffPin = await executeFile(process.execPath, ["scripts/read-tool-pin.mjs", "ruff"]);
		expect(ruffPin.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
		const golangciPin = await executeFile(process.execPath, [
			"scripts/read-tool-pin.mjs",
			"golangci-lint",
		]);
		expect(golangciPin.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it.skipIf(process.platform === "win32").each(
		["PATH", "tool store", "final verification"].flatMap((source) =>
			[
				{ name: "exact pins", tool: "ruff", suffix: "", exitCode: 0, accepted: true },
				{
					name: "F4-1 Ruff prefix collision",
					tool: "ruff",
					suffix: "0",
					exitCode: 0,
					accepted: false,
				},
				{
					name: "F4-2 golangci prefix collision",
					tool: "golangci-lint",
					suffix: "0",
					exitCode: 0,
					accepted: false,
				},
				{
					name: "F4-2 pin outside version field",
					tool: "golangci-lint",
					suffix: " other",
					exitCode: 0,
					accepted: false,
				},
				{
					name: "F4-3 Ruff command failure",
					tool: "ruff",
					suffix: "",
					exitCode: 1,
					accepted: false,
				},
				{
					name: "F4-4 golangci command failure",
					tool: "golangci-lint",
					suffix: "",
					exitCode: 1,
					accepted: false,
				},
			].map((scenario) => ({ ...scenario, source })),
		),
	)(
		"provisions only successful pinned tools: $source / $name",
		({ source, tool, suffix, exitCode, accepted }) => {
			const workflow = parseYaml(fs.readFileSync(".gitea/workflows/ci.yml", "utf8"));
			const step = workflow.jobs["quality-gate"].steps.find(
				(entry: { name?: string }) => entry.name === "Provision lint tools from runner tool store",
			);
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-provision-"));
			try {
				const binaryDirectory = path.join(directory, "bin");
				fs.mkdirSync(binaryDirectory);
				fs.symlinkSync(process.execPath, path.join(binaryDirectory, "node"));
				for (const command of ["mkdir", "ln"]) {
					fs.symlinkSync(`/bin/${command}`, path.join(binaryDirectory, command));
				}
				fs.mkdirSync(path.join(directory, "scripts"));
				for (const script of ["read-tool-pin.mjs", "install-tools.mjs"]) {
					fs.copyFileSync(path.join("scripts", script), path.join(directory, "scripts", script));
				}
				// Redirect every runner-only search path so installed host tools cannot satisfy the test.
				const script = step.run.replace(
					/\/(?:opt|usr)\//g,
					(prefix: string) => `${directory}/runner${prefix}`,
				);
				const candidateDirectory =
					source === "PATH"
						? binaryDirectory
						: source === "tool store"
							? path.join(directory, "runner/usr/local/bin")
							: path.join(directory, "tools/bin");
				fs.mkdirSync(candidateDirectory, { recursive: true });
				for (const name of ["ruff", "golangci-lint"]) {
					const pin = spawnSync(process.execPath, ["scripts/read-tool-pin.mjs", name], {
						encoding: "utf8",
					});
					expect(pin.status).toBe(0);
					const version = pin.stdout.trim();
					const reported = name === tool ? version + suffix : version;
					const banner =
						name === "ruff"
							? `ruff ${reported}`
							: `golangci-lint has version ${suffix === " other" ? `9.9.9 built with ${version}` : `${reported} built with go1.26.0`}`;
					fs.writeFileSync(
						path.join(candidateDirectory, name),
						`#!/bin/sh\nprintf '%s\\n' '${banner}'\nexit ${name === tool ? exitCode : 0}\n`,
						{ mode: 0o755 },
					);
				}
				const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
					cwd: directory,
					env: { PATH: binaryDirectory, GITHUB_PATH: path.join(directory, "github-path") },
					encoding: "utf8",
				});
				expect(result.error).toBeUndefined();
				expect(result.status, result.stdout + result.stderr).toBe(accepted ? 0 : 1);
				if (source !== "final verification") {
					expect(fs.existsSync(path.join(directory, "tools/bin", tool))).toBe(accepted);
				}
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
	);

	it("configures Vitest to report coverage for all production source files", () => {
		expect(vitestConfiguration.test?.coverage).toMatchObject({
			provider: "v8",
			include: ["src/**/*.{ts,tsx}"],
			reporter: ["text-summary", "cobertura"],
			reportOnFailure: true,
		});

		const packageManifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
		expect(packageManifest.scripts["test:coverage"]).toBe("vitest run --coverage");
		expect(packageManifest.devDependencies["@vitest/coverage-v8"]).toBe("5.0.2");
	});

	it("vendors the shared helper with the exact status context", () => {
		const helper = fs.readFileSync("ci/post-coverage-status.py", "utf8");

		expect(helper).toContain('"context": "pr-crew/coverage"');
		expect(helper).toContain('"state": state');
		expect(helper).toContain('f"{percent}% line coverage"');
	});

	it.skipIf(process.platform === "win32")(
		"posts the measured line percentage with a reproducible target URL",
		async () => {
			const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-status-helper-"));
			const reportPath = path.join(temporaryDirectory, "coverage.xml");
			fs.writeFileSync(
				reportPath,
				[
					"<coverage><packages><package><classes>",
					'<class filename="src/example.ts"><lines>',
					'<line number="1" hits="1"/><line number="2" hits="1"/>',
					'<line number="3" hits="0"/><line number="4" hits="1"/>',
					"</lines></class></classes></package></packages></coverage>",
				].join(""),
				"utf8",
			);

			try {
				const { body, stdout } = await captureStatusPost(reportPath);

				expect(body).toEqual({
					context: "pr-crew/coverage",
					state: "success",
					description: "75.0% line coverage",
					target_url: expect.stringMatching(/\/schoen\/aislop\/actions\/runs\/42$/),
				});
				expect(stdout).toContain("posted pr-crew/coverage success: 75.0% line coverage");
			} finally {
				fs.rmSync(temporaryDirectory, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"posts an error status without masking a missing coverage report",
		async () => {
			const missingReport = path.join(
				os.tmpdir(),
				`aislop-missing-coverage-${process.pid}-${Date.now()}.xml`,
			);

			const { body, stderr, stdout } = await captureStatusPost(missingReport);

			expect(body).toMatchObject({
				context: "pr-crew/coverage",
				state: "error",
				description: "coverage measurement failed",
			});
			expect(stderr).toContain("coverage measurement failed: no Cobertura XML matched");
			expect(stdout).toBe("");
		},
	);

	it.skipIf(process.platform === "win32").each([
		{
			name: "exact node banner on exit 0 produces baked true",
			version: "24.18.0",
			banner: "v24.18.0",
			exitCode: 0,
			expectedState: "true",
			expectedExit: 0,
		},
		{
			name: "node command returning nonzero fails probe",
			version: "24.18.0",
			banner: "v24.18.0",
			exitCode: 1,
			expectedState: "false",
			expectedExit: 0,
		},
		{
			name: "node version prefix collision fails probe",
			version: "24.18.0",
			banner: "v24.18.00",
			exitCode: 0,
			expectedState: "false",
			expectedExit: 0,
		},
		{
			name: "missing image.env falls back to false",
			version: null,
			banner: null,
			exitCode: 0,
			expectedState: "false",
			expectedExit: 0,
		},
		{
			name: "unsupported or removed tool mode exits 2",
			version: "24.18.0",
			banner: "v24.18.0",
			exitCode: 0,
			expectedState: null,
			expectedExit: 2,
			tool: "python",
		},
		{
			name: "directory GITHUB_PATH publication failure reports false",
			version: "24.18.0",
			banner: "v24.18.0",
			exitCode: 0,
			expectedState: "false",
			expectedExit: 0,
			githubPathType: "directory",
		},
		{
			name: "absent parent GITHUB_PATH publication failure reports false",
			version: "24.18.0",
			banner: "v24.18.0",
			exitCode: 0,
			expectedState: "false",
			expectedExit: 0,
			githubPathType: "missing-parent",
		},
	])(
		"probes baked toolchain: $name",
		({
			version,
			banner,
			exitCode,
			expectedState,
			expectedExit,
			tool = "node",
			githubPathType = "file",
		}) => {
			const temporaryDirectory = fs.mkdtempSync(
				path.join(os.tmpdir(), "aislop-baked-toolchain-"),
			);
			const githubOutputPath = path.join(temporaryDirectory, "github-output");
			let githubPath = path.join(temporaryDirectory, "github-path");
			fs.writeFileSync(githubOutputPath, "");
			if (githubPathType === "directory") {
				fs.mkdirSync(githubPath);
			} else if (githubPathType === "missing-parent") {
				githubPath = path.join(
					temporaryDirectory,
					"missing-parent-directory",
					"github-path",
				);
			} else {
				fs.writeFileSync(githubPath, "");
			}

			try {
				let imageEnvPath = path.join(temporaryDirectory, "nonexistent.env");
				if (version !== null) {
					imageEnvPath = path.join(temporaryDirectory, "image.env");
					fs.writeFileSync(imageEnvPath, `FLEET_NODE_VERSION="${version}"\n`, "utf8");
				}

				const helperPath = path.resolve("ci/baked-toolchain.sh");
				const script = [
					banner !== null
						? `function /opt/fleet/node-${version}/bin/node { printf '%s\\n' "${banner}"; return ${exitCode}; }`
						: "",
					`source "${helperPath}" "${tool}"`,
				].join("\n");

				const result = spawnSync("/bin/bash", ["-c", script], {
					env: {
						...process.env,
						FLEET_IMAGE_ENV: imageEnvPath,
						GITHUB_OUTPUT: githubOutputPath,
						GITHUB_PATH: githubPath,
					},
					encoding: "utf8",
				});

				expect(result.status).toBe(expectedExit);
				if (expectedState !== null) {
					const outputContent = fs.readFileSync(githubOutputPath, "utf8");
					expect(outputContent).toContain(`${tool}=${expectedState}`);
					expect(result.stdout).toContain(`baked ${tool}: ${expectedState}`);

					if (expectedState === "true") {
						const pathContent = fs.readFileSync(githubPath, "utf8");
						expect(pathContent).toContain(`/opt/fleet/node-${version}/bin`);
					} else if (fs.existsSync(githubPath) && fs.statSync(githubPath).isFile()) {
						const pathContent = fs.readFileSync(githubPath, "utf8");
						expect(pathContent).not.toContain(`/opt/fleet/node-${version}/bin`);
					}
				}
			} finally {
				fs.rmSync(temporaryDirectory, { recursive: true, force: true });
			}
		},
	);
});

