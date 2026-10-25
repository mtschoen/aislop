// Exit codes and report shapes are from each tool's documentation:
//   bun audit    https://bun.sh/docs/pm/cli/audit   (exit 0 when none remain, 1 otherwise,
//                including an unreadable registry response; JSON is the raw registry map)
//   pip-audit    https://pypi.org/project/pip-audit/ (exit 0 none found, 1 found; no input
//                arguments audits the current environment, `-r file` audits a requirements file)
//   npm audit    https://docs.npmjs.com/cli/commands/npm-audit (non-zero when any vulnerability
//                is found); pnpm audit exits 1 the same way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SubprocessTimeoutError } from "../src/utils/subprocess.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));

vi.mock("../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/subprocess.js")>();
	return { ...actual, runSubprocess };
});

const { runBunAudit, runNpmAudit, runPnpmAuditWithFallback } = await import(
	"../src/engines/security/audit.js"
);
const { inspectCargoAudit, inspectDotnetAudit, inspectGovulncheck, inspectPipAudit } = await import(
	"../src/engines/security/audit-ecosystem.js"
);

const SKIPPED_RULE = "security/dependency-audit-skipped";
const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-honest-audit-"));
const bareDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-honest-audit-bare-"));
const fallbackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-honest-audit-lock-"));
fs.writeFileSync(path.join(projectDirectory, "requirements.txt"), "requests==2.0.0\n");
fs.writeFileSync(path.join(fallbackDirectory, "package-lock.json"), "{}\n");
const scratchDirectories: string[] = [];
afterAll(() => {
	for (const directory of [
		projectDirectory,
		bareDirectory,
		fallbackDirectory,
		...scratchDirectories,
	]) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

const writeRequirements = (contents: string): string => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-honest-audit-req-"));
	scratchDirectories.push(directory);
	fs.writeFileSync(path.join(directory, "requirements.txt"), contents);
	return directory;
};

const reply = (stdout: string, exitCode: number | null, stderr = ""): void => {
	runSubprocess.mockResolvedValue({ stdout, stderr, exitCode });
};

const braces = {
	severity: "high",
	via: [{ url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc" }],
};
const findingReport = JSON.stringify({ vulnerabilities: { braces } });
const rules = (diagnostics: { rule: string }[]): string[] => diagnostics.map((d) => d.rule);

beforeEach(() => {
	runSubprocess.mockReset();
});

describe("L1: bun audit only counts a real advisory map", () => {
	it.each([
		["error text", "error: no network", 1],
		["error object", '{"error":"offline"}', 1],
		["empty array", "[]", 0],
		["unrelated object", '{"unrelated":true}', 0],
		["null advisory entry", '{"braces":[null]}', 0],
		["empty output", "", 0],
	])("warns and is incomplete for %s", async (_name, stdout, exitCode) => {
		reply(stdout, exitCode);

		const outcome = await runBunAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE]);
		expect(outcome.diagnostics[0].severity).toBe("warning");
	});

	it("stays clean for an empty advisory map", async () => {
		reply("{}", 0);

		await expect(runBunAudit(projectDirectory, 1000)).resolves.toEqual({
			diagnostics: [],
			completed: true,
		});
	});

	it("reports findings without a warning when bun exits 1 with an advisory", async () => {
		reply(JSON.stringify({ braces: [{ severity: "high", title: "t" }] }), 1);

		const outcome = await runBunAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(true);
		expect(rules(outcome.diagnostics)).toEqual(["security/vulnerable-dependency"]);
	});
});

describe("L2: npm and pnpm do not complete over a dropped record", () => {
	it.each([
		["advisories", '{"advisories":{"braces":null},"vulnerabilities":{}}'],
		["vulnerabilities", '{"vulnerabilities":{"braces":null}}'],
		["advisories null", '{"advisories":null,"vulnerabilities":{}}'],
		["advisories array", '{"advisories":[],"vulnerabilities":{}}'],
		["advisories false", '{"advisories":false,"vulnerabilities":{}}'],
		["vulnerabilities null", '{"advisories":{},"vulnerabilities":null}'],
		["vulnerabilities array", '{"advisories":{},"vulnerabilities":[]}'],
	])("is incomplete when a %s record is malformed", async (_name, stdout) => {
		reply(stdout, 0);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE]);
	});

	it("keeps a readable finding beside a malformed record", async () => {
		reply(JSON.stringify({ vulnerabilities: { braces, broken: null } }), 1);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps a modern finding beside an empty legacy collection", async () => {
		reply(JSON.stringify({ advisories: {}, vulnerabilities: { braces } }), 1);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(true);
		expect(rules(outcome.diagnostics)).toEqual(["security/vulnerable-dependency"]);
	});

	it.each(['{"advisories":{},"vulnerabilities":{}}', '{"vulnerabilities":{}}'])(
		"stays clean for a legitimately empty report %s",
		async (stdout) => {
			reply(stdout, 0);

			await expect(runNpmAudit(projectDirectory, 1000)).resolves.toEqual({
				diagnostics: [],
				completed: true,
			});
		},
	);
});

describe("L3: a failed npm or pnpm run is not complete", () => {
	it.each([2, null])("keeps findings and warns for exit %s", async (exitCode) => {
		reply(findingReport, exitCode, "audit interrupted");

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
		expect(outcome.diagnostics[0].help).toContain("audit interrupted");
	});

	it.each([
		["empty", {}],
		["code", { code: "EINTERRUPTED" }],
		["summary", { summary: "audit interrupted" }],
	])("warns and keeps the finding when an %s error object sits beside it", async (_name, error) => {
		reply(JSON.stringify({ error, vulnerabilities: { braces } }), 2);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("reports a finding present in both collections once", async () => {
		reply(
			JSON.stringify({
				advisories: {
					1: { module_name: "braces", severity: "high", github_advisory_id: "GHSA-aaaa-bbbb-cccc" },
				},
				vulnerabilities: { braces },
			}),
			1,
		);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.diagnostics).toHaveLength(1);
		expect(outcome.diagnostics[0].advisories?.map((advisory) => advisory.id)).toEqual([
			"GHSA-aaaa-bbbb-cccc",
		]);
	});

	it("keeps a readable finding beside ENOLOCK on exit 2 and on timeout", async () => {
		const stdout = JSON.stringify({ error: { code: "ENOLOCK" }, vulnerabilities: { braces } });
		reply(stdout, 2);
		const failed = await runNpmAudit(projectDirectory, 1000);
		runSubprocess.mockRejectedValue(new SubprocessTimeoutError("timed out: npm", stdout, ""));
		const timedOut = await runNpmAudit(projectDirectory, 1000);

		for (const outcome of [failed, timedOut]) {
			expect(outcome.completed).toBe(false);
			expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
		}
	});

	it("stays quiet when the audit exits 1 with findings, as the tools document", async () => {
		reply(findingReport, 1);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(true);
		expect(rules(outcome.diagnostics)).toEqual(["security/vulnerable-dependency"]);
	});

	const pnpmFailed = { stdout: findingReport, stderr: "interrupted", exitCode: 2 };
	const fallbackTools = () =>
		runSubprocess.mock.calls.map(([command, args = []]: [string, string[]?]) => {
			const executable = [command, ...args].at(-3) ?? command;
			return path.win32.basename(executable, path.win32.extname(executable)).toLowerCase();
		});

	it.each([
		["a clean npm report", { stdout: '{"vulnerabilities":{}}', stderr: "", exitCode: 0 }],
		["a failed npm run", { stdout: "", stderr: "npm broke", exitCode: 2 }],
		["a timed out npm run", new SubprocessTimeoutError("timed out: npm", "", "")],
	])("keeps pnpm's finding and warning when the npm fallback is %s", async (_name, npmReply) => {
		runSubprocess.mockResolvedValueOnce(pnpmFailed);
		if (npmReply instanceof Error) runSubprocess.mockRejectedValueOnce(npmReply);
		else runSubprocess.mockResolvedValueOnce(npmReply);

		const outcome = await runPnpmAuditWithFallback(fallbackDirectory, 1000);

		expect(fallbackTools()).toEqual(["pnpm", "npm"]);
		expect(outcome.completed).toBe(false);
		expect(outcome.diagnostics.map((d) => d.packageName)).toContain("braces");
		expect(rules(outcome.diagnostics)).toContain(SKIPPED_RULE);
	});

	it("does not read a failed pnpm audit with a clean npm fallback as complete", async () => {
		runSubprocess
			.mockResolvedValueOnce({ stdout: "", stderr: "pnpm broke", exitCode: 2 })
			.mockResolvedValueOnce({ stdout: '{"vulnerabilities":{}}', stderr: "", exitCode: 0 });

		const outcome = await runPnpmAuditWithFallback(fallbackDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE]);
	});

	const advisoryUrl = (id: string) => ({ url: `https://github.com/advisories/${id}` });
	const legacy = (severity: string, ...ids: string[]) =>
		ids.map((id, index) => [
			String(index),
			{ module_name: "braces", severity, github_advisory_id: id },
		]);
	const ids = (diagnostic?: { advisories?: { id: string }[] }) =>
		diagnostic?.advisories?.map((advisory) => advisory.id);

	it.each([
		["critical pnpm, low npm", "critical", "low", "error"],
		["low pnpm, critical npm", "low", "critical", "error"],
	])("keeps the higher severity when %s disagree", async (_name, pnpmLevel, npmLevel, expected) => {
		const report = (level: string, id: string) =>
			JSON.stringify({ vulnerabilities: { braces: { severity: level, via: [advisoryUrl(id)] } } });
		runSubprocess
			.mockResolvedValueOnce({
				stdout: report(pnpmLevel, "GHSA-aaaa-bbbb-cccc"),
				stderr: "x",
				exitCode: 2,
			})
			.mockResolvedValueOnce({
				stdout: report(npmLevel, "GHSA-dddd-eeee-ffff"),
				stderr: "",
				exitCode: 1,
			});

		const outcome = await runPnpmAuditWithFallback(fallbackDirectory, 1000);
		const finding = outcome.diagnostics.find((d) => d.packageName === "braces");

		expect(finding?.severity).toBe(expected);
		expect(finding?.message).toContain("(critical");
	});

	it("keeps both advisories a failed pnpm run reported for one package", async () => {
		const pnpmReport = JSON.stringify({
			advisories: Object.fromEntries(legacy("high", "GHSA-aaaa-bbbb-cccc", "GHSA-gggg-hhhh-iiii")),
		});
		runSubprocess
			.mockResolvedValueOnce({ stdout: pnpmReport, stderr: "x", exitCode: 2 })
			.mockResolvedValueOnce({
				stdout: JSON.stringify({
					vulnerabilities: {
						braces: { severity: "high", via: [advisoryUrl("GHSA-dddd-eeee-ffff")] },
					},
				}),
				stderr: "",
				exitCode: 1,
			});

		const outcome = await runPnpmAuditWithFallback(fallbackDirectory, 1000);
		const findings = outcome.diagnostics.filter((d) => d.packageName === "braces");

		expect(findings).toHaveLength(1);
		expect(ids(findings[0])?.sort()).toEqual([
			"GHSA-aaaa-bbbb-cccc",
			"GHSA-dddd-eeee-ffff",
			"GHSA-gggg-hhhh-iiii",
		]);
	});

	it("reports a package both lockfiles flag once, with the advisories of both", async () => {
		const npmReport = JSON.stringify({
			vulnerabilities: {
				braces: {
					severity: "high",
					via: [{ url: "https://github.com/advisories/GHSA-dddd-eeee-ffff" }],
				},
			},
		});
		runSubprocess
			.mockResolvedValueOnce(pnpmFailed)
			.mockResolvedValueOnce({ stdout: npmReport, stderr: "", exitCode: 1 });

		const outcome = await runPnpmAuditWithFallback(fallbackDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(outcome.diagnostics.filter((d) => d.packageName === "braces")).toHaveLength(1);
		expect(
			outcome.diagnostics
				.find((d) => d.packageName === "braces")
				?.advisories?.map((advisory) => advisory.id),
		).toEqual(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]);
	});

	const noAdvisoryIds: [string, Record<string, unknown>][] = [
		["an absent via", { severity: "critical" }],
		["an empty via", { severity: "critical", via: [] }],
		["a string-only via", { severity: "critical", via: ["other-package"] }],
	];
	const identifiedBraces = { severity: "high", via: [advisoryUrl("GHSA-aaaa-bbbb-cccc")] };
	const identifiedLegacy = {
		1: { module_name: "braces", severity: "high", github_advisory_id: "GHSA-aaaa-bbbb-cccc" },
	};
	const separateFromIdentified = (
		diagnostics: { packageName?: string; advisories?: unknown[] }[],
	) => {
		const findings = diagnostics.filter((d) => d.packageName === "braces");
		expect(findings).toHaveLength(2);
		expect(findings.filter((d) => d.advisories?.length)).toHaveLength(1);
	};

	it.each(noAdvisoryIds)(
		"keeps %s finding separate from an identified one across both collections",
		async (_name, bare) => {
			reply(JSON.stringify({ advisories: identifiedLegacy, vulnerabilities: { braces: bare } }), 1);
			separateFromIdentified((await runNpmAudit(projectDirectory, 1000)).diagnostics);
		},
	);

	it.each(noAdvisoryIds)(
		"keeps %s fallback finding separate from an identified one in either order",
		async (_name, bare) => {
			const report = (braces: unknown) => JSON.stringify({ vulnerabilities: { braces } });
			for (const [pnpmBraces, npmBraces] of [
				[identifiedBraces, bare],
				[bare, identifiedBraces],
			]) {
				runSubprocess
					.mockResolvedValueOnce({ stdout: report(pnpmBraces), stderr: "x", exitCode: 2 })
					.mockResolvedValueOnce({ stdout: report(npmBraces), stderr: "", exitCode: 1 });

				const outcome = await runPnpmAuditWithFallback(fallbackDirectory, 1000);

				separateFromIdentified(outcome.diagnostics);
			}
		},
	);

	it("keeps pnpm's findings and warning when there is no npm lockfile", async () => {
		reply(findingReport, 2, "interrupted");

		const outcome = await runPnpmAuditWithFallback(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});
});

describe("L4: output printed before a timeout is kept", () => {
	const timeout = (stdout: string) =>
		new SubprocessTimeoutError("Command timed out after 1000ms: npm", stdout, "");

	it("keeps an npm finding beside the warning", async () => {
		runSubprocess.mockRejectedValue(timeout(findingReport));

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps a bun finding beside the warning", async () => {
		runSubprocess.mockRejectedValue(timeout(JSON.stringify({ braces: [{ severity: "high" }] })));

		const outcome = await runBunAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps a pip-audit finding beside the warning", async () => {
		runSubprocess.mockRejectedValue(
			timeout(
				JSON.stringify({
					dependencies: [{ name: "requests", version: "2.0.0", vulns: [{ id: "PYSEC-1" }] }],
				}),
			),
		);

		const outcome = await inspectPipAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps an npm finding printed beside an error object", async () => {
		runSubprocess.mockRejectedValue(
			timeout(JSON.stringify({ error: { code: "EINTERRUPTED" }, vulnerabilities: { braces } })),
		);

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps a cargo audit finding beside the warning", async () => {
		runSubprocess.mockRejectedValue(
			timeout(
				JSON.stringify({
					vulnerabilities: {
						found: true,
						count: 1,
						list: [
							{
								advisory: { id: "RUSTSEC-2020-0001", title: "bad" },
								package: { name: "smallvec", version: "1.0.0" },
							},
						],
					},
				}),
			),
		);

		const outcome = await inspectCargoAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps a govulncheck finding beside the warning", async () => {
		const messages = [
			{ config: { protocol_version: "v1.0.0" } },
			{
				finding: { osv: "GO-2020-0001", trace: [{ module: "example.com/mod", function: "Run" }] },
			},
		];
		runSubprocess.mockRejectedValue(timeout(messages.map((m) => JSON.stringify(m)).join("\n")));

		const outcome = await inspectGovulncheck(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("keeps a NuGet finding beside the warning", async () => {
		const report = {
			projects: [
				{
					path: path.join(projectDirectory, "App.csproj"),
					frameworks: [
						{
							framework: "net8.0",
							topLevelPackages: [
								{
									id: "Bad.Package",
									requestedVersion: "1.0.0",
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
		};
		runSubprocess.mockRejectedValue(timeout(JSON.stringify(report)));

		const outcome = await inspectDotnetAudit(
			{ rootDirectory: projectDirectory, dependencyAuditFiles: ["App.csproj"] },
			1000,
		);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE, "security/vulnerable-dependency"]);
	});

	it("warns alone when nothing was printed", async () => {
		runSubprocess.mockRejectedValue(timeout(""));

		const outcome = await runNpmAudit(projectDirectory, 1000);

		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE]);
	});
});

describe("L5: pip-audit audits the project, not its own environment", () => {
	it("passes the project's requirements file", async () => {
		reply(
			JSON.stringify({
				dependencies: [{ name: "requests", version: "2.0.0", vulns: [{ id: "PYSEC-1" }] }],
			}),
			1,
		);

		const outcome = await inspectPipAudit(projectDirectory, 1000);

		expect(runSubprocess).toHaveBeenCalledWith(
			"pip-audit",
			[
				"--format=json",
				"--progress-spinner=off",
				"--disable-pip",
				"--no-deps",
				"-r",
				"requirements.txt",
			],
			expect.objectContaining({ cwd: projectDirectory }),
		);
		expect(outcome.completed).toBe(true);
		expect(rules(outcome.diagnostics)).toEqual(["security/vulnerable-dependency"]);
	});

	it.each([
		["a hashed pin", "requests==2.0.0 \\\n    --hash=sha256:abc123\n"],
		["a marker and a comment", "requests==2.0.0 ; python_version >= '3.8'  # http client\n"],
		["an index option", "--index-url https://pypi.example/simple\nrequests==2.0.0\n"],
		["no requirements", "# nothing yet\n"],
	])("audits %s with pip disabled", async (_name, contents) => {
		const directory = writeRequirements(contents);
		reply(JSON.stringify({ dependencies: [] }), 0);

		const outcome = await inspectPipAudit(directory, 1000);

		expect(runSubprocess).toHaveBeenCalledTimes(1);
		expect(outcome.completed).toBe(true);
	});

	it.each([
		["an unpinned name", "requests\n", "requests"],
		["a range", "requests>=2.0\n", "requests>=2.0"],
		["a wildcard pin", "requests==2.*\n", "requests==2.*"],
		["a local path", "./vendored-package\n", "./vendored-package"],
		["an editable install", "-e .\n", "-e ."],
		["a nested requirements file", "-r other.txt\n", "-r other.txt"],
		[
			"a direct URL",
			"pkg @ https://example.com/pkg.tar.gz\n",
			"pkg @ https://example.com/pkg.tar.gz",
		],
		["an sdist URL", "https://example.com/pkg-1.0.tar.gz\n", "https://example.com/pkg-1.0.tar.gz"],
		[
			"a VCS URL",
			"git+https://example.com/pkg.git#egg=pkg\n",
			"git+https://example.com/pkg.git#egg=pkg",
		],
		["an unpinned line after a pin", "requests==2.0.0\nflask\n", "flask"],
	])("never runs pip-audit for %s", async (_name, contents, named) => {
		const directory = writeRequirements(contents);
		reply(JSON.stringify({ dependencies: [] }), 0);

		const outcome = await inspectPipAudit(directory, 1000);

		expect(runSubprocess).not.toHaveBeenCalled();
		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE]);
		expect(outcome.diagnostics[0].help).toContain(named);
	});

	it("stays clean for a requirements file with no vulnerabilities", async () => {
		reply(JSON.stringify({ dependencies: [{ name: "requests", version: "2.0.0", vulns: [] }] }), 0);

		await expect(inspectPipAudit(projectDirectory, 1000)).resolves.toEqual({
			diagnostics: [],
			completed: true,
		});
	});

	it("warns instead of auditing the wrong environment when there is no requirements.txt", async () => {
		reply('{"dependencies":[],"fixes":[]}', 0);

		const outcome = await inspectPipAudit(bareDirectory, 1000);

		expect(runSubprocess).not.toHaveBeenCalled();
		expect(outcome.completed).toBe(false);
		expect(rules(outcome.diagnostics)).toEqual([SKIPPED_RULE]);
		expect(outcome.diagnostics[0].help).toContain("requirements.txt");
	});
});
