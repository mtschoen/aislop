import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csharpWallClockAssertionLines } from "../src/engines/ai-slop/test-wall-clock-csharp.js";
import { parseCsharp, resetCsharpParserForTests } from "../src/utils/csharp-parser.js";
import * as tooling from "../src/utils/tooling.js";

describe("csharp parser unavailability and warnings", () => {
	beforeEach(() => {
		resetCsharpParserForTests();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetCsharpParserForTests();
	});

	it("warns once to stderr and returns null when the bundled C# grammar is missing", async () => {
		vi.spyOn(tooling, "resolveBundledCsharpGrammar").mockReturnValue(null);

		const result1 = await parseCsharp("class Program {}");
		expect(result1).toBeNull();
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith(
			"aislop: bundled C# grammar was missing or failed to load; C# test-timing detection was skipped: bundled C# grammar not found (tools/grammars/tree-sitter-c_sharp.wasm)",
		);

		// Subsequent calls in the same process should return null without warning again.
		const result2 = await parseCsharp("class Program2 {}");
		expect(result2).toBeNull();
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	it("warns once to stderr and returns null when parser loading throws an error", async () => {
		vi.spyOn(tooling, "resolveBundledCsharpGrammar").mockReturnValue("/nonexistent/file.wasm");

		const result1 = await parseCsharp("class Program {}");
		expect(result1).toBeNull();
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(vi.mocked(console.error).mock.calls[0]?.[0]).toMatch(
			/^aislop: bundled C# grammar was missing or failed to load; C# test-timing detection was skipped:/,
		);

		const result2 = await parseCsharp("class Program2 {}");
		expect(result2).toBeNull();
		expect(console.error).toHaveBeenCalledTimes(1);
	});

	it("parses C# source and returns root node without stderr warning when grammar is available", async () => {
		const root = await parseCsharp("class Program { static void Main() {} }");
		expect(root).not.toBeNull();
		expect(root?.type).toBe("compilation_unit");
		expect(console.error).not.toHaveBeenCalled();
	});

	it("csharpWallClockAssertionLines returns empty array and emits one stderr warning when grammar is missing", async () => {
		vi.spyOn(tooling, "resolveBundledCsharpGrammar").mockReturnValue(null);

		const source = [
			"using System.Diagnostics;",
			"public class Tests {",
			"    public void Test() {",
			"        var watch = Stopwatch.StartNew();",
			"        Assert.True(watch.ElapsedMilliseconds < 400);",
			"    }",
			"}",
		].join("\n");

		const lines1 = await csharpWallClockAssertionLines(source);
		expect(lines1).toEqual([]);
		expect(console.error).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledWith(
			"aislop: bundled C# grammar was missing or failed to load; C# test-timing detection was skipped: bundled C# grammar not found (tools/grammars/tree-sitter-c_sharp.wasm)",
		);

		const lines2 = await csharpWallClockAssertionLines(source);
		expect(lines2).toEqual([]);
		expect(console.error).toHaveBeenCalledTimes(1);
	});
});
