import { describe, expect, it } from "vitest";
import {
	buildCppcheckArgs,
	CPP_LINT_DEFAULTS,
	parseCppcheckXml,
} from "../../src/engines/lint/cppcheck.js";

describe("buildCppcheckArgs", () => {
	it("passes --language=c++ for a C++ tree and suppresses parse-context diagnostics", () => {
		const args = buildCppcheckArgs(["/p/a.cpp", "/p/a.h"], CPP_LINT_DEFAULTS);
		expect(args).toContain("--language=c++");
		expect(args).toContain("--suppress=syntaxError");
		expect(args).toContain("--suppress=unknownMacro");
		expect(args).toContain(`--enable=${CPP_LINT_DEFAULTS.cppcheckEnable}`);
		// sources come last, after the flags.
		expect(args.slice(-2)).toEqual(["/p/a.cpp", "/p/a.h"]);
	});

	it("omits --language=c++ for a pure C tree", () => {
		const args = buildCppcheckArgs(["/p/a.c", "/p/a.h"], CPP_LINT_DEFAULTS);
		expect(args).not.toContain("--language=c++");
		// parse-context suppressions still apply regardless of language.
		expect(args).toContain("--suppress=syntaxError");
	});
});

const XML = `<?xml version="1.0"?>
<results version="2">
  <cppcheck version="2.13"/>
  <errors>
    <error id="nullPointer" severity="error" msg="Null pointer dereference: p">
      <location file="src/foo.cpp" line="42" column="5"/>
    </error>
    <error id="unreadVariable" severity="style" msg="Variable 'x' is assigned a value that is never used.">
      <location file="src/foo.cpp" line="10" column="3"/>
    </error>
    <error id="missingIncludeSystem" severity="information" msg="ignored">
      <location file="src/foo.cpp" line="1" column="1"/>
    </error>
    <error id="noLoc" severity="error" msg="no location element"/>
  </errors>
</results>`;

describe("parseCppcheckXml", () => {
	it("maps errors, downgrades non-error severities to warning, drops information and locationless", () => {
		const diags = parseCppcheckXml(XML, "/repo");
		expect(diags).toHaveLength(2);
		expect(diags[0]).toMatchObject({
			filePath: "src/foo.cpp",
			engine: "lint",
			rule: "cppcheck/nullPointer",
			severity: "error",
			line: 42,
			column: 5,
			category: "C++ Lint",
			fixable: false,
		});
		expect(diags[1]).toMatchObject({ rule: "cppcheck/unreadVariable", severity: "warning" });
	});

	it("returns [] on empty or junk input", () => {
		expect(parseCppcheckXml("", "/repo")).toEqual([]);
		expect(parseCppcheckXml("not xml", "/repo")).toEqual([]);
	});
});
