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
const { inspectGovulncheck, runGovulncheck } = await import(
	"../src/engines/security/audit-ecosystem.js"
);

// Real `govulncheck -json ./...` output (golang.org/x/vuln v1.9.0, scan_level symbol)
// for a module that requires golang.org/x/text v0.3.7 and calls language.MatchStrings,
// trimmed to two advisories: GO-2022-1059 (the vulnerable symbol is called) and
// GO-2026-5970 (the module is required but nothing vulnerable is called). Messages
// are indented, multi-line JSON values, exactly as govulncheck prints them.
const REAL_STREAM = fs.readFileSync(
	path.join(import.meta.dirname, "fixtures", "govulncheck-symbol-level.json"),
	"utf8",
);
const REAL_STREAM_METADATA: { exitCode: number } = JSON.parse(
	fs.readFileSync(
		path.join(import.meta.dirname, "fixtures", "govulncheck-symbol-level.meta.json"),
		"utf8",
	),
);

const CONFIG_LINE_FOR_IGNORED = JSON.stringify({ config: { protocol_version: "v1.0.0" } });
const GO_ADVISORY = "GO-2022-1059";
const GO_ADVISORY_ALIASES = ["CVE-2022-32149", "GHSA-69ch-w2m2-3vjp"];
const NOT_CALLED_ADVISORY = "GO-2026-5970";

const respondWith = (stdout: string, exitCode = 0): void => {
	runSubprocess.mockResolvedValue({ stdout, stderr: "", exitCode });
};

describe("govulncheck audit parsing", () => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	it("reports the advisory whose vulnerable symbol is called, from real multi-line output", async () => {
		respondWith(REAL_STREAM, REAL_STREAM_METADATA.exitCode);

		const { diagnostics, completed } = await inspectGovulncheck("/repo", 1000);

		expect(completed).toBe(true);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			filePath: "go.mod",
			rule: "security/vulnerable-dependency",
			severity: "error",
			message: `Go vulnerability: ${GO_ADVISORY}`,
			packageName: "golang.org/x/text",
			advisories: [{ id: GO_ADVISORY, aliases: GO_ADVISORY_ALIASES }],
		});
		expect(diagnostics[0].help).toContain("Denial of service via crafted Accept-Language");
		expect(diagnostics[0].help).toContain("v0.3.8");
	});

	it("does not report advisories found only at module or package level", async () => {
		respondWith(REAL_STREAM);

		const diagnostics = await runGovulncheck("/repo", 1000);

		expect(JSON.stringify(diagnostics)).not.toContain(NOT_CALLED_ADVISORY);
	});

	it("reports one diagnostic per advisory when several symbol-level findings share it", async () => {
		const finding = {
			finding: {
				osv: GO_ADVISORY,
				fixed_version: "v0.3.8",
				trace: [
					{ module: "golang.org/x/text", package: "golang.org/x/text/language", function: "A" },
					{ module: "example.com/app", package: "example.com/app", function: "main" },
				],
			},
		};
		const other = {
			finding: { ...finding.finding, trace: [{ ...finding.finding.trace[0], function: "B" }] },
		};
		respondWith(
			[{ config: { protocol_version: "v1.0.0" } }, finding, other]
				.map((message) => JSON.stringify(message))
				.join("\n"),
		);

		await expect(runGovulncheck("/repo", 1000)).resolves.toHaveLength(1);
	});

	it.each([
		["one message per line", () => REAL_STREAM.replace(/\s*\n\s*/g, "").replace(/\}\{/g, "}\n{")],
		[
			"adjacent messages sharing a line",
			() => {
				const compact = REAL_STREAM.replace(/\s*\n\s*/g, "");
				const firstBoundary = compact.indexOf("}{");
				return `${compact.slice(0, firstBoundary + 1)}\n${compact.slice(firstBoundary + 1)}`;
			},
		],
		["an entirely compact stream", () => REAL_STREAM.replace(/\s*\n\s*/g, "")],
	])("parses %s as well as indented output", async (_name, getStream) => {
		respondWith(getStream());

		const diagnostics = await runGovulncheck("/repo", 1000);

		expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			`Go vulnerability: ${GO_ADVISORY}`,
		]);
	});

	it("keeps braces inside string values from splitting a message", async () => {
		respondWith(
			[
				{ config: { protocol_version: "v1.0.0" } },
				{ osv: { id: "GO-2000-0001", summary: 'a "}" and { in text' } },
				{
					finding: {
						osv: "GO-2000-0001",
						trace: [{ module: "example.com/dependency", function: "Run" }],
					},
				},
			]
				.map((message) => JSON.stringify(message, null, 2))
				.join("\n"),
		);

		const diagnostics = await runGovulncheck("/repo", 1000);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].help).toContain('a "}" and { in text');
	});

	it("still reports a called finding that arrives without its osv message", async () => {
		respondWith(
			[
				{ config: { protocol_version: "v1.0.0" } },
				{
					finding: { osv: "GO-2000-0002", trace: [{ module: "example.com/dep", function: "Run" }] },
				},
			]
				.map((message) => JSON.stringify(message))
				.join("\n"),
		);

		const diagnostics = await runGovulncheck("/repo", 1000);

		expect(diagnostics[0].advisories).toEqual([{ id: "GO-2000-0002" }]);
	});

	it("ignores config, progress, SBOM and malformed fragments", async () => {
		respondWith(
			`${CONFIG_LINE_FOR_IGNORED}\n{"progress":{"message":"x"}}\n{"SBOM":{"modules":[]}}\n`,
		);

		await expect(runGovulncheck("/repo", 1000)).resolves.toEqual([]);
	});

	it("counts a clean run as completed only when the stream opened with a config message", async () => {
		respondWith(`${JSON.stringify({ config: { protocol_version: "v1.0.0" } })}\n`);
		await expect(inspectGovulncheck("/repo", 1000)).resolves.toMatchObject({ completed: true });

		respondWith(`${JSON.stringify({ progress: { message: "x" } })}\n`);
		await expect(inspectGovulncheck("/repo", 1000)).resolves.toMatchObject({ completed: false });

		respondWith(REAL_STREAM, 2);
		await expect(inspectGovulncheck("/repo", 1000)).resolves.toMatchObject({ completed: false });
	});
});

const CONFIG_LINE = JSON.stringify({ config: { protocol_version: "v1.0.0" } });
const CALLED_FINDING = JSON.stringify({
	finding: { osv: "GO-2000-0001", trace: [{ module: "example.com/dep", function: "Run" }] },
});
const MULTILINE_CALLED_FINDING = JSON.stringify(JSON.parse(CALLED_FINDING), null, 2);
const UNPARSED_RULE = "security/dependency-audit-skipped";

const rulesOf = (diagnostics: Array<{ rule: string }>): string[] =>
	diagnostics.map((diagnostic) => diagnostic.rule);

describe("govulncheck output that cannot be fully parsed fails closed", () => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	it.each([
		["a stray brace on a non-JSON line", `${CONFIG_LINE}\nnot json {\n${CALLED_FINDING}\n`],
		[
			"plain text after the first object",
			`${CONFIG_LINE}\ngo: downloading go1.27.2\n${CALLED_FINDING}\n`,
		],
		[
			"a compact finding with a corrupt suffix",
			`${CONFIG_LINE}\n${CALLED_FINDING} trailing garbage\n`,
		],
		[
			"a multiline finding with a corrupt suffix",
			`${CONFIG_LINE}\n${MULTILINE_CALLED_FINDING} trailing garbage\n`,
		],
		[
			"a malformed sibling message following a finding",
			`${CONFIG_LINE}\n${CALLED_FINDING}\n{"finding":null}\n`,
		],
		[
			"a malformed sibling message preceding a finding",
			`${CONFIG_LINE}\n{"finding":null}\n${CALLED_FINDING}\n`,
		],
		[
			"an unterminated earlier object",
			`${CONFIG_LINE}\n{"progress":{"message":\n${CALLED_FINDING}\n`,
		],
	])("recovers a finding despite %s, and is not completed", async (_name, stream) => {
		respondWith(stream);

		const outcome = await inspectGovulncheck("/repo", 1000);

		expect(rulesOf(outcome.diagnostics)).toEqual([UNPARSED_RULE, "security/vulnerable-dependency"]);
		expect(outcome.completed).toBe(false);
	});

	it.each([
		[
			"the last object is missing its closing brace",
			`${CONFIG_LINE}\n${CALLED_FINDING.slice(0, -1)}\n`,
		],
		["a balanced object is not valid JSON", `${CONFIG_LINE}\n{"progress": nope}\n`],
	])("is not completed and warns when %s", async (_name, stream) => {
		respondWith(stream);

		const outcome = await inspectGovulncheck("/repo", 1000);

		expect(rulesOf(outcome.diagnostics)).toEqual([UNPARSED_RULE]);
		expect(outcome.completed).toBe(false);
	});

	it("does not report an accepted entry as stale when the output was truncated", async () => {
		respondWith(`${CONFIG_LINE}\n${CALLED_FINDING.slice(0, -1)}\n`);
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-govulncheck-"));
		try {
			const diagnostics = await runDependencyAudit({
				rootDirectory: directory,
				languages: ["go"],
				frameworks: [],
				installedTools: { govulncheck: true },
				config: {
					quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
					security: {
						audit: true,
						auditTimeout: 1000,
						acceptedAdvisories: [{ id: "GO-2000-0001", reason: "reviewed" }],
					},
					lint: { typecheck: false, expoDoctor: false },
				},
			});
			expect(rulesOf(diagnostics)).not.toContain("security/stale-accepted-advisory");
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["config after another message", `{"progress":{"message":"x"}}\n${CONFIG_LINE}\n`],
		["config without a protocol version", `{"config":{}}\n`],
		["config with an empty protocol version", `{"config":{"protocol_version":""}}\n`],
	])("is not completed for %s", async (_name, stream) => {
		respondWith(stream);

		await expect(inspectGovulncheck("/repo", 1000)).resolves.toMatchObject({ completed: false });
	});

	it("tolerates plain text before the first object", async () => {
		respondWith(`go: downloading go1.27.2 (linux/amd64)\n${CONFIG_LINE}\n${CALLED_FINDING}\n`);

		const outcome = await inspectGovulncheck("/repo", 1000);

		expect(rulesOf(outcome.diagnostics)).toEqual(["security/vulnerable-dependency"]);
		expect(outcome.completed).toBe(true);
	});

	it("still reports findings from a non-zero exit, warns, and does not count the run as completed", async () => {
		respondWith(`${CONFIG_LINE}\n${CALLED_FINDING}\n`, 3);

		const outcome = await inspectGovulncheck("/repo", 1000);

		expect(rulesOf(outcome.diagnostics)).toEqual([UNPARSED_RULE, "security/vulnerable-dependency"]);
		expect(outcome.completed).toBe(false);
	});

	it.each([
		["empty output with a zero exit", () => respondWith("")],
		["empty output with a non-zero exit", () => respondWith("", 2)],
		["a clean stream with a non-zero exit", () => respondWith(`${CONFIG_LINE}\n`, 3)],
		[
			"a run that could not be started or timed out",
			() => runSubprocess.mockRejectedValue(new Error("spawn govulncheck ETIMEDOUT")),
		],
	])("warns and is not completed for %s", async (_name, arrange) => {
		arrange();

		const outcome = await inspectGovulncheck("/repo", 1000);

		expect(rulesOf(outcome.diagnostics)).toEqual([UNPARSED_RULE]);
		expect(outcome.diagnostics[0].severity).toBe("warning");
		expect(outcome.completed).toBe(false);
	});

	// Each message must hold exactly one populated field, a finding names its advisory
	// and a trace of frames, and every frame names its module
	// (golang/vuln internal/govulncheck/govulncheck.go). The protocol gives every
	// finding at least one trace frame, even a module-level one, so a finding without
	// frames means the stream was corrupted.
	it.each([
		[
			"a finding with no advisory id",
			{ finding: { trace: [{ module: "example.com/dep", function: "Run" }] } },
		],
		["a finding with no trace key", { finding: { osv: "GO-2000-0001" } }],
		["a finding with an empty trace", { finding: { osv: "GO-2000-0001", trace: [] } }],
		["a null finding", { finding: null }],
		["a finding whose frame names no module", { finding: { osv: "GO-2000-0001", trace: [{}] } }],
		["a finding whose frame is not an object", { finding: { osv: "GO-2000-0001", trace: [null] } }],
		["an empty message", {}],
		["a message with a null field", { osv: null }],
		["a message with two fields", { progress: { message: "x" }, osv: { id: "GO-2000-0001" } }],
	])("warns and is not completed for %s", async (_name, message) => {
		respondWith(`${CONFIG_LINE}\n${JSON.stringify(message)}\n`);

		const outcome = await inspectGovulncheck("/repo", 1000);

		expect(rulesOf(outcome.diagnostics)).toEqual([UNPARSED_RULE]);
		expect(outcome.completed).toBe(false);
	});

	it.each([
		[
			"a numeric function",
			{ finding: { osv: "GO-2000-0001", trace: [{ module: "example.com/dep", function: 123 }] } },
		],
		[
			"a null function",
			{ finding: { osv: "GO-2000-0001", trace: [{ module: "example.com/dep", function: null }] } },
		],
		[
			"a numeric package",
			{ finding: { osv: "GO-2000-0001", trace: [{ module: "example.com/dep", package: 123 }] } },
		],
		["non-array SBOM modules", { SBOM: { modules: 123 } }],
		["a numeric progress message", { progress: { message: 123 } }],
	])(
		"warns and is not completed for %s while retaining sibling findings",
		async (_name, message) => {
			for (const sibling of ["", `${CALLED_FINDING}\n`]) {
				respondWith(`${CONFIG_LINE}\n${JSON.stringify(message)}\n${sibling}`);

				const outcome = await inspectGovulncheck("/repo", 1000);

				expect(outcome.completed).toBe(false);
				expect(rulesOf(outcome.diagnostics)).toEqual(
					sibling ? [UNPARSED_RULE, "security/vulnerable-dependency"] : [UNPARSED_RULE],
				);
				expect(outcome.diagnostics[0].severity).toBe("warning");
				expect(outcome.diagnostics[0].help).toContain("could not be fully parsed");
			}
		},
	);

	it.each([
		[
			"a module-level finding",
			{ finding: { osv: "GO-2000-0001", trace: [{ module: "example.com/dep" }] } },
		],
		[
			"a package-level finding",
			{
				finding: {
					osv: "GO-2000-0001",
					trace: [{ module: "example.com/dep", package: "example.com/dep/pkg" }],
				},
			},
		],
		["empty progress", { progress: {} }],
		["empty SBOM", { SBOM: {} }],
		[
			"a valid SBOM modules array",
			{ SBOM: { modules: [{ path: "example.com/dep", version: "v1.0.0" }] } },
		],
		["unknown extra fields", { progress: { message: "scanning", future: 123 }, future: null }],
		// govulncheck emits an osv for every database entry that applies to a module the
		// project uses, whatever its version, so an osv with no finding is a clean result.
		["an osv message with no finding", { osv: { id: "GO-2000-0001" } }],
	])("stays completed and clean for %s", async (_name, message) => {
		respondWith(`${CONFIG_LINE}\n${JSON.stringify(message)}\n`);

		await expect(inspectGovulncheck("/repo", 1000)).resolves.toEqual({
			diagnostics: [],
			completed: true,
		});
	});
});

describe("one advisory in several modules", () => {
	beforeEach(() => {
		runSubprocess.mockReset();
	});

	const jwtFinding = (version: "v4" | "v5", fixed: string): string =>
		JSON.stringify({
			finding: {
				osv: "GO-2025-3553",
				fixed_version: fixed,
				trace: [
					{
						module: `github.com/golang-jwt/jwt/${version}`,
						package: `github.com/golang-jwt/jwt/${version}`,
						function: "ParseUnverified",
						receiver: "Parser",
					},
				],
			},
		});
	const osv = JSON.stringify({
		osv: { id: "GO-2025-3553", aliases: ["CVE-2025-30204", "GHSA-mh63-6h87-95cp"] },
	});
	const config = JSON.stringify({
		config: { protocol_version: "v1.0.0", scan_level: "symbol", scan_mode: "source" },
	});

	const contextAcceptingV4 = (directory: string): EngineContext => ({
		rootDirectory: directory,
		languages: ["go"],
		frameworks: [],
		installedTools: { govulncheck: true },
		config: {
			quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
			security: {
				audit: true,
				auditTimeout: 1000,
				acceptedAdvisories: [
					{
						id: "GO-2025-3553",
						package: "github.com/golang-jwt/jwt/v4",
						reason: "Only v4 usage reviewed",
					},
				],
			},
			lint: { typecheck: false, expoDoctor: false },
		},
	});

	const orders = [
		["v4 first", [jwtFinding("v4", "v4.5.2"), jwtFinding("v5", "v5.2.2")]],
		["v5 first", [jwtFinding("v5", "v5.2.2"), jwtFinding("v4", "v4.5.2")]],
	] as const;

	it.each(orders)(
		"reports one diagnostic per module with its own fix (%s)",
		async (_name, findings) => {
			respondWith([config, osv, ...findings].join("\n"));

			const diagnostics = await runGovulncheck("/repo", 1000);

			expect(
				diagnostics
					.map((diagnostic) => [
						diagnostic.packageName,
						diagnostic.help.includes(
							diagnostic.packageName === "github.com/golang-jwt/jwt/v4" ? "v4.5.2" : "v5.2.2",
						),
					])
					.sort(),
			).toEqual([
				["github.com/golang-jwt/jwt/v4", true],
				["github.com/golang-jwt/jwt/v5", true],
			]);
		},
	);

	it.each(orders)(
		"accepting the v4 module never hides v5 and is order independent (%s)",
		async (_name, findings) => {
			respondWith([config, osv, ...findings].join("\n"));
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-govulncheck-"));
			try {
				const diagnostics = await runDependencyAudit(contextAcceptingV4(directory));

				expect(
					diagnostics.map((diagnostic) => [diagnostic.rule, diagnostic.packageName]).sort(),
				).toEqual([
					["security/accepted-advisory", "github.com/golang-jwt/jwt/v4"],
					["security/vulnerable-dependency", "github.com/golang-jwt/jwt/v5"],
				]);
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});

describe("accepted advisories on a Go finding", () => {
	let directory: string;

	beforeEach(() => {
		runSubprocess.mockReset();
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-govulncheck-"));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const contextAccepting = (id: string, packageName?: string): EngineContext => ({
		rootDirectory: directory,
		languages: ["go"],
		frameworks: [],
		installedTools: { govulncheck: true },
		config: {
			quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
			security: {
				audit: true,
				auditTimeout: 1000,
				acceptedAdvisories: [{ id, reason: "reviewed", package: packageName }],
			},
			lint: { typecheck: false, expoDoctor: false },
		},
	});

	it.each([
		["the GO id", GO_ADVISORY],
		["the CVE alias", "CVE-2022-32149"],
		["the GHSA alias", "ghsa-69ch-w2m2-3vjp"],
	])("accepts a finding by %s", async (_name, id) => {
		respondWith(REAL_STREAM);

		const diagnostics = await runDependencyAudit(contextAccepting(id, "golang.org/x/text"));

		expect(diagnostics.map((diagnostic) => [diagnostic.rule, diagnostic.severity])).toEqual([
			["security/accepted-advisory", "info"],
		]);
	});

	it("leaves the finding open when the entry names a different module", async () => {
		respondWith(REAL_STREAM);

		const diagnostics = await runDependencyAudit(contextAccepting(GO_ADVISORY, "golang.org/x/net"));

		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toContain(
			"security/vulnerable-dependency",
		);
	});

	it("reports an entry as stale once a completed Go audit no longer finds its advisory", async () => {
		respondWith(`${JSON.stringify({ config: { protocol_version: "v1.0.0" } })}\n`);

		const diagnostics = await runDependencyAudit(contextAccepting(GO_ADVISORY));

		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
			"security/stale-accepted-advisory",
		]);
	});
});
