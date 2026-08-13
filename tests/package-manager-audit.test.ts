import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { runDependencyAudit } from "../src/engines/security/audit.js";
import type { EngineContext } from "../src/engines/types.js";

const AUDIT_OUTPUT = JSON.stringify({
	vulnerabilities: {
		"fixture-package": {
			name: "fixture-package",
			severity: "high",
			isDirect: true,
			range: "<2.0.0",
			fixAvailable: false,
			via: [
				{
					source: 1,
					name: "fixture-package",
					title: "fixture advisory",
					severity: "high",
					range: "<2.0.0",
				},
			],
		},
	},
});

const auditContext = (rootDirectory: string): EngineContext => ({
	rootDirectory,
	languages: ["typescript"],
	frameworks: [],
	installedTools: {},
	config: DEFAULT_CONFIG,
});

describe("package-manager dependency audit integration", () => {
	const originalPath = process.env.PATH;
	const originalPathExtensions = process.env.PATHEXT;
	let rootDirectory: string;
	let binaryBaseDirectory: string;
	let binaryDirectory: string;

	beforeEach(() => {
		rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-package-manager-audit-"));
		binaryBaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-package-manager-binary-"));
		binaryDirectory = path.join(binaryBaseDirectory, "program files");
		fs.mkdirSync(binaryDirectory);
		fs.writeFileSync(path.join(rootDirectory, "package.json"), "{}\n");
		fs.writeFileSync(path.join(rootDirectory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		process.env.PATHEXT = originalPathExtensions;
		fs.rmSync(rootDirectory, { recursive: true, force: true });
		fs.rmSync(binaryBaseDirectory, { recursive: true, force: true });
	});

	it("executes the platform pnpm shim and parses its vulnerability result", async () => {
		const shimPath = path.join(binaryDirectory, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
		const outputScriptName = "audit-output.cjs";
		fs.writeFileSync(
			path.join(binaryDirectory, outputScriptName),
			`process.stdout.write(${JSON.stringify(AUDIT_OUTPUT)});\n`,
			"utf-8",
		);
		const script =
			process.platform === "win32"
				? `@echo off\r\n"${process.execPath}" "%~dp0${outputScriptName}"\r\n`
				: `#!/usr/bin/env node\nrequire("./${outputScriptName}");\n`;
		fs.writeFileSync(shimPath, script, "utf-8");
		if (process.platform !== "win32") fs.chmodSync(shimPath, 0o755);
		if (process.platform === "win32") {
			fs.writeFileSync(
				path.join(rootDirectory, "pnpm.cmd"),
				'@echo off\r\necho shadowed>"%~dp0shadowed.txt"\r\n',
				"utf-8",
			);
			process.env.PATHEXT = ".CMD;.EXE";
		}
		process.env.PATH = `${rootDirectory}${path.delimiter}${binaryDirectory}${path.delimiter}${originalPath ?? ""}`;

		const diagnostics = await runDependencyAudit(auditContext(rootDirectory));

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("security/vulnerable-dependency");
		expect(diagnostics[0].message).toContain("fixture-package");
		expect(fs.existsSync(path.join(rootDirectory, "shadowed.txt"))).toBe(false);
	});

	it.skipIf(process.platform !== "win32")(
		"executes a standalone pnpm executable resolved through PATHEXT",
		async () => {
			fs.linkSync(process.execPath, path.join(binaryDirectory, "pnpm.exe"));
			fs.writeFileSync(
				path.join(rootDirectory, "audit"),
				`process.stdout.write(${JSON.stringify(AUDIT_OUTPUT)});\n`,
				"utf-8",
			);
			process.env.PATHEXT = ".EXE;.CMD";
			process.env.PATH = `${binaryDirectory}${path.delimiter}${originalPath ?? ""}`;

			const diagnostics = await runDependencyAudit(auditContext(rootDirectory));

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].rule).toBe("security/vulnerable-dependency");
			expect(diagnostics[0].message).toContain("fixture-package");
		},
	);
});
