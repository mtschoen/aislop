import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintEngine } from "../../src/engines/lint/index.js";
import { parseRoslynatorXml } from "../../src/engines/lint/dotnet.js";
import type { EngineContext } from "../../src/engines/types.js";

const csharpContext = (
	rootDirectory: string,
	installedTools: Record<string, boolean>,
): EngineContext => ({
	rootDirectory,
	languages: ["csharp"],
	frameworks: [],
	installedTools,
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
});

describe("parseRoslynatorXml", () => {
	it("maps diagnostics to aislop Diagnostic[]", () => {
		const xml = fs.readFileSync(
			path.join(__dirname, "../fixtures/dotnet/roslynator-output.xml"),
			"utf-8",
		);
		const diags = parseRoslynatorXml(xml, "/repo");
		expect(diags.length).toBeGreaterThan(0);
		expect(diags[0].engine).toBe("lint");
		expect(diags[0].rule.startsWith("dotnet/")).toBe(true);
		expect(diags[0].category).toBe("C# Lint");
		expect(diags[0].line).toBeGreaterThan(0);
	});

	it("filters out diagnostic IDs that are not in the relevant set", () => {
		const xml = fs.readFileSync(
			path.join(__dirname, "../fixtures/dotnet/roslynator-output.xml"),
			"utf-8",
		);
		const diags = parseRoslynatorXml(xml, "/repo");
		// CA1822 is present in the fixture but not in RELEVANT_IDS, so it must be dropped.
		expect(diags.some((d) => d.rule === "dotnet/CA1822")).toBe(false);
		expect(diags.some((d) => d.rule === "dotnet/AsyncFixer03")).toBe(true);
	});

	it("maps absolute file paths to repo-relative", () => {
		const xml = fs.readFileSync(
			path.join(__dirname, "../fixtures/dotnet/roslynator-output.xml"),
			"utf-8",
		);
		const diags = parseRoslynatorXml(xml, "/repo");
		expect(diags[0].filePath).toBe("Bad.cs");
	});

	it("returns [] on malformed XML", () => {
		expect(parseRoslynatorXml("<not-xml", "/repo")).toEqual([]);
	});
});

describe("lintEngine dotnet gating", () => {
	it("skips dotnet lint when roslynator is not installed", async () => {
		const result = await lintEngine.run(csharpContext("/nonexistent", { roslynator: false }));
		expect(result.diagnostics).toEqual([]);
	});

	it("returns [] when roslynator is installed but no .csproj/.sln target exists", async () => {
		const result = await lintEngine.run(csharpContext("/nonexistent", { roslynator: true }));
		expect(result.diagnostics).toEqual([]);
	});
});
