import { describe, expect, it } from "vitest";
import { parseClangTidyOutput } from "../../src/engines/lint/clang-tidy.js";

const OUTPUT = [
	"/repo/src/foo.cpp:12:7: warning: variable 'x' is not initialized [cppcoreguidelines-init-variables]",
	"/repo/src/foo.cpp:20:1: error: use of undeclared identifier 'y' [clang-diagnostic-error]",
	"/repo/src/foo.cpp:12:7: note: initialize the variable 'x' to silence this warning",
	"12345 warnings generated.",
].join("\n");

describe("parseClangTidyOutput", () => {
	it("maps warning/error lines and ignores notes and summaries", () => {
		const diags = parseClangTidyOutput(OUTPUT, "/repo");
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			filePath: "src/foo.cpp",
			rule: "clang-tidy/cppcoreguidelines-init-variables",
			severity: "warning",
			line: 12,
			column: 7,
			category: "C++ Lint",
			engine: "lint",
		});
		expect(diags[1]).toMatchObject({
			rule: "clang-tidy/clang-diagnostic-error",
			severity: "error",
		});
	});

	// A project .clang-tidy with `WarningsAsErrors: "*"` makes clang-tidy append
	// `,-warnings-as-errors` to the bracketed check name. The real check id is the
	// first comma-separated entry; the pseudo-entry must not break the match or
	// leak into the rule id (else every finding is silently dropped).
	it("parses the real check id when WarningsAsErrors appends -warnings-as-errors", () => {
		const output = [
			"/repo/src/io.cpp:78:23: error: narrowing conversion from 'uint64_t' to 'int64_t' [bugprone-narrowing-conversions,-warnings-as-errors]",
			"/repo/src/io.cpp:15:9: warning: parameter name 'f' is too short [readability-identifier-length,-warnings-as-errors]",
		].join("\n");
		const diags = parseClangTidyOutput(output, "/repo");
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			rule: "clang-tidy/bugprone-narrowing-conversions",
			severity: "error",
			line: 78,
		});
		expect(diags[1]).toMatchObject({
			rule: "clang-tidy/readability-identifier-length",
			severity: "warning",
		});
	});
});
