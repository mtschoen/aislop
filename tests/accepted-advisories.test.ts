import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic, EngineContext } from "../src/engines/types.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));

vi.mock("../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/subprocess.js")>();
	return { ...actual, runSubprocess };
});

const { writeBaseline } = await import("../src/baseline/baseline-file.js");
const { applyScanBaseline } = await import("../src/commands/scan-baseline.js");
const { computeScanExitCode } = await import("../src/commands/scan-exit-code.js");
const { parseConfig } = await import("../src/config/schema.js");
const { applyAcceptedAdvisories } = await import("../src/engines/security/accepted-advisories.js");
const { parseBunAudit, parseDotnetAudit, parseJsAudit, runDependencyAudit } = await import(
	"../src/engines/security/audit.js"
);
const { runCargoAudit, runPipAudit } = await import("../src/engines/security/audit-ecosystem.js");
const { advisoryIdFromUrl, toDependencyAdvisory, mergeAdvisories } = await import(
	"../src/engines/security/audit-shared.js"
);
const { calculateScore } = await import("../src/scoring/index.js");

const ADVISORY_ONE = "GHSA-aaaa-bbbb-cccc";
const ADVISORY_TWO = "GHSA-dddd-eeee-ffff";
const advisoryUrl = (id: string): string => `https://github.com/advisories/${id}`;

// Shape captured from `npm audit --json` (npm 12): the advisory lives in a `via`
// object whose only identifier is the GitHub advisory URL.
const npmAudit = (advisoryIds: string[]): string =>
	JSON.stringify({
		auditReportVersion: 2,
		vulnerabilities: {
			braces: {
				name: "braces",
				severity: "high",
				isDirect: false,
				via: advisoryIds.map((id, index) => ({
					source: 1000 + index,
					name: "braces",
					title: "stack exhaustion",
					url: advisoryUrl(id),
					severity: "high",
					range: "<=3.0.3",
				})),
				effects: ["micromatch"],
				fixAvailable: { name: "stylelint", version: "7.7.0", isSemVerMajor: true },
			},
			micromatch: {
				name: "micromatch",
				severity: "high",
				isDirect: false,
				via: ["braces"],
				effects: [],
				fixAvailable: false,
			},
		},
	});

const vulnerableDependency = (overrides: Partial<Diagnostic> = {}): Diagnostic => ({
	filePath: "package.json",
	engine: "security",
	rule: "security/vulnerable-dependency",
	severity: "error",
	message: "braces (high) - upgrade to stylelint@7.7.0",
	help: "",
	line: 0,
	column: 0,
	category: "Security",
	fixable: false,
	detail: "npm",
	packageName: "braces",
	advisories: [{ id: ADVISORY_ONE }],
	...overrides,
});

const TODAY = "2026-10-13";
const completedAudit = { today: TODAY, auditCompleted: true };
const scoreOf = (diagnostics: Diagnostic[]): number =>
	calculateScore(diagnostics, { security: 2 }, { good: 75, ok: 50 }, 20).score;

describe("advisory identifiers are carried from the audit data to the diagnostic", () => {
	it("npm audit: reads the advisory id of every via object from its url", () => {
		const [diagnostic] = parseJsAudit(npmAudit([ADVISORY_ONE, ADVISORY_TWO]), "npm audit");

		expect(diagnostic.packageName).toBe("braces");
		expect(diagnostic.advisories).toEqual([{ id: ADVISORY_ONE }, { id: ADVISORY_TWO }]);
	});

	it("npm audit: an advisory with no identifier is carried as unidentified", () => {
		const audit = JSON.stringify({
			vulnerabilities: {
				uuid: { name: "uuid", severity: "high", via: [{ source: 1, name: "uuid" }] },
			},
		});

		const [diagnostic] = parseJsAudit(audit, "npm audit");

		expect(diagnostic.advisories).toEqual([{ id: "unidentified" }]);
	});

	it("pnpm audit: reads github_advisory_id and any cves of each advisory", () => {
		// Shape captured from `pnpm audit --json` (pnpm 11), plus the `cves` list older
		// pnpm releases emit.
		const audit = JSON.stringify({
			advisories: {
				"1106913": {
					id: 1106913,
					module_name: "lodash",
					severity: "high",
					github_advisory_id: ADVISORY_ONE,
					url: advisoryUrl(ADVISORY_ONE),
					cves: ["CVE-2021-0001"],
				},
				"1108258": {
					id: 1108258,
					module_name: "lodash",
					severity: "moderate",
					url: advisoryUrl(ADVISORY_TWO),
				},
			},
		});

		const [diagnostic] = parseJsAudit(audit, "pnpm audit");

		expect(diagnostic.packageName).toBe("lodash");
		expect(diagnostic.advisories).toEqual([
			{ id: ADVISORY_ONE, aliases: ["CVE-2021-0001"] },
			{ id: ADVISORY_TWO },
		]);
	});

	it("bun audit: reads the advisory id from each advisory url", () => {
		// Shape captured from `bun audit --json` (bun 1.3).
		const audit = JSON.stringify({
			braces: [{ id: 1240992, url: advisoryUrl(ADVISORY_ONE), severity: "high", title: "t" }],
		});

		const [diagnostic] = parseBunAudit(audit);

		expect(diagnostic.packageName).toBe("braces");
		expect(diagnostic.advisories).toEqual([{ id: ADVISORY_ONE }]);
	});

	it("dotnet audit: reads the advisory id from each advisoryurl", () => {
		const root = path.resolve("repo");
		const audit = JSON.stringify({
			projects: [
				{
					path: path.join(root, "App.csproj"),
					frameworks: [
						{
							topLevelPackages: [
								{
									id: "Newtonsoft.Json",
									resolvedVersion: "9.0.1",
									vulnerabilities: [{ severity: "High", advisoryurl: advisoryUrl(ADVISORY_ONE) }],
								},
							],
						},
					],
				},
			],
		});

		const [diagnostic] = parseDotnetAudit(audit, root);

		expect(diagnostic.packageName).toBe("Newtonsoft.Json");
		expect(diagnostic.advisories).toEqual([{ id: ADVISORY_ONE }]);
	});

	describe("subprocess-backed sources", () => {
		beforeEach(() => {
			runSubprocess.mockReset();
		});

		const respondWith = (stdout: string): void => {
			runSubprocess.mockResolvedValue({ stdout, stderr: "", exitCode: 1 });
		};

		it("pip-audit: reads each vulnerability id with its aliases", async () => {
			respondWith(
				JSON.stringify({
					dependencies: [
						{
							name: "jinja2",
							version: "2.0",
							vulns: [{ id: "PYSEC-2021-66", aliases: ["CVE-2020-28493", ADVISORY_ONE] }],
						},
					],
				}),
			);

			const [diagnostic] = await runPipAudit("repo", 1000);

			expect(diagnostic.packageName).toBe("jinja2");
			expect(diagnostic.advisories).toEqual([
				{ id: "PYSEC-2021-66", aliases: ["CVE-2020-28493", ADVISORY_ONE] },
			]);
		});

		it("cargo audit: reads the advisory id with its aliases", async () => {
			respondWith(
				JSON.stringify({
					vulnerabilities: {
						list: [
							{
								advisory: { id: "RUSTSEC-2020-0071", aliases: ["CVE-2020-26235"], title: "t" },
								package: { name: "time" },
							},
						],
					},
				}),
			);

			const [diagnostic] = await runCargoAudit("repo", 1000);

			expect(diagnostic.packageName).toBe("time");
			expect(diagnostic.advisories).toEqual([
				{ id: "RUSTSEC-2020-0071", aliases: ["CVE-2020-26235"] },
			]);
		});
	});
});

describe("applyAcceptedAdvisories", () => {
	it("names the advisories of an unaccepted finding without changing its cost", () => {
		const finding = vulnerableDependency();

		const [result] = applyAcceptedAdvisories([finding], [], completedAudit);

		expect(result.rule).toBe("security/vulnerable-dependency");
		expect(result.severity).toBe("error");
		expect(result.help).toContain(ADVISORY_ONE);
		expect(scoreOf([result])).toBe(scoreOf([finding]));
	});

	it("shows a fully accepted finding as accepted with its reason, at no score cost", () => {
		const entries = [{ id: ADVISORY_ONE, reason: "dev-only, no untrusted input" }];

		const results = applyAcceptedAdvisories([vulnerableDependency()], entries, completedAudit);

		expect(results).toHaveLength(1);
		expect(results[0].rule).toBe("security/accepted-advisory");
		expect(results[0].severity).toBe("info");
		expect(results[0].message).toContain("braces");
		expect(results[0].help).toContain(ADVISORY_ONE);
		expect(results[0].help).toContain("dev-only, no untrusted input");
		expect(scoreOf(results)).toBe(100);
	});

	it("keeps a partially accepted finding failing and names the unaccepted advisory", () => {
		const finding = vulnerableDependency({
			advisories: [{ id: ADVISORY_ONE }, { id: ADVISORY_TWO }],
		});
		const entries = [{ id: ADVISORY_ONE, reason: "reviewed" }];

		const results = applyAcceptedAdvisories([finding], entries, completedAudit);

		expect(results).toHaveLength(1);
		expect(results[0].rule).toBe("security/vulnerable-dependency");
		expect(results[0].severity).toBe("error");
		expect(results[0].help).toContain(`Not accepted: ${ADVISORY_TWO}`);
		expect(scoreOf(results)).toBe(scoreOf([finding]));
	});

	it("matches an entry against an advisory alias, ignoring case", () => {
		const finding = vulnerableDependency({
			advisories: [{ id: "PYSEC-2021-66", aliases: ["CVE-2020-28493"] }],
		});
		const entries = [{ id: "cve-2020-28493", reason: "reviewed" }];

		const [result] = applyAcceptedAdvisories([finding], entries, completedAudit);

		expect(result.rule).toBe("security/accepted-advisory");
	});

	it("never accepts an advisory the audit source could not identify", () => {
		const finding = vulnerableDependency({ advisories: [{ id: "unidentified" }] });
		const entries = [{ id: "unidentified", reason: "reviewed" }];

		const [result] = applyAcceptedAdvisories([finding], entries, completedAudit);

		expect(result.rule).toBe("security/vulnerable-dependency");
	});

	it("leaves a finding that carries no advisory identifiers untouched", () => {
		const finding = vulnerableDependency({ advisories: undefined });
		const entries = [{ id: ADVISORY_ONE, reason: "reviewed" }];

		const results = applyAcceptedAdvisories([finding], entries, {
			today: TODAY,
			auditCompleted: false,
		});

		expect(results).toEqual([finding]);
	});

	it("does not treat a finding with an empty advisory list as fully accepted", () => {
		const finding = vulnerableDependency({ advisories: [] });
		const entries = [{ id: ADVISORY_ONE, reason: "reviewed" }];

		const [result] = applyAcceptedAdvisories([finding], entries, completedAudit);

		expect(result.rule).toBe("security/vulnerable-dependency");
		expect(result.severity).toBe("error");
	});

	it("does not apply an entry scoped to a different package", () => {
		const entries = [{ id: ADVISORY_ONE, reason: "reviewed", package: "micromatch" }];

		const results = applyAcceptedAdvisories([vulnerableDependency()], entries, completedAudit);

		expect(results[0].rule).toBe("security/vulnerable-dependency");
		expect(results.map((result) => result.rule)).toContain("security/stale-accepted-advisory");
	});

	it.each([
		{ expires: "2026-10-13", today: "2026-10-13", rule: "security/accepted-advisory" },
		{ expires: "2026-10-13", today: "2026-10-14", rule: "security/vulnerable-dependency" },
	])(
		"applies an entry through its expiry date ($expires on $today)",
		({ expires, today, rule }) => {
			const entries = [{ id: ADVISORY_ONE, reason: "reviewed", expires }];

			const [result] = applyAcceptedAdvisories([vulnerableDependency()], entries, {
				today,
				auditCompleted: true,
			});

			expect(result.rule).toBe(rule);
		},
	);

	it("says that an expired acceptance is why the finding fails again", () => {
		const entries = [{ id: ADVISORY_ONE, reason: "reviewed", expires: "2026-01-31" }];

		const results = applyAcceptedAdvisories([vulnerableDependency()], entries, completedAudit);

		expect(results).toHaveLength(1);
		expect(results[0].help).toContain(`acceptance of ${ADVISORY_ONE} expired on 2026-01-31`);
	});

	it("reports an entry that matches nothing in the audit as stale, at no score cost", () => {
		const entries = [{ id: ADVISORY_TWO, reason: "reviewed" }];

		const results = applyAcceptedAdvisories([], entries, completedAudit);

		expect(results).toHaveLength(1);
		expect(results[0].rule).toBe("security/stale-accepted-advisory");
		expect(results[0].severity).toBe("info");
		expect(results[0].message).toContain(ADVISORY_TWO);
		expect(scoreOf(results)).toBe(100);
	});

	it("does not call an entry stale when the audit did not complete", () => {
		const entries = [{ id: ADVISORY_TWO, reason: "reviewed" }];

		const results = applyAcceptedAdvisories([], entries, { today: TODAY, auditCompleted: false });

		expect(results).toEqual([]);
	});
});

describe("security.acceptedAdvisories configuration", () => {
	let stderr: string;

	beforeEach(() => {
		stderr = "";
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderr += String(chunk);
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts an entry with an id and a reason", () => {
		const config = parseConfig({
			security: {
				acceptedAdvisories: [
					{ id: ADVISORY_ONE, reason: "reviewed", package: "braces", expires: "2027-01-31" },
				],
			},
		});

		expect(config.security.acceptedAdvisories).toEqual([
			{ id: ADVISORY_ONE, reason: "reviewed", package: "braces", expires: "2027-01-31" },
		]);
		expect(stderr).toBe("");
	});

	it.each([
		["a missing reason", { id: ADVISORY_ONE }],
		["a blank reason", { id: ADVISORY_ONE, reason: "   " }],
		["a missing id", { reason: "reviewed" }],
		["a non-string reason", { id: ADVISORY_ONE, reason: 7 }],
		["an impossible expiry date", { id: ADVISORY_ONE, reason: "reviewed", expires: "2027-02-30" }],
		["a bare string", ADVISORY_ONE],
		["a non-string expiry", { id: ADVISORY_ONE, reason: "reviewed", expires: 20200101 }],
		["a non-string package", { id: ADVISORY_ONE, reason: "reviewed", package: 7 }],
		["an empty package", { id: ADVISORY_ONE, reason: "reviewed", package: "" }],
		["a null package", { id: ADVISORY_ONE, reason: "reviewed", package: null }],
		["a misspelled field", { id: ADVISORY_ONE, reason: "reviewed", packge: "braces" }],
	])("rejects an entry with %s, keeping the rest of the configuration", (_label, entry) => {
		const config = parseConfig({
			ci: { failBelow: 100 },
			security: {
				auditTimeout: 9000,
				acceptedAdvisories: [entry, { id: ADVISORY_TWO, reason: "reviewed" }],
			},
		});

		expect(config.security.acceptedAdvisories).toEqual([{ id: ADVISORY_TWO, reason: "reviewed" }]);
		expect(config.security.auditTimeout).toBe(9000);
		expect(config.ci.failBelow).toBe(100);
		expect(stderr).toContain("security.acceptedAdvisories.0");
	});

	it("removes an entry with two problems once, keeping its valid neighbor", () => {
		const config = parseConfig({
			security: {
				acceptedAdvisories: [
					{ id: "bad", reason: "", expires: "not-a-date" },
					{ id: "valid", reason: "reviewed" },
				],
			},
		});

		expect(config.security.acceptedAdvisories).toEqual([{ id: "valid", reason: "reviewed" }]);
		expect(stderr.match(/security\.acceptedAdvisories\.\d/g)).toEqual([
			"security.acceptedAdvisories.0",
		]);
	});
});

describe("runDependencyAudit applies security.acceptedAdvisories", () => {
	let directory: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		runSubprocess.mockResolvedValue({ stdout: npmAudit([ADVISORY_ONE]), stderr: "", exitCode: 1 });
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-accepted-advisories-"));
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "package-lock.json"), "{}\n");
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const contextWith = (
		acceptedAdvisories: EngineContext["config"]["security"]["acceptedAdvisories"],
	): EngineContext => ({
		rootDirectory: directory,
		languages: ["javascript"],
		frameworks: [],
		installedTools: {},
		config: {
			quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
			security: { audit: true, auditTimeout: 1000, acceptedAdvisories },
			lint: { typecheck: false, expoDoctor: false },
		},
	});

	it("turns the accepted package finding into an accepted, score-neutral one", async () => {
		const diagnostics = await runDependencyAudit(
			contextWith([{ id: ADVISORY_ONE, reason: "dev-only" }]),
		);

		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
			"security/accepted-advisory",
		]);
		expect(scoreOf(diagnostics)).toBe(100);
	});

	it("reports an unmatched entry as stale next to the still-failing finding", async () => {
		const diagnostics = await runDependencyAudit(
			contextWith([{ id: ADVISORY_TWO, reason: "dev-only" }]),
		);

		expect(diagnostics.map((diagnostic) => diagnostic.rule).sort()).toEqual([
			"security/stale-accepted-advisory",
			"security/vulnerable-dependency",
		]);
	});

	it("does not call an entry stale when the audit could not run", async () => {
		runSubprocess.mockResolvedValue({ stdout: "", stderr: "offline", exitCode: 1 });

		const diagnostics = await runDependencyAudit(
			contextWith([{ id: ADVISORY_TWO, reason: "dev-only" }]),
		);

		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
			"security/dependency-audit-skipped",
		]);
	});
});

describe("stale entries are only reported for audit sources that completed", () => {
	let directory: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-accepted-advisories-"));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const contextFor = (language: EngineContext["languages"][number]): EngineContext => ({
		rootDirectory: directory,
		languages: [language],
		frameworks: [],
		installedTools: { "pip-audit": true, govulncheck: true, dotnet: true },
		config: {
			quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
			security: {
				audit: true,
				auditTimeout: 1000,
				acceptedAdvisories: [{ id: ADVISORY_TWO, reason: "reviewed" }],
			},
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

	const failures = {
		"exits with an error and no output": () =>
			runSubprocess.mockResolvedValue({ stdout: "", stderr: "offline", exitCode: 2 }),
		"cannot be started": () => runSubprocess.mockRejectedValue(new Error("spawn ENOENT")),
		"prints output that is not its report": () =>
			runSubprocess.mockResolvedValue({ stdout: "error: no network", stderr: "", exitCode: 2 }),
	};
	const sources = [
		{ language: "rust", cleanReport: JSON.stringify({ vulnerabilities: { list: [] } }) },
		{ language: "csharp", cleanReport: JSON.stringify({ version: 1, projects: [] }) },
		{ language: "python", cleanReport: JSON.stringify({ dependencies: [] }) },
	] as const;

	describe.each(sources)("$language audit", ({ language, cleanReport }) => {
		beforeEach(() => {
			if (language === "python") fs.writeFileSync(path.join(directory, "requirements.txt"), "");
		});

		it.each(Object.keys(failures) as Array<keyof typeof failures>)(
			"reports nothing as stale when the audit %s",
			async (failure) => {
				failures[failure]();

				const diagnostics = await runDependencyAudit(contextFor(language));

				expect(diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
					"security/stale-accepted-advisory",
				);
			},
		);

		it("reports the unmatched entry as stale when the audit completed cleanly", async () => {
			runSubprocess.mockResolvedValue({ stdout: cleanReport, stderr: "", exitCode: 0 });

			const diagnostics = await runDependencyAudit(contextFor(language));

			expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
				"security/stale-accepted-advisory",
			]);
		});
	});

	it("reports nothing as stale when bun audit prints output that is not its report", async () => {
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "bun.lock"), "");
		runSubprocess.mockResolvedValue({ stdout: "error: no network", stderr: "", exitCode: 1 });

		const diagnostics = await runDependencyAudit(contextFor("javascript"));

		expect(diagnostics.map((diagnostic) => diagnostic.rule)).not.toContain(
			"security/stale-accepted-advisory",
		);
	});
});

describe("advisory ids are read only from a complete path segment of an advisory url", () => {
	it.each([
		["https://github.com/advisories/GHSA-aaaa-bbbb-cccc", "GHSA-aaaa-bbbb-cccc"],
		["https://github.com/advisories/GHSA-aaaa-bbbb-cccc/", "GHSA-aaaa-bbbb-cccc"],
		["https://github.com/advisories/GHSA-aaaa-bbbb-cccc?ref=x#top", "GHSA-aaaa-bbbb-cccc"],
	])("reads the id from %s", (url, id) => {
		expect(advisoryIdFromUrl(url)).toBe(id);
	});

	it.each([
		["a query string", "https://example.com/page?next=/advisories/GHSA-aaaa-bbbb-cccc"],
		["a fragment", "https://example.com/page#/advisories/GHSA-aaaa-bbbb-cccc"],
		["a longer path segment", "https://github.com/advisories/GHSA-aaaa-bbbb-cccc-extra"],
		["a prefixed path segment", "https://github.com/notadvisories/GHSA-aaaa-bbbb-cccc"],
		["a deeper path", "https://github.com/advisories/GHSA-aaaa-bbbb-cccc/more/segments"],
		["a value that is not a url", "see /advisories/GHSA-aaaa-bbbb-cccc"],
	])("reads no id when it only appears in %s", (_label, url) => {
		expect(advisoryIdFromUrl(url)).toBeUndefined();
	});

	it("an advisory url that merely mentions an accepted id is never accepted", () => {
		const audit = JSON.stringify({
			braces: [
				{ url: "https://evil.example/x?u=/advisories/GHSA-aaaa-bbbb-cccc", severity: "high" },
			],
		});
		const [diagnostic] = parseBunAudit(audit);
		expect(diagnostic.advisories).toEqual([{ id: "unidentified" }]);
	});
});

describe("advisories that share a primary id union their aliases", () => {
	it("keeps the aliases of both reports", () => {
		const first = toDependencyAdvisory([ADVISORY_ONE], ["CVE-2020-0001"]);
		const second = toDependencyAdvisory([ADVISORY_ONE], ["CVE-2020-0002", "CVE-2020-0001"]);

		expect(mergeAdvisories([first], [second])).toEqual([
			{ id: ADVISORY_ONE, aliases: ["CVE-2020-0001", "CVE-2020-0002"] },
		]);
	});
});

describe("a failed audit run never counts as completed", () => {
	let directory: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-accepted-advisories-"));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const contextFor = (
		languages: EngineContext["languages"],
		installedTools: EngineContext["installedTools"] = {
			"pip-audit": true,
			govulncheck: true,
			dotnet: true,
		},
	): EngineContext => ({
		rootDirectory: directory,
		languages,
		frameworks: [],
		installedTools,
		config: {
			quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
			security: {
				audit: true,
				auditTimeout: 1000,
				acceptedAdvisories: [{ id: ADVISORY_TWO, reason: "reviewed" }],
			},
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

	const staleRuleOf = (diagnostics: Diagnostic[]): boolean =>
		diagnostics.some((diagnostic) => diagnostic.rule === "security/stale-accepted-advisory");

	it.each([
		["cargo audit", "rust", { vulnerabilities: { list: [] } }, 2],
		["pip-audit", "python", { dependencies: [] }, 2],
		["pip-audit that exits 1 without reporting a vulnerability", "python", { dependencies: [] }, 1],
		[
			"cargo audit that exits 1 without reporting a vulnerability",
			"rust",
			{ vulnerabilities: { list: [] } },
			1,
		],
		["dotnet that prints non-report json", "csharp", { error: "no project" }, 0],
		["dotnet that exits non-zero", "csharp", { version: 1, projects: [] }, 1],
	] as const)(
		"%s: structured failure output is not completed",
		async (_name, language, payload, exitCode) => {
			if (language === "python") fs.writeFileSync(path.join(directory, "requirements.txt"), "");
			runSubprocess.mockResolvedValue({ stdout: JSON.stringify(payload), stderr: "", exitCode });

			expect(staleRuleOf(await runDependencyAudit(contextFor([language])))).toBe(false);
		},
	);

	it.each([
		["bun reporting an error object", { error: "offline" }, 2],
		["bun reporting an error object with exit 1", { error: "offline" }, 1],
		["bun with a clean report but a failing exit", {}, 2],
	] as const)("%s is not completed", async (_name, payload, exitCode) => {
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "bun.lock"), "");
		runSubprocess.mockResolvedValue({ stdout: JSON.stringify(payload), stderr: "", exitCode });

		expect(staleRuleOf(await runDependencyAudit(contextFor(["javascript"])))).toBe(false);
	});

	it.each([
		[
			"cargo audit",
			"rust",
			{
				vulnerabilities: {
					list: [{ advisory: { id: "RUSTSEC-2020-0001" }, package: { name: "time" } }],
				},
			},
		],
		["pip-audit", "python", { dependencies: [{ name: "jinja2", vulns: [{ id: "PYSEC-1" }] }] }],
	] as const)(
		"%s: exit 1 with vulnerabilities found still counts as completed",
		async (_name, language, payload) => {
			if (language === "python") fs.writeFileSync(path.join(directory, "requirements.txt"), "");
			runSubprocess.mockResolvedValue({ stdout: JSON.stringify(payload), stderr: "", exitCode: 1 });

			expect(staleRuleOf(await runDependencyAudit(contextFor([language])))).toBe(true);
		},
	);

	it("bun: exit 1 with vulnerabilities found still counts as completed", async () => {
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "bun.lock"), "");
		const report = { braces: [{ url: advisoryUrl(ADVISORY_ONE), severity: "high", title: "t" }] };
		runSubprocess.mockResolvedValue({ stdout: JSON.stringify(report), stderr: "", exitCode: 1 });

		expect(staleRuleOf(await runDependencyAudit(contextFor(["javascript"])))).toBe(true);
	});

	it("reports nothing as stale when a relevant ecosystem was never audited", async () => {
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "package-lock.json"), "{}\n");
		runSubprocess.mockResolvedValue({ stdout: npmAudit([ADVISORY_ONE]), stderr: "", exitCode: 1 });

		const diagnostics = await runDependencyAudit(contextFor(["javascript", "python"], {}));

		expect(staleRuleOf(diagnostics)).toBe(false);
	});

	it("reports nothing as stale in a project that includes Go when govulncheck never produced a report", async () => {
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "package-lock.json"), "{}\n");
		runSubprocess.mockImplementation(async (command: string) =>
			command === "govulncheck"
				? { stdout: `${JSON.stringify({ progress: {} })}\n`, stderr: "", exitCode: 0 }
				: { stdout: npmAudit([ADVISORY_ONE]), stderr: "", exitCode: 1 },
		);

		expect(staleRuleOf(await runDependencyAudit(contextFor(["javascript", "go"])))).toBe(false);
	});

	it("reports the entry as stale when every relevant ecosystem was audited and completed", async () => {
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		fs.writeFileSync(path.join(directory, "package-lock.json"), "{}\n");
		fs.writeFileSync(path.join(directory, "requirements.txt"), "");
		runSubprocess.mockImplementation(async (command: string) =>
			command === "pip-audit"
				? { stdout: JSON.stringify({ dependencies: [] }), stderr: "", exitCode: 0 }
				: { stdout: npmAudit([ADVISORY_ONE]), stderr: "", exitCode: 1 },
		);

		expect(staleRuleOf(await runDependencyAudit(contextFor(["javascript", "python"])))).toBe(true);
	});
});

describe("accepted and stale advisory findings under ci.baseline", () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-accepted-advisories-"));
		fs.writeFileSync(path.join(directory, "package.json"), '{"name":"sample"}\n');
		writeBaseline(path.join(directory, "baseline.json"), { version: 1, entries: [] });
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const acceptanceFindings = (): Diagnostic[] =>
		applyAcceptedAdvisories(
			[vulnerableDependency()],
			[
				{ id: ADVISORY_ONE, reason: "reviewed" },
				{ id: ADVISORY_TWO, reason: "reviewed" },
			],
			completedAudit,
		);

	const applyEmptyBaseline = (diagnostics: Diagnostic[]) =>
		applyScanBaseline({
			baselinePath: "baseline.json",
			rootDirectory: directory,
			results: [{ engine: "security", diagnostics, elapsed: 0, skipped: false }],
			scopeFiles: null,
		});

	it("do not count as new findings and leave the exit code at zero", () => {
		const findings = acceptanceFindings();

		const applied = applyEmptyBaseline(findings);

		expect(findings.map((finding) => finding.rule)).toEqual([
			"security/accepted-advisory",
			"security/stale-accepted-advisory",
		]);
		expect(applied?.summary.new).toBe(0);
		expect(applied?.results[0].diagnostics).toEqual(findings);
		expect(
			computeScanExitCode({
				hasErrors: false,
				scoreable: true,
				score: 100,
				failBelow: 100,
				newFindings: applied?.summary.new,
			}),
		).toBe(0);
	});

	it("still count an unaccepted vulnerable dependency next to them as new", () => {
		const [accepted, stale] = acceptanceFindings();
		const unaccepted = vulnerableDependency({ message: "lodash (high)", packageName: "lodash" });

		const applied = applyEmptyBaseline([accepted, unaccepted, stale]);

		expect(applied?.summary.new).toBe(1);
		expect(applied?.results[0].diagnostics).toEqual([accepted, unaccepted, stale]);
	});
});
