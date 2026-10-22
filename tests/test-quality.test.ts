import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import type { EngineContext } from "../src/engines/types.js";
import { applySuppressions } from "../src/utils/suppress.js";

let tmpDir: string;

const writeFile = (relative: string, content: string): void => {
	const absolute = path.join(tmpDir, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
};

const buildContext = (languages: EngineContext["languages"]): EngineContext => ({
	rootDirectory: tmpDir,
	languages,
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
});

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-test-quality-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tautological test assertions", () => {
	it("flags a JavaScript assertion that can never fail", async () => {
		writeFile(
			"src/value.test.ts",
			[
				"it('passes', () => { expect(true).toBe(true); });",
				"it('also passes', () => { assert.strictEqual(1, 1); });",
				'it(\'still passes\', () => { expect("ok").toBe("ok"); });',
			].join("\n"),
		);

		const result = await aiSlopEngine.run(buildContext(["typescript"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([
			expect.objectContaining({ filePath: "src/value.test.ts", line: 1 }),
			expect.objectContaining({ filePath: "src/value.test.ts", line: 2 }),
			expect.objectContaining({ filePath: "src/value.test.ts", line: 3 }),
		]);
	});

	it("compares fixed JavaScript literals by value instead of source spelling", async () => {
		writeFile(
			"src/value.test.ts",
			[
				`it("matches strings", () => { expect("ok").toBe('ok'); });`,
				"it('matches numbers', () => { assert.strictEqual(1.0, 1); });",
				String.raw`it("matches escapes", () => { expect("\u0041b").toBe("Ab"); });`,
			].join("\n"),
		);

		const result = await aiSlopEngine.run(buildContext(["typescript"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([
			expect.objectContaining({ filePath: "src/value.test.ts", line: 1 }),
			expect.objectContaining({ filePath: "src/value.test.ts", line: 2 }),
			expect.objectContaining({ filePath: "src/value.test.ts", line: 3 }),
		]);
	});

	it("flags a Python assertion that can never fail", async () => {
		writeFile(
			"tests/test_pipeline.py",
			"def test_pipeline():\n    run_pipeline()\n    assert True\n",
		);

		const result = await aiSlopEngine.run(buildContext(["python"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([
			expect.objectContaining({ filePath: "tests/test_pipeline.py", line: 3 }),
		]);
	});

	it("does not flag assertion examples inside comments or strings", async () => {
		writeFile(
			"src/checker.test.ts",
			[
				"// expect(true).toBe(true)",
				"const sample = `expect(true).toBe(true);`;",
				'const stringSample = \'expect("ok").toBe("ok")\';',
				"it('checks output', () => expect(run()).toBe(true));",
				"it('compares outcomes', () => expect(1).toBe(2));",
			].join("\n"),
		);

		const result = await aiSlopEngine.run(buildContext(["typescript"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([]);
	});

	it("still finds a real assertion after an assertion-shaped string on the same line", async () => {
		writeFile(
			"src/checker.test.ts",
			'const sample = "expect(true).toBe(true)"; expect(true).toBe(true);\n',
		);

		const result = await aiSlopEngine.run(buildContext(["typescript"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([
			expect.objectContaining({ filePath: "src/checker.test.ts", line: 1 }),
		]);
	});

	it("does not flag Python assertions whose result can vary", async () => {
		writeFile(
			"tests/test_pipeline.py",
			["def test_pipeline(value):", "    assert True and value", "    assert True == value"].join(
				"\n",
			),
		);

		const result = await aiSlopEngine.run(buildContext(["python"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([]);
	});

	it("does not flag Python assertion examples inside triple-quoted strings", async () => {
		writeFile(
			"tests/test_pipeline.py",
			['EXAMPLE = """', "    assert True", '"""', "def test_pipeline():", "    assert value"].join(
				"\n",
			),
		);

		const result = await aiSlopEngine.run(buildContext(["python"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([]);
	});
	it("flags the closed true-literal assertion spellings in Python, JavaScript, and C#", async () => {
		writeFile(
			"tests/test_pipeline.py",
			[
				"def test_pipeline(self):",
				"    assert 1",
				'    assert True, "excuse"',
				"    self.assertTrue(True)",
				'    self.assertTrue(True, "excuse")',
			].join("\n"),
		);
		writeFile(
			"src/value.test.ts",
			[
				"it('a', () => { assert.ok(true); });",
				"it('b', () => { assert(true, 'excuse'); });",
				"it('c', () => { expect(true).toBeTruthy(); });",
			].join("\n"),
		);
		writeFile(
			"tests/PipelineTests.cs",
			[
				"public class PipelineTests {",
				'    [Fact] public void A() { Assert.True(true, "excuse"); }',
				"    [Fact] public void B() { Assert.IsTrue(true); }",
				"}",
			].join("\n"),
		);

		const result = await aiSlopEngine.run(buildContext(["python", "typescript", "csharp"]));

		expect(
			result.diagnostics
				.filter((d) => d.rule === "ai-slop/tautological-test")
				.map((d) => `${d.filePath}:${d.line}`)
				.sort(),
		).toEqual([
			"src/value.test.ts:1",
			"src/value.test.ts:2",
			"src/value.test.ts:3",
			"tests/PipelineTests.cs:2",
			"tests/PipelineTests.cs:3",
			"tests/test_pipeline.py:2",
			"tests/test_pipeline.py:3",
			"tests/test_pipeline.py:4",
			"tests/test_pipeline.py:5",
		]);
	});

	it("does not flag assertions on values or examples quoted in strings and comments", async () => {
		writeFile(
			"tests/test_pipeline.py",
			[
				"def test_pipeline(self, value):",
				"    assert value",
				"    self.assertTrue(value)",
				"    assert 1 == value",
			].join("\n"),
		);
		writeFile(
			"src/value.test.ts",
			[
				"it('a', () => { assert.ok(run()); });",
				"it('b', () => { expect(run()).toBeTruthy(); });",
				"it('c', () => { $assert(true); $assert.ok(true); $expect(true).toBeTruthy(); });",
				"it('d', () => { \u00e9assert(true); \u00e9assert.ok(true); \u00e9expect(true).toBeTruthy(); });",
				"it('e', () => { \u03b1assert(true); \u03b1assert.ok(true); \u03b1expect(true).toBeTruthy(); });",
				"it('f', () => { a\u200cassert(true); a\u200dassert.ok(true); a\u200cexpect(true).toBeTruthy(); });",
				String.raw`it('g', () => { \u0061assert(true); \u{61}assert.ok(true); \u{61}expect(true).toBeTruthy(); });`,
				"// assert.ok(true)",
				"const sample = 'expect(true).toBeTruthy()';",
			].join("\n"),
		);
		writeFile(
			"tests/PipelineTests.cs",
			[
				"public class PipelineTests {",
				'    [Fact] public void A() { Assert.True(Run(), "true"); }',
				"    // Assert.True(true);",
				'    string sample = "Assert.True(true)";',
				"}",
			].join("\n"),
		);

		const result = await aiSlopEngine.run(buildContext(["python", "typescript", "csharp"]));

		expect(result.diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual([]);
	});

	it("honours the inline suppression marker", async () => {
		writeFile(
			"tests/PipelineTests.cs",
			[
				"public class PipelineTests {",
				"    // aislop-ignore-next-line ai-slop/tautological-test -- placeholder until the harness lands",
				"    [Fact] public void A() { Assert.True(true); }",
				"}",
			].join("\n"),
		);

		const result = await aiSlopEngine.run(buildContext(["csharp"]));
		const { results } = applySuppressions([result], tmpDir);

		expect(results[0].diagnostics.filter((d) => d.rule === "ai-slop/tautological-test")).toEqual(
			[],
		);
	});
});
