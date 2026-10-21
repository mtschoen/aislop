import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/engines/types.js";
import {
	filterExcludedDiagnostics,
	isPathExcluded,
	normalizeExcludePatterns,
} from "../src/utils/exclude.js";

const diagnostic = (filePath: string): Diagnostic => ({
	filePath,
	engine: "lint",
	rule: "dotnet/IDISP001",
	severity: "warning",
	message: "test",
	help: "",
	line: 1,
	column: 1,
	category: "C# Lint",
	fixable: false,
});

describe("normalizeExcludePatterns", () => {
	it("expands a bare directory into the path and its descendants", () => {
		expect(normalizeExcludePatterns(["external/VendorLib"])).toEqual([
			"external/VendorLib",
			"external/VendorLib/**",
		]);
	});

	it("expands a bare dot-prefixed entry into the path and its descendants", () => {
		expect(normalizeExcludePatterns([".claude"])).toEqual(["**/.claude", "**/.claude/**"]);
	});

	it("ignores a trailing slash and a leading project prefix", () => {
		expect(normalizeExcludePatterns([".claude/"])).toEqual(["**/.claude", "**/.claude/**"]);
		expect(normalizeExcludePatterns(["./external/VendorLib/"])).toEqual([
			"external/VendorLib",
			"external/VendorLib/**",
		]);
	});

	it("keeps an explicit glob unchanged", () => {
		expect(normalizeExcludePatterns(["external/VendorLib/**"])).toEqual(["external/VendorLib/**"]);
		expect(normalizeExcludePatterns(["**/*.generated.cs"])).toEqual(["**/*.generated.cs"]);
	});

	it("drops empty and oversized entries", () => {
		expect(normalizeExcludePatterns(["  ", "/"])).toEqual([]);
		expect(normalizeExcludePatterns(["a".repeat(257)])).toEqual([]);
	});
});

describe("isPathExcluded", () => {
	const normalized = normalizeExcludePatterns(["external/VendorLib/**", ".claude/**"]);

	it("matches a file under an excluded directory", () => {
		expect(isPathExcluded("external/VendorLib/VendorLib/JournalBrokerHost.cs", normalized)).toBe(
			true,
		);
	});

	it("matches a dotfile scratch directory", () => {
		expect(isPathExcluded(".claude/spikes/App.cs", normalized)).toBe(true);
	});

	it("does not match a first-party file", () => {
		expect(isPathExcluded("GitWizard/GitWizardReport.cs", normalized)).toBe(false);
	});

	it("returns false when there are no patterns", () => {
		expect(isPathExcluded("anything.cs", [])).toBe(false);
	});

	it("matches nested files under a bare dot-prefixed entry", () => {
		const bare = normalizeExcludePatterns([".claude"]);
		expect(isPathExcluded(".claude/spikes/App.cs", bare)).toBe(true);
		expect(isPathExcluded("nested/.claude/spikes/App.cs", bare)).toBe(true);
		expect(isPathExcluded("GitWizard/GitWizardReport.cs", bare)).toBe(false);
	});

	it("matches nested files under a bare directory entry", () => {
		const bare = normalizeExcludePatterns(["external/VendorLib"]);
		expect(isPathExcluded("external/VendorLib/VendorLib/JournalBrokerHost.cs", bare)).toBe(true);
		expect(isPathExcluded("external/VendorLibExtras/Host.cs", bare)).toBe(false);
	});

	it.each([
		["**/*.generated.cs", "src/Model.generated.cs", "src/Model.cs"],
		["src/f{1..10}.ts", "src/f10.ts", "src/f11.ts"],
		["src/f{01..03}.ts", "src/f02.ts", "src/f2.ts"],
		["src/f{1..5..2}.ts", "src/f3.ts", "src/f2.ts"],
		["!src/f{1..3}.ts", "src/f4.ts", "src/f1.ts"],
		["src/!(f{1..3}).ts", "src/f4.ts", "src/f1.ts"],
	])("matches diagnostic exclusion glob %s", (pattern, included, excluded) => {
		const glob = normalizeExcludePatterns([pattern]);
		expect(isPathExcluded(included, glob)).toBe(true);
		expect(isPathExcluded(excluded, glob)).toBe(false);
	});
});

describe("filterExcludedDiagnostics", () => {
	const root = "/repo";

	it("drops diagnostics under excluded paths and keeps the rest", () => {
		const diagnostics = [
			diagnostic("external/VendorLib/VendorLib/JournalBrokerHost.cs"),
			diagnostic(".claude/spikes/App.axaml.cs"),
			diagnostic("GitWizard/GitWizardReport.cs"),
		];
		const kept = filterExcludedDiagnostics(diagnostics, root, [
			"external/VendorLib/**",
			".claude/**",
		]);
		expect(kept.map((d) => d.filePath)).toEqual(["GitWizard/GitWizardReport.cs"]);
	});

	it("drops a build-backed notice pointing at an excluded project file", () => {
		const notice = diagnostic("external/VendorLib/Benchmark/Benchmark.csproj");
		const kept = filterExcludedDiagnostics([notice], root, ["external/VendorLib/**"]);
		expect(kept).toHaveLength(0);
	});

	it("normalizes absolute diagnostic paths before matching", () => {
		const kept = filterExcludedDiagnostics(
			[diagnostic("/repo/external/VendorLib/VendorLib/File.cs")],
			root,
			["external/VendorLib/**"],
		);
		expect(kept).toHaveLength(0);
	});

	it.each([
		"./external/VendorLib/File.cs",
		"src/../external/VendorLib/File.cs",
		"external\\VendorLib\\File.cs",
		".\\external\\VendorLib\\File.cs",
	])("matches normalized diagnostic path %s", (filePath) => {
		expect(
			filterExcludedDiagnostics([diagnostic(filePath)], root, ["external/VendorLib/**"]),
		).toEqual([]);
	});

	it.each([
		"external/VendorLib/../../src/Own.cs",
		"../external/VendorLib/Outside.cs",
		"external/VendorLibExtras/Own.cs",
	])("keeps a path whose normalized destination is not excluded: %s", (filePath) => {
		const finding = diagnostic(filePath);
		expect(filterExcludedDiagnostics([finding], root, ["external/VendorLib/**"])).toEqual([
			finding,
		]);
	});

	it("drops diagnostics under a bare dot-prefixed exclude entry", () => {
		const diagnostics = [
			diagnostic(".claude/spikes/App.cs"),
			diagnostic("GitWizard/GitWizardReport.cs"),
		];
		const kept = filterExcludedDiagnostics(diagnostics, root, [".claude"]);
		expect(kept.map((d) => d.filePath)).toEqual(["GitWizard/GitWizardReport.cs"]);
	});

	it("is a no-op when no exclude patterns are configured", () => {
		const diagnostics = [diagnostic("external/VendorLib/VendorLib/File.cs")];
		expect(filterExcludedDiagnostics(diagnostics, root, undefined)).toHaveLength(1);
		expect(filterExcludedDiagnostics(diagnostics, root, [])).toHaveLength(1);
	});
});
