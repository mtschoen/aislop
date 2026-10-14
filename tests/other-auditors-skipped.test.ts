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

const { runDependencyAudit } = await import("../src/engines/security/audit.js");
const { inspectCargoAudit, inspectDotnetAudit, inspectPipAudit } = await import(
	"../src/engines/security/audit-ecosystem.js"
);

const SKIPPED_RULE = "security/dependency-audit-skipped";

const respondWith = (stdout: string, exitCode = 0): void => {
	runSubprocess.mockResolvedValue({ stdout, stderr: "", exitCode });
};

const TOOLS = [
	{
		name: "pip-audit",
		inspect: inspectPipAudit,
		manifest: "requirements.txt",
		message: "Dependency audit did not complete (pip-audit)",
		cleanReport: JSON.stringify({
			dependencies: [{ name: "requests", version: "2.0.0", vulns: [] }],
		}),
		notItsReport: JSON.stringify({ unrelated: true }),
	},
	{
		name: "cargo audit",
		inspect: inspectCargoAudit,
		manifest: "Cargo.toml",
		message: "Dependency audit did not complete (cargo audit)",
		cleanReport: JSON.stringify({ vulnerabilities: { found: false, count: 0, list: [] } }),
		notItsReport: JSON.stringify({ unrelated: true }),
	},
	{
		name: "dotnet list package",
		inspect: inspectDotnetAudit,
		manifest: "*.csproj",
		message: "Dependency audit did not complete (dotnet list package)",
		cleanReport: JSON.stringify({ version: 1, projects: [] }),
		notItsReport: JSON.stringify({ unrelated: true }),
	},
];

describe.each(TOOLS)("$name audit that did not run to a report", (tool) => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	it.each([
		["empty output with a zero exit", () => respondWith("")],
		["empty output with a non-zero exit", () => respondWith("", 2)],
		["output that is not JSON", () => respondWith("error: could not load the project")],
		["JSON that is not the tool's report", () => respondWith(tool.notItsReport)],
		[
			"a valid report with an exit status the tool never uses",
			() => respondWith(tool.cleanReport, 2),
		],
		[
			"a run that could not be started or timed out",
			() => runSubprocess.mockRejectedValue(new Error("spawn ETIMEDOUT")),
		],
	])("warns and is not completed for %s", async (_name, arrange) => {
		arrange();

		const outcome = await tool.inspect("/repo", 1000);

		expect(outcome.completed).toBe(false);
		expect(outcome.diagnostics).toHaveLength(1);
		expect(outcome.diagnostics[0]).toMatchObject({
			rule: SKIPPED_RULE,
			severity: "warning",
			filePath: tool.manifest,
			message: tool.message,
		});
		expect(outcome.diagnostics[0].help).toContain(tool.name);
	});

	it("reports a clean audit only when the tool printed its own clean report", async () => {
		respondWith(tool.cleanReport);

		await expect(tool.inspect("/repo", 1000)).resolves.toEqual({
			diagnostics: [],
			completed: true,
		});
	});
});

describe("findings are kept next to the warning", () => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	it("keeps pip-audit findings when the exit status is not one the tool uses", async () => {
		respondWith(
			JSON.stringify({ dependencies: [{ name: "requests", vulns: [{ id: "PYSEC-1" }] }] }),
			2,
		);

		const outcome = await inspectPipAudit("/repo", 1000);

		expect(outcome.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
			SKIPPED_RULE,
			"security/vulnerable-dependency",
		]);
		expect(outcome.completed).toBe(false);
	});
});

describe("incomplete nested ecosystem reports", () => {
	beforeEach(() => runSubprocess.mockReset());

	const pipFinding = { name: "requests", version: "2.0.0", vulns: [{ id: "PYSEC-1" }] };
	const cargoFinding = {
		advisory: { id: "RUSTSEC-1" },
		package: { name: "a-crate", version: "1.0.0" },
	};
	const dotnetFinding = {
		path: "/repo/App.csproj",
		frameworks: [
			{
				framework: "net8.0",
				topLevelPackages: [
					{
						id: "Example",
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
	};
	const missingData = {
		project: "/repo/App.csproj",
		level: "warning",
		text: "The configured audit source 'private' did not provide any vulnerability data.",
	};

	it.each([
		[
			"R4 pip missing audited version",
			inspectPipAudit,
			{ dependencies: [{ name: "requests", vulns: [] }], fixes: [] },
			0,
			0,
		],
		[
			"R4 pip missing version beside readable finding",
			inspectPipAudit,
			{
				dependencies: [
					{ name: "requests", vulns: [] },
					{ name: "requests", version: "2.0.0", vulns: [{ id: "PYSEC-1" }] },
				],
			},
			1,
			1,
		],
		[
			"R4 Cargo missing package",
			inspectCargoAudit,
			{
				vulnerabilities: {
					found: true,
					count: 1,
					list: [{ advisory: { id: "RUSTSEC-1" }, package: null }],
				},
			},
			0,
			1,
		],
		[
			"R4 Cargo missing package name",
			inspectCargoAudit,
			{
				vulnerabilities: {
					found: true,
					count: 1,
					list: [{ advisory: { id: "RUSTSEC-1" }, package: { version: "1.0.0" } }],
				},
			},
			0,
			1,
		],
		[
			"R4 Cargo missing package version",
			inspectCargoAudit,
			{
				vulnerabilities: {
					found: true,
					count: 1,
					list: [{ advisory: { id: "RUSTSEC-1" }, package: { name: "a-crate" } }],
				},
			},
			0,
			1,
		],
		[
			"pip skipped dependency",
			inspectPipAudit,
			{
				dependencies: [
					{
						name: "private-package",
						skip_reason: "Dependency not found on PyPI and could not be audited",
					},
				],
				fixes: [],
			},
			0,
			0,
		],
		[
			"pip skipped beside finding",
			inspectPipAudit,
			{ dependencies: [pipFinding, { name: "private-package", skip_reason: "not on PyPI" }] },
			1,
			1,
		],
		["pip null dependency", inspectPipAudit, { dependencies: [null] }, 0, 0],
		["pip null beside finding", inspectPipAudit, { dependencies: [pipFinding, null] }, 1, 1],
		[
			"pip malformed vulnerability",
			inspectPipAudit,
			{ dependencies: [{ name: "requests", vulns: [null] }] },
			0,
			0,
		],
		["cargo missing list", inspectCargoAudit, { vulnerabilities: {} }, 0, 0],
		[
			"cargo null vulnerability",
			inspectCargoAudit,
			{ vulnerabilities: { found: true, count: 1, list: [null] } },
			0,
			0,
		],
		[
			"cargo null beside finding",
			inspectCargoAudit,
			{ vulnerabilities: { found: true, count: 2, list: [cargoFinding, null] } },
			1,
			1,
		],
		[
			"cargo contradictory count",
			inspectCargoAudit,
			{ vulnerabilities: { found: false, count: 1, list: [] } },
			0,
			0,
		],
		[
			"dotnet missing vulnerability data",
			inspectDotnetAudit,
			{
				version: 1,
				problems: [missingData],
				projects: [
					{ path: "/repo/App.csproj", frameworks: [{ framework: "net8.0", topLevelPackages: [] }] },
				],
			},
			0,
			0,
		],
		[
			"dotnet warning beside finding",
			inspectDotnetAudit,
			{ projects: [dotnetFinding], problems: [missingData] },
			0,
			1,
		],
		["dotnet null project", inspectDotnetAudit, { projects: [null] }, 0, 0],
		["dotnet null beside finding", inspectDotnetAudit, { projects: [dotnetFinding, null] }, 0, 1],
		[
			"dotnet null framework",
			inspectDotnetAudit,
			{ projects: [{ path: "/repo/App.csproj", frameworks: [null] }] },
			0,
			0,
		],
		[
			"dotnet malformed packages",
			inspectDotnetAudit,
			{
				projects: [
					{
						path: "/repo/App.csproj",
						frameworks: [{ framework: "net8.0", topLevelPackages: [null] }],
					},
				],
			},
			0,
			0,
		],
	] as const)(
		"warns without losing findings for %s",
		async (_name, inspect, report, exitCode, findingCount) => {
			respondWith(JSON.stringify(report), exitCode);
			const outcome = await inspect("/repo", 1000);
			expect(outcome.completed).toBe(false);
			expect(
				outcome.diagnostics.filter((diagnostic) => diagnostic.rule === SKIPPED_RULE),
			).toHaveLength(1);
			expect(
				outcome.diagnostics.filter(
					(diagnostic) => diagnostic.rule === "security/vulnerable-dependency",
				),
			).toHaveLength(findingCount);
		},
	);

	it("treats Cargo policy denial as completed rather than skipped", async () => {
		respondWith(
			JSON.stringify({
				vulnerabilities: { found: false, count: 0, list: [] },
				warnings: {
					yanked: [
						{
							kind: "yanked",
							package: { name: "a-crate", version: "1.0.0" },
							advisory: null,
							affected: null,
							versions: null,
						},
					],
				},
			}),
			1,
		);
		const outcome = await inspectCargoAudit("/repo", 1000);
		expect(outcome.completed).toBe(true);
		expect(outcome.diagnostics).toEqual([
			expect.objectContaining({
				rule: "security/dependency-audit-policy",
				severity: "error",
			}),
		]);
		expect(outcome.diagnostics[0].message).toContain("a-crate");
	});

	it("does not infer Cargo policy denial from a malformed vulnerability report", async () => {
		respondWith(
			JSON.stringify({
				vulnerabilities: {},
				warnings: {
					yanked: [
						{
							kind: "yanked",
							package: { name: "a-crate", version: "1.0.0" },
						},
					],
				},
			}),
			1,
		);
		const outcome = await inspectCargoAudit("/repo", 1000);
		expect(outcome.completed).toBe(false);
		expect(outcome.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([SKIPPED_RULE]);
	});

	it("accepts NuGet's omitted empty framework and package collections", async () => {
		respondWith(
			JSON.stringify({
				projects: [
					{ path: "/repo/Empty.csproj" },
					{ path: "/repo/App.csproj", frameworks: [{ framework: "net8.0" }] },
				],
			}),
		);
		await expect(inspectDotnetAudit("/repo", 1000)).resolves.toEqual({
			completed: true,
			diagnostics: [],
		});
	});
});

describe("runDependencyAudit: an audit tool that does not apply is not a failed audit", () => {
	let dir: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-other-auditors-"));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const contextFor = (
		languages: EngineContext["languages"],
		installedTools: EngineContext["installedTools"],
	): EngineContext => ({
		rootDirectory: dir,
		languages,
		frameworks: [],
		installedTools,
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

	it.each([
		["Rust without cargo-audit installed", "rust" as const, {}],
		["Python without pip-audit installed", "python" as const, {}],
		["C# without dotnet installed", "csharp" as const, {}],
	])("runs nothing and reports nothing for %s", async (_name, language, installedTools) => {
		fs.writeFileSync(path.join(dir, "requirements.txt"), "requests\n");

		await expect(runDependencyAudit(contextFor([language], installedTools))).resolves.toEqual([]);
		expect(runSubprocess).not.toHaveBeenCalled();
	});

	it("reports the skipped warning for Rust when cargo-audit is installed but printed nothing", async () => {
		respondWith("");

		const diagnostics = await runDependencyAudit(contextFor(["rust"], { "cargo-audit": true }));

		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([SKIPPED_RULE]);
	});

	it("runs C# evaluation when dotnet is installed", async () => {
		respondWith("");
		const diagnostics = await runDependencyAudit(contextFor(["csharp"], { dotnet: true }));
		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([SKIPPED_RULE]);
		expect(runSubprocess).toHaveBeenCalledWith("dotnet", expect.any(Array), expect.any(Object));
	});

	it.each([
		["python", { dependencies: [{ name: "private", skip_reason: "not found" }] }],
		["rust", { vulnerabilities: { found: true, count: 1, list: [null] } }],
		["csharp", { projects: [null] }],
	] as const)(
		"does not mark acceptances stale for incomplete %s reports",
		async (language, report) => {
			fs.writeFileSync(path.join(dir, "requirements.txt"), "requests\n");
			respondWith(JSON.stringify(report));
			const context = contextFor([language], {
				"pip-audit": true,
				"cargo-audit": true,
				dotnet: true,
			});
			context.config.security.acceptedAdvisories = [
				{ id: "GHSA-aaaa-bbbb-cccc", reason: "reviewed" },
			];
			const diagnostics = await runDependencyAudit(context);
			expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([SKIPPED_RULE]);
		},
	);
});
