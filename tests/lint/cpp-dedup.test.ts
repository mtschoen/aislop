import { describe, expect, it } from "vitest";
import { dedupeCppDiagnostics } from "../../src/engines/lint/index.js";
import type { Diagnostic } from "../../src/engines/types.js";

const make = (rule: string, file: string, line: number): Diagnostic => ({
	filePath: file,
	engine: "lint",
	rule,
	severity: "warning",
	message: "",
	help: "",
	line,
	column: 1,
	category: "C++ Lint",
	fixable: false,
});

describe("dedupeCppDiagnostics", () => {
	it("collapses cppcheck and clang-tidy findings sharing file:line:bare-rule", () => {
		const result = dedupeCppDiagnostics([
			make("cppcheck/uninitvar", "src\\a.cpp", 5),
			make("clang-tidy/uninitvar", "src/a.cpp", 5), // same logical file+line+bare id
			make("cppcheck/nullPointer", "src/a.cpp", 9),
		]);
		expect(result).toHaveLength(2);
		expect(result[0].rule).toBe("cppcheck/uninitvar");
		expect(result[1].rule).toBe("cppcheck/nullPointer");
	});
});
