import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJbXml } from "../../src/engines/lint/jb.js";

const fixture = (): string =>
	fs.readFileSync(path.join(__dirname, "../fixtures/dotnet/jb-output.xml"), "utf-8");

const opts = (over: Partial<{ excludeTypes: Set<string>; severityFloor: "ERROR" | "WARNING" | "SUGGESTION" | "HINT" }> = {}) => ({
	excludeTypes: over.excludeTypes ?? new Set<string>(),
	severityFloor: over.severityFloor ?? ("WARNING" as const),
});

describe("parseJbXml", () => {
	it("maps issues to aislop Diagnostic[] with jb/<TypeId> rules", () => {
		const diags = parseJbXml(fixture(), "/repo", opts());
		const redundant = diags.find((d) => d.rule === "jb/RedundantUsingDirective");
		expect(redundant).toBeDefined();
		expect(redundant?.engine).toBe("lint");
		expect(redundant?.category).toBe("C# Lint");
		expect(redundant?.severity).toBe("warning");
		expect(redundant?.line).toBe(3);
		expect(redundant?.fixable).toBe(false);
	});

	it("normalizes backslash file paths to forward slashes", () => {
		const diags = parseJbXml(fixture(), "/repo", opts());
		expect(diags[0].filePath).toBe("src/App/Service.cs");
	});

	it("drops issues below the severity floor (WARNING floor hides SUGGESTION/HINT)", () => {
		const diags = parseJbXml(fixture(), "/repo", opts());
		expect(diags.some((d) => d.rule === "jb/ConvertToConstant.Local")).toBe(false);
		expect(diags.some((d) => d.rule === "jb/RedundantToStringCall")).toBe(false);
	});

	it("includes SUGGESTION when the floor is lowered, mapped to info severity", () => {
		const diags = parseJbXml(fixture(), "/repo", opts({ severityFloor: "SUGGESTION" }));
		const suggestion = diags.find((d) => d.rule === "jb/ConvertToConstant.Local");
		expect(suggestion).toBeDefined();
		expect(suggestion?.severity).toBe("info");
	});

	it("excludes denylisted inspection types", () => {
		const diags = parseJbXml(fixture(), "/repo", opts({ excludeTypes: new Set(["InconsistentNaming"]) }));
		expect(diags.some((d) => d.rule === "jb/InconsistentNaming")).toBe(false);
	});

	it("returns [] on malformed XML", () => {
		expect(parseJbXml("<not-xml", "/repo", opts())).toEqual([]);
	});
});
