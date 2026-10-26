import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tree } from "web-tree-sitter";
import { checkComplexity } from "../src/engines/code-quality/complexity.js";
import {
	analyzeCsharpFunctions,
	CsharpGrammarUnavailableError,
} from "../src/engines/code-quality/complexity-csharp-ast.js";
import { codeQualityEngine } from "../src/engines/code-quality/index.js";
import type { EngineContext } from "../src/engines/types.js";
import { resetCsharpParserForTests } from "../src/utils/csharp-parser.js";
import * as tooling from "../src/utils/tooling.js";

let tmpDir: string;

const makeContext = (files: string[], maxFunctionLoc = 40): EngineContext => ({
	rootDirectory: tmpDir,
	languages: ["csharp"],
	frameworks: ["none"],
	files,
	installedTools: {},
	config: {
		quality: { maxFunctionLoc, maxFileLoc: 4000, maxNesting: 4, maxParams: 6 },
		security: { audit: true, auditTimeout: 25000 },
	},
});

const shortMethods = (count: number): string =>
	Array.from(
		{ length: count },
		(_, index) => `    public int Method${index}() { return ${index}; }`,
	).join("\n");

const longMethod = (name: string, statements: number): string =>
	[
		`    public void ${name}()`,
		"    {",
		...Array.from({ length: statements }, () => "        Work();"),
		"    }",
	].join("\n");

const scan = async (source: string, maxFunctionLoc = 40) => {
	const filePath = path.join(tmpDir, "Subject.cs");
	fs.writeFileSync(filePath, source, "utf-8");
	return checkComplexity(makeContext([filePath], maxFunctionLoc));
};

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-complexity-csharp-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PRIMARY_CONSTRUCTOR_DECLARATIONS = [
	"public sealed class ScanFrames(BrokerProcess owner, int count)",
	"public partial class Partial(int count)",
	"public record Frame(int Kind, string Name)",
	"public record class FrameClass(int Kind)",
	"public struct Point(int x, int y)",
	"public readonly struct ReadonlyPoint(int x, int y)",
	"public record struct FramePoint(int X, int Y)",
	"public readonly record struct ReadonlyFrame(int X, int Y)",
	"public class Box<T>(T value) where T : class",
	"public interface IThing",
];

describe("C# primary-constructor types are not measured as functions", () => {
	it.each(["class", "struct"])(
		"still reports too-many-params for an ordinary %s primary constructor (PR 171)",
		async (declaration) => {
			const diagnostics = await scan(
				`public ${declaration} Subject(int a, int b, int c, int d, int e, int f, int g) { }`,
			);
			expect(
				diagnostics.filter((diagnostic) => diagnostic.rule === "complexity/too-many-params"),
			).toMatchObject([{ detail: "Subject · 7 params", line: 1 }]);
		},
	);

	it.each([
		["explicit constructor", "public Subject", "Subject"],
		["method", "public void Run", "Run"],
	])("still reports too-many-params for a record's %s (PR 171)", async (_, signature, name) => {
		const diagnostics = await scan(
			`public record Subject\n{\n    ${signature}(int a, int b, int c, int d, int e, int f, int g) { }\n}`,
		);
		expect(
			diagnostics.filter((diagnostic) => diagnostic.rule === "complexity/too-many-params"),
		).toMatchObject([{ detail: `${name} · 7 params`, line: 3 }]);
	});

	for (const declaration of PRIMARY_CONSTRUCTOR_DECLARATIONS) {
		it(`measures members, not the type, for: ${declaration}`, async () => {
			const source = `${declaration}\n{\n${shortMethods(60)}\n}\n`;
			const diagnostics = await scan(source);
			expect(diagnostics.filter((d) => d.rule === "complexity/function-too-long")).toEqual([]);
		});
	}

	it("reports one measurement per member plus the primary constructor itself", async () => {
		const deleteSpy = vi.spyOn(Tree.prototype, "delete");
		try {
			const source = `public sealed class Holder(int a, int b)\n{\n${shortMethods(60)}\n}\n`;
			const functions = await analyzeCsharpFunctions(source);
			expect(deleteSpy).toHaveBeenCalledTimes(1);
			expect(functions).not.toBeNull();
			expect(functions?.filter((fn) => fn.lineCount === 1)).toHaveLength(61);
			expect(functions?.find((fn) => fn.name === "Holder")?.paramCount).toBe(2);
			expect(functions?.some((fn) => fn.lineCount > 5)).toBe(false);
		} finally {
			deleteSpy.mockRestore();
		}
	});

	it("still flags an actually long method inside a primary-constructor class", async () => {
		const source = `public sealed class Holder(int a)\n{\n${shortMethods(30)}\n${longMethod("Huge", 60)}\n}\n`;
		const diagnostics = await scan(source);
		const tooLong = diagnostics.filter((d) => d.rule === "complexity/function-too-long");
		expect(tooLong).toHaveLength(1);
		expect(tooLong[0].detail).toContain("Huge");
	});
});

describe("C# members measured from the syntax tree", () => {
	it("measures constructors, destructors, operators, local functions and accessors", async () => {
		const source = [
			"public class Sample",
			"{",
			"    [Obsolete]",
			"    public Sample(int a) : this() { Work(); }",
			"    ~Sample() { Work(); }",
			"    public static Sample operator +(Sample left, Sample right) { return left; }",
			"    public static implicit operator int(Sample value) { return 1; }",
			"    public int Total { get { return 1; } set { Work(); } }",
			"    public int this[int index] { get { return index; } }",
			"    public int Run(int a)",
			"    {",
			"        int Local(int b) { return b; }",
			"        return Local(a);",
			"    }",
			"    public int Expression(int a) => a;",
			"}",
		].join("\n");
		const names = (await analyzeCsharpFunctions(source))?.map((fn) => fn.name);
		expect(names).toEqual([
			"Sample",
			"Sample",
			"operator",
			"operator conversion",
			"Total.get",
			"Total.set",
			"this.get",
			"Run",
			"Local",
		]);
	});

	it("starts a member at its signature line, not its attribute line", async () => {
		const cases = [
			{
				id: "interleaved-comments",
				leadingLines: [
					"    [Obsolete]",
					"    // explanatory comment between attributes",
					"    [Fact]",
					"    /* comment before signature */",
				],
				expectedStartLine: 7,
			},
			{
				id: "conditional-attribute-preproc-if",
				leadingLines: ["    [A]", "    #if DEBUG", "    [B]", "    #endif"],
				expectedStartLine: 7,
			},
			{
				id: "interleaved-preproc-pragma",
				leadingLines: ["    [A]", "    #pragma warning disable CS0612", "    [B]"],
				expectedStartLine: 6,
			},
			{
				id: "interleaved-preproc-region",
				leadingLines: ["    [A]", "    #region Attributes", "    [B]", "    #endregion"],
				expectedStartLine: 7,
			},
			{
				id: "closing-preproc-endregion",
				leadingLines: ["    #region Attributes", "    [A]", "    #endregion", "    [B]"],
				expectedStartLine: 7,
			},
			{
				id: "interleaved-preproc-nullable",
				leadingLines: ["    [A]", "    #nullable enable", "    [B]"],
				expectedStartLine: 6,
			},
			{
				id: "interleaved-preproc-line",
				leadingLines: ["    [A]", "    #line 10", "    [B]"],
				expectedStartLine: 6,
			},
			{
				id: "interleaved-preproc-warning",
				leadingLines: ["    [A]", "    #warning check attributes", "    [B]"],
				expectedStartLine: 6,
			},
			{
				id: "nested-conditional-attribute-preproc-if",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    #if RELEASE",
					"    [B]",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 9,
			},
			{
				id: "triple-nested-conditional-attribute-preproc-if",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    #if TRACE",
					"    #if RELEASE",
					"    [B]",
					"    #endif",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 11,
			},
			{
				id: "nested-conditional-attribute-inner-else",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    #if RELEASE",
					"    [B]",
					"    #else",
					"    [C]",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 11,
			},
			{
				id: "nested-conditional-attribute-inner-elif",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    #if RELEASE",
					"    [B]",
					"    #elif TRACE",
					"    [C]",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 11,
			},
			{
				id: "nested-conditional-attribute-in-outer-else",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    [B]",
					"    #else",
					"    #if RELEASE",
					"    [C]",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 11,
			},
			{
				id: "nested-conditional-attribute-in-outer-elif",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    [B]",
					"    #elif TRACE",
					"    #if RELEASE",
					"    [C]",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 11,
			},
			{
				id: "separated-nested-conditional-attributes",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    [B]",
					"    #if RELEASE",
					"    [C]",
					"    #endif",
					"    #endif",
				],
				expectedStartLine: 10,
			},
			{
				id: "nested-conditional-attribute-without-leading-attribute",
				leadingLines: ["    #if DEBUG", "    #if RELEASE", "    [B]", "    #endif", "    #endif"],
				expectedStartLine: 8,
			},
			{
				id: "empty-nested-conditional-preproc-if",
				leadingLines: ["    [A]", "    #if DEBUG", "    #if RELEASE", "    #endif", "    #endif"],
				expectedStartLine: 8,
			},
			{
				id: "nested-conditional-attribute-with-trailing-attribute",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    #if RELEASE",
					"    [B]",
					"    #endif",
					"    #endif",
					"    [C]",
				],
				expectedStartLine: 10,
			},
			{
				id: "nested-conditional-attribute-with-trailing-comment",
				leadingLines: [
					"    [A]",
					"    #if DEBUG",
					"    #if RELEASE",
					"    [B]",
					"    #endif",
					"    #endif",
					"    // trailing comment",
				],
				expectedStartLine: 10,
			},
		];
		for (const testCase of cases) {
			const source = ["class C", "{", ...testCase.leadingLines, longMethod("M", 41), "}"].join(
				"\n",
			);
			const method = (await analyzeCsharpFunctions(source))?.find((fn) => fn.name === "M");
			expect(method?.startLine, testCase.id).toBe(testCase.expectedStartLine);
			expect(method?.lineCount, testCase.id).toBe(44);
			const diagnostics = await scan(source, 40);
			expect(
				diagnostics.filter((d) => d.rule === "complexity/function-too-long"),
				testCase.id,
			).toEqual([]);
		}
	});

	it("measures nesting depth from the body", async () => {
		const deepConditions = "if (a) { if (a) { if (a) { if (a) { if (a) { Work(); } } } } }";
		const source = [
			"class C : Base",
			"{",
			`    public C(bool a) : base(() => { ${deepConditions} }) { }`,
			"    void M(bool a)",
			"    {",
			"        if (a) { if (a) { Work(); } } else if (a) { Work(); }",
			"    }",
			`    public int X { get { return 1; } set { ${deepConditions} } }`,
			"    public int OneLine() { return 1; }",
			`    public void Following(bool a) { ${deepConditions} }`,
			"}",
			"class Delegating",
			"{",
			`    public Delegating(bool a) : this(() => { ${deepConditions} }) { }`,
			"}",
		].join("\n");
		const functions = await analyzeCsharpFunctions(source);
		const byName = new Map(functions.map((fn) => [fn.name, fn.maxNesting]));
		expect(byName.get("C")).toBe(0);
		expect(byName.get("Delegating")).toBe(0);
		expect(byName.get("M")).toBe(2);
		expect(byName.get("X.get")).toBe(0);
		expect(byName.get("X.set")).toBe(5);
		expect(byName.get("OneLine")).toBe(0);
		expect(byName.get("Following")).toBe(5);
		const diagnostics = await scan(source);
		expect(
			diagnostics.filter((d) => d.rule === "complexity/deep-nesting").map((d) => d.detail),
		).toEqual(["X.set · depth 5", "Following · depth 5"]);
	});
});

describe("C# grammar load failure is an engine failure, not a silent fallback", () => {
	beforeEach(() => {
		resetCsharpParserForTests();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(tooling, "resolveBundledCsharpGrammar").mockReturnValue(null);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetCsharpParserForTests();
	});

	const primaryConstructorSource = `public sealed class Holder(int a)
{
${shortMethods(60)}
}
`;

	it("analyzeCsharpFunctions throws instead of falling back to line patterns", async () => {
		await expect(analyzeCsharpFunctions(primaryConstructorSource)).rejects.toBeInstanceOf(
			CsharpGrammarUnavailableError,
		);
	});

	it("checkComplexity rejects for a C# file", async () => {
		await expect(scan(primaryConstructorSource)).rejects.toThrow(/bundled C# grammar did not load/);
	});

	it("checkComplexity still analyzes files in other languages", async () => {
		const filePath = path.join(tmpDir, "plain.ts");
		fs.writeFileSync(filePath, "export const answer = 42;\n", "utf-8");
		await expect(checkComplexity(makeContext([filePath]))).resolves.toEqual([]);
	});

	it("the code-quality engine reports the failure and marks the run failed", async () => {
		const filePath = path.join(tmpDir, "Subject.cs");
		fs.writeFileSync(filePath, primaryConstructorSource, "utf-8");
		const result = await codeQualityEngine.run(makeContext([filePath]));
		expect(result.failed).toBe(true);
		expect(result.failures).toHaveLength(1);
		expect(result.failures?.[0].tool).toBe("code-quality complexity");
		expect(result.failures?.[0].reason).toMatch(/bundled C# grammar did not load/);
		expect(result.diagnostics.filter((d) => d.rule === "complexity/function-too-long")).toEqual([]);
	});
});
