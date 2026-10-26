import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareScan, runScanEngines } from "../src/commands/scan-pipeline.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { AislopConfig } from "../src/config/index.js";
import { runEngines } from "../src/engines/orchestrator.js";
import type { Diagnostic, EngineContext } from "../src/engines/types.js";
import { runScopedScan } from "../src/hooks/io/scoped-scan.js";

const NARRATIVE = "ai-slop/narrative-comment";
const META = "ai-slop/meta-comment";

const { fakeDiagnostics } = vi.hoisted(() => ({ fakeDiagnostics: [] as Diagnostic[] }));

vi.mock("../src/engines/ai-slop/index.js", () => ({
	aiSlopEngine: {
		name: "ai-slop",
		run: async () => ({
			engine: "ai-slop",
			diagnostics: fakeDiagnostics.map((diagnostic) => ({ ...diagnostic })),
			elapsed: 0,
			skipped: false,
		}),
	},
}));

const finding = (rule: string): Diagnostic => ({
	filePath: "src/app.ts",
	engine: "ai-slop",
	rule,
	severity: "warning",
	message: "",
	help: "",
	line: 1,
	column: 1,
	category: "AI Slop",
	fixable: false,
});

const tempDirs: string[] = [];

const makeProject = (): string => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-severity-order-"));
	tempDirs.push(root);
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
	fs.mkdirSync(path.join(root, "src"), { recursive: true });
	fs.writeFileSync(path.join(root, "src", "app.ts"), "export const value = 1;\n");
	return root;
};

const unrelatedOverrides: AislopConfig["overrides"] = [
	{ files: ["docs/**"], rules: { "ai-slop/trivial-comment": "off" } },
];

const configFor = (withOverrides: boolean): AislopConfig => ({
	...DEFAULT_CONFIG,
	engines: {
		format: false,
		lint: false,
		"code-quality": false,
		"ai-slop": true,
		architecture: false,
		security: false,
	},
	security: { ...DEFAULT_CONFIG.security, audit: false },
	telemetry: { enabled: false },
	rules: { [NARRATIVE]: "off" },
	overrides: withOverrides ? unrelatedOverrides : [],
});

const rulesOf = (diagnostics: Diagnostic[]): string[] =>
	diagnostics.map((diagnostic) => diagnostic.rule);

afterEach(() => {
	fakeDiagnostics.length = 0;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("rule severities apply before the comment dedupe", () => {
	it.each([false, true])(
		"runEngines keeps meta-comment (overrides present: %s)",
		async (withOverrides) => {
			fakeDiagnostics.push(finding(NARRATIVE), finding(META));
			const config = configFor(withOverrides);
			const context = {
				rootDirectory: makeProject(),
				languages: [],
				frameworks: [],
				files: [],
				installedTools: {},
				config: { ...config, rules: config.rules, overrides: config.overrides },
			} as unknown as EngineContext;

			const results = await runEngines(context, { "ai-slop": true });

			expect(rulesOf(results.flatMap((result) => result.diagnostics))).toEqual([META]);
		},
	);

	it("scan path reports identical findings with and without overrides", async () => {
		fakeDiagnostics.push(finding(NARRATIVE), finding(META));
		const root = makeProject();
		const found: string[][] = [];
		for (const withOverrides of [false, true]) {
			const config = configFor(withOverrides);
			const prepared = await prepareScan(root, config, { kind: "full" });
			const { results } = await runScanEngines(prepared, config, true);
			found.push(rulesOf(results.flatMap((result) => result.diagnostics)));
		}
		expect(found).toEqual([[META], [META]]);
	});

	it.each([false, true])(
		"hook scoped scan keeps meta-comment (overrides present: %s)",
		async (withOverrides) => {
			fakeDiagnostics.push(finding(NARRATIVE), finding(META));
			const root = makeProject();
			fs.mkdirSync(path.join(root, ".aislop"), { recursive: true });
			const overrides = withOverrides
				? "overrides:\n  - files: ['docs/**']\n    rules:\n      ai-slop/trivial-comment: off\n"
				: "";
			fs.writeFileSync(
				path.join(root, ".aislop", "config.yml"),
				`version: 1\nrules:\n  ai-slop/narrative-comment: off\n${overrides}`,
			);

			const result = await runScopedScan(root, [path.join(root, "src", "app.ts")]);

			expect(rulesOf(result.diagnostics)).toEqual([META]);
		},
	);
});
