import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffoldComponentCommand } from "../../src/commands/scaffold.js";

let temporaryDirectory: string;

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-scaffold-"));
});

afterEach(() => {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

const write = (name: string, contents: string): void => {
	fs.writeFileSync(path.join(temporaryDirectory, name), contents, "utf-8");
};

const read = (name: string): string =>
	fs.readFileSync(path.join(temporaryDirectory, name), "utf-8");

describe("scaffold component", () => {
	it("writes owner and guarded fragments in dependency order", () => {
		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records", "parse"],
		});

		const owner = read("demo.cpp");
		expect(owner).toContain('#include "demo.h"');
		expect(owner).toContain("#define AISLOP_TU_FRAGMENT");
		expect(owner.indexOf('#include "demo.records.cpp"')).toBeLessThan(
			owner.indexOf('#include "demo.parse.cpp"'),
		);
		expect(owner).toContain("#undef AISLOP_TU_FRAGMENT");

		const fragment = read("demo.records.cpp");
		expect(fragment).toContain(
			"// Part of the demo component. Included by demo.cpp; do not compile directly.",
		);
		expect(fragment).toContain("#ifndef AISLOP_TU_FRAGMENT");
		expect(fragment).toContain(
			'#error "demo.records.cpp is a fragment included by demo.cpp; do not compile it directly"',
		);
		expect(fragment).toContain('#include "demo.internal.h"');
		expect(fragment).toContain("namespace {");
	});

	it("merges the clangd fragment define without clobbering existing flags", () => {
		write(".clangd", "CompileFlags:\n  Add: [-Wall]\nDiagnostics:\n  UnusedIncludes: Strict\n");

		scaffoldComponentCommand("demo", { directory: temporaryDirectory, fragments: [] });

		const clangd = read(".clangd");
		expect(clangd).toContain("-Wall");
		expect(clangd).toContain("-DAISLOP_TU_FRAGMENT");
		expect(clangd).toContain("UnusedIncludes: Strict");
	});

	it("refuses to touch existing sources and names the adopt flag", () => {
		write("demo.cpp", "int Existing() { return 0; }\n");

		expect(() =>
			scaffoldComponentCommand("demo", { directory: temporaryDirectory, fragments: ["records"] }),
		).toThrow(/demo\.cpp already exists.*--adopt/s);
		expect(read("demo.cpp")).toBe("int Existing() { return 0; }\n");
	});
});

describe("scaffold component --adopt", () => {
	it("keeps existing owner content and threads the fragment block after its includes", () => {
		write(
			"demo.cpp",
			`#include "demo.h"
#include <vector>

int PublicEntry() {
	return 0;
}
`,
		);
		write("demo.h", "#pragma once\n\nint PublicEntry();\n");

		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records", "parse"],
			adopt: true,
		});

		const owner = read("demo.cpp");
		expect(owner).toContain("int PublicEntry() {");
		expect(owner).toContain("#define AISLOP_TU_FRAGMENT");
		expect(owner.indexOf('#include "demo.records.cpp"')).toBeLessThan(
			owner.indexOf('#include "demo.parse.cpp"'),
		);
		expect(owner.indexOf("#include <vector>")).toBeLessThan(
			owner.indexOf("#define AISLOP_TU_FRAGMENT"),
		);
		expect(owner.indexOf("#undef AISLOP_TU_FRAGMENT")).toBeLessThan(
			owner.indexOf("int PublicEntry() {"),
		);
		expect(read("demo.h")).toBe("#pragma once\n\nint PublicEntry();\n");
		expect(fs.existsSync(path.join(temporaryDirectory, "demo.internal.h"))).toBe(true);
	});

	it("is idempotent and folds newly requested fragments into the existing block", () => {
		write("demo.cpp", '#include "demo.h"\n\nint PublicEntry() {\n\treturn 0;\n}\n');

		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records"],
			adopt: true,
		});
		const once = read("demo.cpp");
		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records"],
			adopt: true,
		});
		expect(read("demo.cpp")).toBe(once);

		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records", "parse"],
			adopt: true,
		});
		const owner = read("demo.cpp");
		expect(owner.match(/#define AISLOP_TU_FRAGMENT/g)).toHaveLength(1);
		expect(owner.match(/#include "demo\.records\.cpp"/g)).toHaveLength(1);
		expect(owner).toContain('#include "demo.parse.cpp"');
	});

	it("adds the fragment guard to an existing source adopted as a fragment", () => {
		write("demo.cpp", '#include "demo.h"\n');
		write("demo.records.cpp", "namespace {\nint LoadRecord(int value) {\n\treturn value;\n}\n}\n");

		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records"],
			adopt: true,
		});

		const fragment = read("demo.records.cpp");
		expect(fragment).toContain("#ifndef AISLOP_TU_FRAGMENT");
		expect(fragment).toContain(
			'#error "demo.records.cpp is a fragment included by demo.cpp; do not compile it directly"',
		);
		expect(fragment).toContain('#include "demo.internal.h"');
		expect(fragment).toContain("int LoadRecord(int value) {");
		expect(fragment.indexOf("#ifndef AISLOP_TU_FRAGMENT")).toBeLessThan(
			fragment.indexOf("int LoadRecord"),
		);
	});

	it("does not duplicate a guard or internal include the fragment already has", () => {
		write("demo.cpp", '#include "demo.h"\n');
		write(
			"demo.records.cpp",
			`#ifndef AISLOP_TU_FRAGMENT
#error "demo.records.cpp is a fragment included by demo.cpp; do not compile it directly"
#endif

#include "demo.internal.h"

namespace {
int LoadRecord(int value) {
	return value;
}
}
`,
		);
		const before = read("demo.records.cpp");

		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records"],
			adopt: true,
		});

		expect(read("demo.records.cpp")).toBe(before);
	});

	it("creates a missing owner and public header while adopting the rest", () => {
		write("demo.records.cpp", "int LoadRecord(int value) {\n\treturn value;\n}\n");

		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records"],
			adopt: true,
		});

		expect(read("demo.h")).toContain("#pragma once");
		expect(read("demo.cpp")).toContain('#include "demo.records.cpp"');
		expect(read("demo.records.cpp")).toContain("int LoadRecord(int value) {");
	});
});
