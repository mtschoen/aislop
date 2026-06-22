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
});
