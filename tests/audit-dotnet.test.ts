import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../src/engines/types.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));

vi.mock("../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/subprocess.js")>();
	return {
		...actual,
		isToolInstalled: async (toolName: string) => toolName === "dotnet",
		runSubprocess,
	};
});

const { inspectDotnetAudit } = await import("../src/engines/security/audit-dotnet.js");
const { runDependencyAudit } = await import("../src/engines/security/audit.js");
const { handleAislopScan } = await import("../src/mcp/tools.js");
const { SubprocessTimeoutError } = await import("../src/utils/subprocess.js");

const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-audit-dotnet-"));
const firstProject = "src/First/First.csproj";
const secondProject = "src/Second/Second.csproj";
const otherProject = "other/Other.csproj";
const skippedRule = "security/dependency-audit-skipped";

for (const project of [firstProject, secondProject, otherProject]) {
	const fullPath = path.join(rootDirectory, project);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, "<Project />\n");
}
fs.writeFileSync(path.join(rootDirectory, "Mixed.sln"), "\n");
fs.mkdirSync(path.join(rootDirectory, ".aislop"), { recursive: true });
fs.writeFileSync(
	path.join(rootDirectory, ".aislop/config.yml"),
	[
		"version: 1",
		"exclude:",
		"  - src/Second/**",
		"  - other/**",
		"engines:",
		"  format: false",
		"  lint: false",
		"  code-quality: false",
		"  ai-slop: false",
		"  architecture: false",
		"  security: true",
		"security:",
		"  audit: true",
		"lint:",
		"  csharp:",
		"    projectEvaluation: true",
		"",
	].join("\n"),
);

afterAll(() => {
	fs.rmSync(rootDirectory, { recursive: true, force: true });
});

const contextFor = (files: string[]): EngineContext => ({
	rootDirectory,
	files: [],
	dependencyAuditFiles: files.map((file) => path.join(rootDirectory, file)),
	dependencyAuditLanguages: ["csharp"],
	languages: [],
	frameworks: [],
	installedTools: { dotnet: true },
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: true, auditTimeout: 1000 },
		lint: {
			typecheck: false,
			expoDoctor: false,
			csharp: {
				projectEvaluation: true,
				jb: false,
				roslynator: false,
				jbSeverityFloor: "WARNING",
				jbExcludeTypes: [],
			},
		},
	},
});

const reportFor = (project: string): string =>
	JSON.stringify({
		projects: [
			{
				path: path.join(rootDirectory, project),
				frameworks: [
					{
						framework: "net8.0",
						topLevelPackages: [
							{
								id: "Vulnerable.Package",
								resolvedVersion: "1.0.0",
								vulnerabilities: [
									{
										severity: "High",
										advisoryurl: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
									},
								],
							},
						],
					},
				],
			},
		],
	});

describe("per-project NuGet audits", () => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	it.each([
		{
			id: "ascii-project-basenames",
			projects: [firstProject, secondProject],
		},
		{
			id: "spaced-and-non-ascii-csproj-basenames",
			projects: ["src/Café/Café.csproj", "src/My App/My App.csproj"],
		},
	])(
		"merges findings from scoped projects without evaluating the solution ($id)",
		async ({ projects: [first, second] }) => {
			runSubprocess.mockImplementation(async (_command, arguments_) => ({
				stdout: reportFor(arguments_[1]),
				stderr: "",
				exitCode: 0,
			}));

			const outcome = await inspectDotnetAudit(
				contextFor([second, "../Outside.csproj", "Mixed.sln", first, first, "Native.vcxproj"]),
				1000,
			);

			expect(outcome.completed).toBe(true);
			expect(outcome.diagnostics.map((diagnostic) => diagnostic.filePath)).toEqual([first, second]);
			expect(
				outcome.diagnostics.every((diagnostic) => diagnostic.packageName === "Vulnerable.Package"),
			).toBe(true);
			expect(runSubprocess.mock.calls).toEqual(
				[first, second].map((project) => [
					"dotnet",
					[
						"list",
						project,
						"package",
						"--no-restore",
						"--vulnerable",
						"--include-transitive",
						"--format",
						"json",
					],
					{ cwd: rootDirectory, timeout: 1000 },
				]),
			);
		},
	);

	it.each(["exit 1", "invalid report", "timeout", "spawn failure"])(
		"names a project's %s while retaining the other project's findings",
		async (failure) => {
			runSubprocess.mockImplementation(async (_command, arguments_) => {
				const project = arguments_[1];
				if (project === firstProject) {
					if (failure === "timeout") {
						throw new SubprocessTimeoutError("dotnet timed out", reportFor(project), "");
					}
					if (failure === "spawn failure") throw new Error("spawn ENOENT");
					return {
						stdout:
							failure === "invalid report" ? '{"error":"missing assets"}' : reportFor(project),
						stderr: "missing project assets",
						exitCode: failure === "exit 1" ? 1 : 0,
					};
				}
				return { stdout: reportFor(project), stderr: "", exitCode: 0 };
			});

			const outcome = await inspectDotnetAudit(contextFor([firstProject, secondProject]), 1000);

			expect(outcome.completed).toBe(false);
			expect(outcome.diagnostics.filter((diagnostic) => diagnostic.rule === skippedRule)).toEqual([
				expect.objectContaining({ filePath: firstProject, severity: "warning" }),
			]);
			expect(outcome.diagnostics[0].message).toContain(firstProject);
			expect(outcome.diagnostics[0].help).toContain(`dotnet list "${firstProject}" package`);
			expect(outcome.diagnostics.filter((diagnostic) => diagnostic.packageName)).toEqual(
				(failure === "exit 1" || failure === "timeout"
					? [firstProject, secondProject]
					: [secondProject]
				).map((filePath) =>
					expect.objectContaining({ filePath, packageName: "Vulnerable.Package" }),
				),
			);
			expect(runSubprocess).toHaveBeenCalledTimes(2);
		},
	);

	it.each([
		{
			id: "csproj-selection",
			selected: [firstProject, secondProject],
			audited: [firstProject],
		},
		{
			id: "directory-packages-props-selection",
			selected: ["src/Directory.Packages.props"],
			audited: [firstProject],
		},
		{
			id: "packages-lock-json-owning-project",
			selected: ["src/First/packages.lock.json", "src/Second/packages.lock.json"],
			audited: [firstProject],
		},
		{
			id: "packages-lock-json-without-eligible-owner",
			selected: ["packages.lock.json", "src/Second/packages.lock.json"],
			audited: [],
		},
		{
			id: "directory-packages-props-without-eligible-project",
			selected: ["src/Empty/Directory.Packages.props", "src/Second/Directory.Packages.props"],
			audited: [],
		},
	])(
		"honors config excludes through the dependency audit entry point ($id)",
		async ({ selected, audited }) => {
			const context = contextFor(selected);
			context.excludePatterns = ["src/Second/**"];
			context.config.security.acceptedAdvisories = [
				{ id: "GHSA-dddd-eeee-ffff", reason: "reviewed elsewhere" },
			];
			runSubprocess.mockResolvedValue({ stdout: reportFor(firstProject), stderr: "", exitCode: 0 });

			const diagnostics = await runDependencyAudit(context);

			expect(
				diagnostics
					.filter((diagnostic) => diagnostic.rule === "security/vulnerable-dependency")
					.map((diagnostic) => diagnostic.filePath),
			).toEqual(audited);
			expect(
				diagnostics.some((diagnostic) => diagnostic.rule === "security/stale-accepted-advisory"),
			).toBe(audited.length > 0);
			expect(
				runSubprocess.mock.calls.map(([, arguments_]) => arguments_.slice(0, 3)),
			).toEqual(audited.map((project) => ["list", project, "package"]));
		},
	);

	it.each([
		{ name: "empty manifest scope", context: { ...contextFor([]), files: [firstProject] } },
		{ name: "empty file scope", context: { rootDirectory, files: [] } },
		{
			name: "non-C# manifests",
			context: { ...contextFor(["Mixed.sln", "Native.vcxproj"]), files: [firstProject] },
		},
		{ name: "unowned lockfile", context: contextFor(["packages.lock.json"]) },
	])("completes without invoking dotnet for $name", async ({ context }) => {
		await expect(inspectDotnetAudit(context, 1000)).resolves.toEqual({
			completed: false,
			diagnostics: [],
		});
		expect(runSubprocess).not.toHaveBeenCalled();
	});

	it.each(["source-file-scope", "mcp-absent-file-scope"] as const)(
		"uses the source file scope when no manifest scope was supplied (%s)",
		async (mode) => {
			runSubprocess.mockResolvedValue({ stdout: reportFor(firstProject), stderr: "", exitCode: 0 });
			if (mode === "mcp-absent-file-scope") {
				const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(rootDirectory);
				try {
					const result = await handleAislopScan({ path: "." });
					expect(result.score).toBeLessThan(100);
					expect(result.findings).toEqual([
						expect.objectContaining({
							file: firstProject,
							rule: "security/vulnerable-dependency",
						}),
					]);
				} finally {
					cwdSpy.mockRestore();
				}
			} else {
				const outcome = await inspectDotnetAudit({ rootDirectory, files: [firstProject] }, 1000);
				expect(outcome.completed).toBe(true);
				expect(outcome.diagnostics).toEqual([expect.objectContaining({ filePath: firstProject })]);
			}
			expect(runSubprocess).toHaveBeenCalledTimes(1);
			expect(runSubprocess.mock.calls[0][1].slice(0, 3)).toEqual(["list", firstProject, "package"]);
		},
	);

	it("runs at most four projects at once", async () => {
		const projects = Array.from({ length: 5 }, (_, index) => `Project${index}.csproj`);
		const releases: Array<() => void> = [];
		let signalFifthStarted: () => void;
		const fifthStarted = new Promise<void>((resolve) => {
			signalFifthStarted = resolve;
		});
		runSubprocess.mockImplementation(
			(_command, arguments_) =>
				new Promise((resolve) => {
					releases.push(() =>
						resolve({ stdout: reportFor(arguments_[1]), stderr: "", exitCode: 0 }),
					);
					if (releases.length === 5) signalFifthStarted();
				}),
		);

		const pending = inspectDotnetAudit(contextFor(projects), 1000);

		expect(runSubprocess).toHaveBeenCalledTimes(4);
		// Release the first wave and wait for the next project without a real clock.
		for (const release of releases) release();
		await fifthStarted;
		expect(runSubprocess).toHaveBeenCalledTimes(5);
		releases[4]();
		const outcome = await pending;
		expect(outcome.completed).toBe(true);
		expect(outcome.diagnostics.map((diagnostic) => diagnostic.filePath)).toEqual(projects);
	});
});
