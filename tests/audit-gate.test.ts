import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../src/engines/types.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));

vi.mock("../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/subprocess.js")>();
	return { ...actual, runSubprocess };
});

const { isPathWithin, runDependencyAudit } = await import("../src/engines/security/audit.js");
const { runCargoAudit, runGovulncheck, runPipAudit } = await import(
	"../src/engines/security/audit-ecosystem.js"
);

const auditContext = (
	rootDirectory: string,
	languages: EngineContext["languages"],
	installedTools: EngineContext["installedTools"],
	dependencyAuditLanguages?: EngineContext["dependencyAuditLanguages"],
): EngineContext => ({
	rootDirectory,
	languages,
	dependencyAuditLanguages,
	frameworks: [],
	installedTools,
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: true, auditTimeout: 1000 },
		lint: { typecheck: false, expoDoctor: false },
	},
});

const pythonContext = (rootDirectory: string): EngineContext =>
	auditContext(rootDirectory, ["python"], { "pip-audit": true });

describe("path containment", () => {
	it("does not classify a Windows path on another drive as a descendant", () => {
		expect(isPathWithin("D:\\repo", "C:\\Program Files\\nodejs\\pnpm.cmd")).toBe(false);
		expect(isPathWithin("D:\\repo", "D:\\repo\\pnpm.cmd")).toBe(true);
	});
});

describe("runDependencyAudit: Python dependency-manifest gate", () => {
	let dir: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		runSubprocess.mockResolvedValue({ stdout: '{"dependencies":[]}', stderr: "", exitCode: 0 });
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-audit-gate-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("does not run pip-audit on a source-only Python tree (no dependency manifest)", async () => {
		fs.writeFileSync(path.join(dir, "main.py"), "print('hi')\n");

		await runDependencyAudit(pythonContext(dir));

		expect(runSubprocess).not.toHaveBeenCalled();
	});

	it("runs pip-audit once a dependency manifest is present", async () => {
		fs.writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");

		await runDependencyAudit(pythonContext(dir));

		expect(runSubprocess).toHaveBeenCalledWith("pip-audit", ["--format=json"], expect.anything());
	});

	it("keys the dotnet audit to manifest-aware audit languages, not scan-scope languages", async () => {
		// A .csproj is what the NuGet audit needs; csharp may be absent from the
		// file-derived scan languages (e.g. every .cs excluded) yet present in
		// dependencyAuditLanguages from manifest-aware discovery.
		fs.writeFileSync(path.join(dir, "App.csproj"), "<Project></Project>\n");
		const context = auditContext(dir, [], { dotnet: true }, ["csharp"]);
		context.config.lint.csharp = {
			projectEvaluation: true,
			jb: true,
			roslynator: true,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: [],
		};

		await runDependencyAudit(context);

		expect(runSubprocess).toHaveBeenCalledWith(
			"dotnet",
			expect.arrayContaining(["list"]),
			expect.anything(),
		);
	});

	it("does not evaluate dotnet project files without explicit trust", async () => {
		fs.writeFileSync(path.join(dir, "App.csproj"), "<Project></Project>\n");
		const context = auditContext(dir, ["csharp"], { dotnet: true });
		context.config.lint.csharp = {
			projectEvaluation: false,
			jb: true,
			roslynator: true,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: [],
		};

		await runDependencyAudit(context);

		expect(runSubprocess).not.toHaveBeenCalled();
	});
});

describe("runDependencyAudit: JavaScript package-manager launch", () => {
	let dir: string;
	let binaryDirectory: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		runSubprocess.mockResolvedValue({ stdout: '{"vulnerabilities":{}}', stderr: "", exitCode: 0 });
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-audit-package-manager-"));
		binaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-audit-binary-"));
		fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
		fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(binaryDirectory, { recursive: true, force: true });
	});

	it("resolves a Windows command shim from PATH without considering the repository", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
		vi.stubEnv("PATHEXT", ".CMD;.EXE");
		const spacedBinaryDirectory = path.join(binaryDirectory, "program files");
		fs.mkdirSync(spacedBinaryDirectory);
		vi.stubEnv("PATH", `${dir}${path.delimiter}${spacedBinaryDirectory}`);
		fs.writeFileSync(path.join(dir, "pnpm.cmd"), "malicious repository shim\n");
		const trustedShim = path.join(spacedBinaryDirectory, "pnpm.cmd");
		fs.writeFileSync(trustedShim, "trusted PATH shim\n");

		await runDependencyAudit(auditContext(dir, ["typescript"], {}));

		expect(runSubprocess).toHaveBeenCalledWith(
			"C:\\Windows\\System32\\cmd.exe",
			["/d", "/c", fs.realpathSync(trustedShim), "audit", "--json"],
			expect.anything(),
		);
	});

	it.skipIf(process.platform === "win32")(
		"rejects a repository-local executable symlink that resolves outside the repository",
		async () => {
			vi.spyOn(process, "platform", "get").mockReturnValue("win32");
			vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
			vi.stubEnv("PATHEXT", ".EXE;.CMD");
			vi.stubEnv("PATH", `${dir}${path.delimiter}${binaryDirectory}`);
			const externalExecutable = path.join(binaryDirectory, "node.exe");
			fs.writeFileSync(externalExecutable, "external executable\n");
			fs.symlinkSync(externalExecutable, path.join(dir, "pnpm.exe"));
			const trustedShim = path.join(binaryDirectory, "pnpm.cmd");
			fs.writeFileSync(trustedShim, "trusted PATH shim\n");

			await runDependencyAudit(auditContext(dir, ["typescript"], {}));

			expect(runSubprocess).toHaveBeenCalledWith(
				"C:\\Windows\\System32\\cmd.exe",
				["/d", "/c", fs.realpathSync(trustedShim), "audit", "--json"],
				expect.anything(),
			);
		},
	);

	it("launches a resolved Windows executable directly", async () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.stubEnv("PATHEXT", ".EXE;.CMD");
		vi.stubEnv("PATH", binaryDirectory);
		const executable = path.join(binaryDirectory, "pnpm.exe");
		fs.writeFileSync(executable, "standalone executable\n");

		await runDependencyAudit(auditContext(dir, ["typescript"], {}));

		expect(runSubprocess).toHaveBeenCalledWith(
			fs.realpathSync(executable),
			["audit", "--json"],
			expect.anything(),
		);
	});

	it("reports a failed package-manager launch as a warning", async () => {
		runSubprocess.mockRejectedValue(new Error("spawn pnpm ENOENT"));

		const diagnostics = await runDependencyAudit(auditContext(dir, ["typescript"], {}));

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("security/dependency-audit-skipped");
		expect(diagnostics[0].severity).toBe("warning");
	});

	it("reports a nonzero package-manager exit without JSON as a warning", async () => {
		runSubprocess.mockResolvedValue({ stdout: "", stderr: "audit registry failed", exitCode: 1 });

		const diagnostics = await runDependencyAudit(auditContext(dir, ["typescript"], {}));

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("security/dependency-audit-skipped");
		expect(diagnostics[0].severity).toBe("warning");
		expect(diagnostics[0].help).toContain("audit registry failed");
	});

	it.each([
		{ stdout: "", stderr: "", exitCode: 0 },
		{ stdout: "not json", stderr: "audit registry failed", exitCode: 1 },
		{ stdout: "[]", stderr: "", exitCode: 0 },
		{ stdout: "{}", stderr: "", exitCode: 0 },
	])("reports unusable audit output as a warning: $stdout", async (result) => {
		runSubprocess.mockResolvedValue(result);

		const diagnostics = await runDependencyAudit(auditContext(dir, ["typescript"], {}));

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("security/dependency-audit-skipped");
		expect(diagnostics[0].severity).toBe("warning");
	});
});

describe("external ecosystem audit payloads", () => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	it("parses valid pip, Cargo, and govuln results", async () => {
		runSubprocess
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ dependencies: [{ name: "requests", vulns: [{}] }] }),
				stderr: "",
				exitCode: 1,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					vulnerabilities: { list: [{ advisory: { id: "RUSTSEC-1", title: "unsafe" } }] },
				}),
				stderr: "",
				exitCode: 1,
			})
			.mockResolvedValueOnce({
				stdout: `${JSON.stringify({ vulnerability: { id: "GO-1", details: "unsafe" } })}\n`,
				stderr: "",
				exitCode: 1,
			});

		await expect(runPipAudit("/repo", 1000)).resolves.toHaveLength(1);
		await expect(runCargoAudit("/repo", 1000)).resolves.toHaveLength(1);
		await expect(runGovulncheck("/repo", 1000)).resolves.toHaveLength(1);
	});

	it("ignores malformed top-level and nested values", async () => {
		runSubprocess
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					dependencies: [
						null,
						{ name: 42, vulns: [{}] },
						{ name: "requests", vulns: [null, [], "invalid"] },
					],
				}),
				stderr: "",
				exitCode: 1,
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					vulnerabilities: { list: [null, "invalid", { advisory: [] }] },
				}),
				stderr: "",
				exitCode: 1,
			})
			.mockResolvedValueOnce({
				stdout: `[1]\n${JSON.stringify({ vulnerability: [] })}\n${JSON.stringify({ vulnerability: { id: 42 } })}\n`,
				stderr: "",
				exitCode: 1,
			});

		await expect(runPipAudit("/repo", 1000)).resolves.toEqual([]);
		await expect(runCargoAudit("/repo", 1000)).resolves.toEqual([]);
		await expect(runGovulncheck("/repo", 1000)).resolves.toEqual([]);
	});
});
