import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRoslynatorXml } from "../../src/engines/lint/dotnet.js";

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
