import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDotnetFormatReport } from "../src/engines/format/dotnet-format.js";

const ROOT = path.join(path.sep, "repo");

const report = (files: unknown): string => JSON.stringify(files);

const fileEntry = (relPath: string, changeCount = 1): unknown => ({
	FileName: path.basename(relPath),
	FilePath: path.join(ROOT, relPath),
	FileChanges: Array.from({ length: changeCount }, (_, i) => ({
		LineNumber: i + 1,
		CharNumber: 1,
		DiagnosticId: "WHITESPACE",
		FormatDescription: "Fix whitespace formatting.",
	})),
});

describe("parseDotnetFormatReport", () => {
	it("emits one warning per unformatted file with a project-relative path", () => {
		const diagnostics = parseDotnetFormatReport(report([fileEntry("src/Foo.cs", 7)]), ROOT);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe("csharp-formatting");
		expect(diagnostics[0].engine).toBe("format");
		// POSIX separators on every OS (relativePosix); guards the Windows backslash regression.
		expect(diagnostics[0].filePath).toBe("src/Foo.cs");
		expect(diagnostics[0].fixable).toBe(true);
		// One finding per file, not one per whitespace change.
		expect(diagnostics).toHaveLength(1);
	});

	it("skips files with no changes", () => {
		const diagnostics = parseDotnetFormatReport(
			report([{ FileName: "Clean.cs", FilePath: path.join(ROOT, "Clean.cs"), FileChanges: [] }]),
			ROOT,
		);
		expect(diagnostics).toEqual([]);
	});

	it("dedupes a file reported under more than one entry", () => {
		const diagnostics = parseDotnetFormatReport(
			report([fileEntry("src/Foo.cs"), fileEntry("src/Foo.cs")]),
			ROOT,
		);
		expect(diagnostics).toHaveLength(1);
	});

	it("falls back to FileName when FilePath is absent", () => {
		const diagnostics = parseDotnetFormatReport(
			report([{ FileName: "Bar.cs", FileChanges: [{ DiagnosticId: "WHITESPACE" }] }]),
			ROOT,
		);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].filePath).toBe("Bar.cs");
	});

	it("returns nothing for empty, non-array, or invalid output", () => {
		expect(parseDotnetFormatReport("", ROOT)).toEqual([]);
		expect(parseDotnetFormatReport("not json", ROOT)).toEqual([]);
		expect(parseDotnetFormatReport(JSON.stringify({ projects: [] }), ROOT)).toEqual([]);
	});
});
