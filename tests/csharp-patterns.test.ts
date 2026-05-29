import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectCSharpPatterns } from "../src/engines/ai-slop/csharp-patterns.js";
import type { EngineContext } from "../src/engines/types.js";

const ctx = (root: string): EngineContext => ({
	rootDirectory: root,
	languages: ["csharp"],
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
});

const write = (root: string, name: string, body: string) => {
	fs.writeFileSync(path.join(root, name), body);
};

describe("csharp-patterns: NotImplementedException", () => {
	it("flags throw new NotImplementedException()", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { int M() { throw new NotImplementedException(); } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-not-implemented")).toBe(true);
	});

	it("does not flag inside a comment", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { // throw new NotImplementedException();\n }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-not-implemented")).toBe(false);
	});
});

describe("csharp-patterns: redundant XML-doc", () => {
	it("flags a Gets/Sets boilerplate summary", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(
			root,
			"B.cs",
			[
				"/// <summary>Gets or sets the name.</summary>",
				"public string Name { get; set; }",
				"",
			].join("\n"),
		);
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-redundant-doc-comment")).toBe(true);
	});

	it("does not flag a summary with real explanatory content", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(
			root,
			"C.cs",
			[
				"/// <summary>Caches results because recomputation is O(n^2).</summary>",
				"public string Name { get; set; }",
				"",
			].join("\n"),
		);
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-redundant-doc-comment")).toBe(false);
	});
});
