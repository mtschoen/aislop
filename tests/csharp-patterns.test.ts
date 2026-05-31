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

describe("csharp-patterns: async-void", () => {
	it("flags a plain async void method", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { async void DoWork() { await Task.Delay(1); } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-async-void")).toBe(true);
	});

	it("does NOT flag an event-handler-shaped async void", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(
			root,
			"A.cs",
			"class A { async void OnClick(object sender, EventArgs e) { await Task.Delay(1); } }",
		);
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-async-void")).toBe(false);
	});
});

describe("csharp-patterns: sync-over-async", () => {
	it("flags .Result", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { void M() { var x = GetAsync().Result; } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-sync-over-async")).toBe(true);
	});

	it("does NOT flag when an intent comment precedes it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(
			root,
			"A.cs",
			[
				"class A { void M() {",
				"// safe: task already completed",
				"var x = GetAsync().Result; } }",
			].join("\n"),
		);
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-sync-over-async")).toBe(false);
	});
});

describe("csharp-patterns: suppressed-warning", () => {
	it("flags an unjustified #pragma warning disable", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "#pragma warning disable CS1591\nclass A { }\n");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-suppressed-warning")).toBe(true);
	});

	it("does NOT flag a pragma justified by a trailing comment", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "#pragma warning disable CS1591 // generated file\nclass A { }\n");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-suppressed-warning")).toBe(false);
	});

	it("does NOT flag a pragma justified by a preceding comment", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "// docs not required for generated code\n#pragma warning disable CS1591\nclass A { }\n");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-suppressed-warning")).toBe(false);
	});

	it("does NOT flag #pragma warning restore", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "#pragma warning restore CS1591\nclass A { }\n");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-suppressed-warning")).toBe(false);
	});

	it("flags [SuppressMessage] with a <Pending> placeholder justification", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", '[SuppressMessage("Usage", "CA2200", Justification = "<Pending>")]\nclass A { }\n');
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-suppressed-warning")).toBe(true);
	});

	it("does NOT flag [SuppressMessage] with a real justification", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", '[SuppressMessage("Usage", "CA2200", Justification = "rethrow preserves the original frame")]\nclass A { }\n');
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-suppressed-warning")).toBe(false);
	});
});

describe("csharp-patterns: empty-catch-rethrow", () => {
	it("flags a single-line catch that only rethrows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { void M() { try { Do(); } catch (Exception) { throw; } } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-empty-catch-rethrow")).toBe(true);
	});

	it("flags a multi-line catch that only rethrows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", ["try {", "  Do();", "} catch (Exception ex) {", "  throw;", "}"].join("\n"));
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-empty-catch-rethrow")).toBe(true);
	});

	it("does NOT flag a catch that logs before rethrow", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", ["try { Do(); } catch (Exception ex) {", "  Log(ex);", "  throw;", "}"].join("\n"));
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-empty-catch-rethrow")).toBe(false);
	});

	it("does NOT flag a catch that wraps and rethrows", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { void M() { try { Do(); } catch (Exception ex) { throw new InvalidOperationException(\"x\", ex); } } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-empty-catch-rethrow")).toBe(false);
	});
});

describe("csharp-patterns: null-forgiving", () => {
	it("flags a `= null!` initializer", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { public string Name { get; set; } = null!; }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-null-forgiving")).toBe(true);
	});

	it("flags a use-site `foo!.Bar`", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { void M(B b) { var x = b!.Value; } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-null-forgiving")).toBe(true);
	});

	it("does NOT flag `!=` inequality", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { bool M(int a, int b) { return a != b; } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-null-forgiving")).toBe(false);
	});

	it("does NOT flag a prefix logical-not `!flag`", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", "class A { bool M(bool flag) { return !flag; } }");
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-null-forgiving")).toBe(false);
	});

	it("does NOT flag `!` inside a string literal", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-csp-"));
		write(root, "A.cs", 'class A { string M() { return "done!"; } }');
		const diags = await detectCSharpPatterns(ctx(root));
		expect(diags.some((d) => d.rule === "ai-slop/csharp-null-forgiving")).toBe(false);
	});
});
