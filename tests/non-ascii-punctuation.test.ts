import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectNonAsciiPunctuation } from "../src/engines/ai-slop/non-ascii-punctuation.js";
import type { EngineContext } from "../src/engines/types.js";
import { applySuppressions } from "../src/utils/suppress.js";

// Built from code points so this test file stays pure ASCII on disk and the rule
// cannot flag its own fixtures when aislop scans itself.
const EM_DASH = String.fromCodePoint(0x2014);
const EN_DASH = String.fromCodePoint(0x2013);
const MINUS_SIGN = String.fromCodePoint(0x2212);
const RIGHT_SINGLE_QUOTE = String.fromCodePoint(0x2019);
const LEFT_DOUBLE_QUOTE = String.fromCodePoint(0x201c);
const RIGHT_DOUBLE_QUOTE = String.fromCodePoint(0x201d);
const ELLIPSIS = String.fromCodePoint(0x2026);
const NON_BREAKING_SPACE = String.fromCodePoint(0x00a0);
const RIGHT_ARROW = String.fromCodePoint(0x2192);
const EMOJI = String.fromCodePoint(0x1f680);
const ACCENTED_LETTER = String.fromCodePoint(0x00e9);

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-non-ascii-punctuation-"));
});
afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ctx = (rootDirectory: string): EngineContext => ({
	rootDirectory,
	languages: ["typescript"],
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
	},
});

const writeFile = (relativePath: string, content: string): void => {
	const full = path.join(tmpDir, relativePath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, "utf-8");
};

const dashDiags = async () => {
	const diagnostics = await detectNonAsciiPunctuation(ctx(tmpDir));
	return diagnostics.filter((d) => d.rule === "ai-slop/em-dash");
};

const smartDiags = async () => {
	const diagnostics = await detectNonAsciiPunctuation(ctx(tmpDir));
	return diagnostics.filter((d) => d.rule === "ai-slop/smart-punctuation");
};

describe("em-dash detection", () => {
	it("flags an em dash in a source comment", async () => {
		writeFile("src/a.ts", `// keep this ${EM_DASH} it matters\nexport const x = 1;\n`);
		const diagnostics = await dashDiags();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].line).toBe(1);
		expect(diagnostics[0].message).toContain("em dash");
	});

	it("flags an em dash in a string literal", async () => {
		writeFile("src/a.ts", `export const help = "usage${EM_DASH}see docs";\n`);
		expect(await dashDiags()).toHaveLength(1);
	});

	it("flags an em dash in markdown prose", async () => {
		writeFile("docs/guide.md", `# Guide\n\nThis is prose ${EM_DASH} with a tell.\n`);
		const diagnostics = await dashDiags();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].filePath).toBe("docs/guide.md");
		expect(diagnostics[0].line).toBe(3);
	});

	it("flags an em dash inside a fenced code block (no blanket code-block exemption)", async () => {
		writeFile("docs/guide.md", ["# Guide", "", "```sh", `echo ${EM_DASH}`, "```", ""].join("\n"));
		const diagnostics = await dashDiags();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].line).toBe(4);
	});

	it("flags an em dash in a yaml config file", async () => {
		writeFile("config.yml", `title: a value ${EM_DASH} with a tell\n`);
		expect(await dashDiags()).toHaveLength(1);
	});

	it("flags en dashes and minus signs as the same rule", async () => {
		writeFile("src/a.ts", `// a ${EN_DASH} b\n// c ${MINUS_SIGN} d\n`);
		const diagnostics = await dashDiags();
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0].message).toContain("en dash");
		expect(diagnostics[1].message).toContain("minus sign");
	});

	it("reports one finding per line and counts the rest", async () => {
		writeFile("src/a.ts", `// a ${EM_DASH} b ${EM_DASH} c\n`);
		const diagnostics = await dashDiags();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("2 on this line");
	});

	it("reports the column of the first offending character", async () => {
		writeFile("src/a.ts", `//${EM_DASH}\n`);
		const diagnostics = await dashDiags();
		expect(diagnostics[0].column).toBe(3);
	});

	it("ships report-only: info severity, not fixable", async () => {
		writeFile("src/a.ts", `// a ${EM_DASH} b\n`);
		const diagnostics = await dashDiags();
		expect(diagnostics[0].severity).toBe("info");
		expect(diagnostics[0].fixable).toBe(false);
	});

	it("does not flag ASCII-only content", async () => {
		writeFile("src/a.ts", `// a - b, c: d (e)\nexport const x = 1;\n`);
		writeFile("docs/guide.md", "# Guide\n\nPlain ASCII prose only.\n");
		expect(await dashDiags()).toHaveLength(0);
	});

	it("does not flag emoji or accented letters", async () => {
		writeFile("src/a.ts", `// ship it ${EMOJI} caf${ACCENTED_LETTER}\n`);
		expect(await dashDiags()).toHaveLength(0);
		expect(await smartDiags()).toHaveLength(0);
	});

	it("skips dependency lockfiles", async () => {
		writeFile("pnpm-lock.yaml", `description: a ${EM_DASH} b\n`);
		writeFile("package-lock.json", `{"description": "a ${EM_DASH} b"}\n`);
		expect(await dashDiags()).toHaveLength(0);
	});

	it("skips auto-generated files", async () => {
		writeFile("src/schema.ts", `// @generated by a tool\nexport const q = "a ${EM_DASH} b";\n`);
		expect(await dashDiags()).toHaveLength(0);
	});
});

describe("smart-punctuation detection", () => {
	it("flags curly quotes", async () => {
		writeFile("src/a.ts", `// it${RIGHT_SINGLE_QUOTE}s here\n`);
		const diagnostics = await smartDiags();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].message).toContain("quotation mark");
	});

	it("flags curly double quotes, ellipsis, arrows, and non-breaking spaces", async () => {
		writeFile(
			"docs/guide.md",
			[
				`a ${LEFT_DOUBLE_QUOTE}quoted${RIGHT_DOUBLE_QUOTE} phrase`,
				`trailing off${ELLIPSIS}`,
				`input ${RIGHT_ARROW} output`,
				`hard${NON_BREAKING_SPACE}space`,
				"",
			].join("\n"),
		);
		expect(await smartDiags()).toHaveLength(4);
	});

	it("keeps the two families separate", async () => {
		writeFile("src/a.ts", `// a ${EM_DASH} it${RIGHT_SINGLE_QUOTE}s\n`);
		expect(await dashDiags()).toHaveLength(1);
		expect(await smartDiags()).toHaveLength(1);
	});
});

describe("em-dash suppression", () => {
	const wrap = async () => {
		const diagnostics = await detectNonAsciiPunctuation(ctx(tmpDir));
		return applySuppressions(
			[{ engine: "ai-slop", diagnostics, elapsed: 0, skipped: false }],
			tmpDir,
		);
	};

	it("honors aislop-ignore-next-line scoped to the rule", async () => {
		writeFile(
			"src/a.ts",
			`// aislop-ignore-next-line ai-slop/em-dash -- quoting real tool output\nconst captured = "a ${EM_DASH} b";\n`,
		);
		const { results, suppressedCount } = await wrap();
		expect(suppressedCount).toBe(1);
		expect(results[0].diagnostics).toHaveLength(0);
	});

	it("honors an inline aislop-ignore-line directive", async () => {
		writeFile(
			"src/a.ts",
			`const captured = "a ${EM_DASH} b"; // aislop-ignore-line ai-slop/em-dash\n`,
		);
		const { suppressedCount } = await wrap();
		expect(suppressedCount).toBe(1);
	});

	it("honors an html-comment aislop-ignore-file directive in markdown", async () => {
		writeFile(
			"docs/em-dashes.md",
			[
				"<!-- aislop-ignore-file ai-slop/em-dash -- this note is about em dashes -->",
				"",
				`An em dash looks like ${EM_DASH} and an en dash like ${EN_DASH}.`,
				"",
			].join("\n"),
		);
		const { results, suppressedCount } = await wrap();
		expect(suppressedCount).toBe(1);
		expect(results[0].diagnostics).toHaveLength(0);
	});

	it("does not suppress a different rule on the same line", async () => {
		writeFile(
			"src/a.ts",
			`// aislop-ignore-next-line ai-slop/smart-punctuation\nconst captured = "a ${EM_DASH} b";\n`,
		);
		const { results } = await wrap();
		expect(results[0].diagnostics).toHaveLength(1);
		expect(results[0].diagnostics[0].rule).toBe("ai-slop/em-dash");
	});

	it("still flags punctuation on a line whose directive names an unrelated rule", async () => {
		writeFile(
			"src/a.ts",
			`const captured = "a ${EM_DASH} b"; // aislop-ignore-line ai-slop/console-leftover\n`,
		);
		const { results, suppressedCount } = await wrap();
		expect(suppressedCount).toBe(0);
		expect(results[0].diagnostics).toHaveLength(1);
	});

	it("does not flag the directive line itself", async () => {
		writeFile(
			"src/a.ts",
			`// aislop-ignore-next-line ai-slop/em-dash -- the reason mentions ${EM_DASH} itself\nconst captured = "plain";\n`,
		);
		expect(await dashDiags()).toHaveLength(0);
	});
});
