import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cppSyncInternalCommand, scaffoldComponentCommand } from "../../src/commands/scaffold.js";

let temporaryDirectory: string;

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-scaffold-"));
});

afterEach(() => {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("scaffold component", () => {
	it("writes owner and guarded fragments in dependency order", () => {
		scaffoldComponentCommand("demo", {
			directory: temporaryDirectory,
			fragments: ["records", "parse"],
		});

		const owner = fs.readFileSync(path.join(temporaryDirectory, "demo.cpp"), "utf-8");
		expect(owner).toContain('#include "demo.h"');
		expect(owner).toContain("#define AISLOP_TU_FRAGMENT");
		expect(owner.indexOf('#include "demo.records.cpp"')).toBeLessThan(
			owner.indexOf('#include "demo.parse.cpp"'),
		);
		expect(owner).toContain("#undef AISLOP_TU_FRAGMENT");

		const fragment = fs.readFileSync(path.join(temporaryDirectory, "demo.records.cpp"), "utf-8");
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
		fs.writeFileSync(
			path.join(temporaryDirectory, ".clangd"),
			"CompileFlags:\n  Add: [-Wall]\nDiagnostics:\n  UnusedIncludes: Strict\n",
			"utf-8",
		);

		scaffoldComponentCommand("demo", { directory: temporaryDirectory, fragments: [] });

		const clangd = fs.readFileSync(path.join(temporaryDirectory, ".clangd"), "utf-8");
		expect(clangd).toContain("-Wall");
		expect(clangd).toContain("-DAISLOP_TU_FRAGMENT");
		expect(clangd).toContain("UnusedIncludes: Strict");
	});
});

describe("cpp sync-internal", () => {
	it("regenerates cross-fragment function declarations deterministically", () => {
		fs.writeFileSync(path.join(temporaryDirectory, "demo.internal.h"), "stale\n", "utf-8");
		fs.writeFileSync(
			path.join(temporaryDirectory, "demo.records.cpp"),
			`#include "demo.internal.h"

namespace {
int LoadRecord(int value) {
	return value + 1;
}

int LocalOnly() {
	return 0;
}
}
`,
			"utf-8",
		);
		fs.writeFileSync(
			path.join(temporaryDirectory, "demo.parse.cpp"),
			`#include "demo.internal.h"

namespace {
int Parse() {
	return LoadRecord(41);
}
}
`,
			"utf-8",
		);

		cppSyncInternalCommand("demo", { directory: temporaryDirectory });
		const first = fs.readFileSync(path.join(temporaryDirectory, "demo.internal.h"), "utf-8");
		cppSyncInternalCommand("demo", { directory: temporaryDirectory });
		const second = fs.readFileSync(path.join(temporaryDirectory, "demo.internal.h"), "utf-8");

		expect(first).toBe(second);
		expect(first).toContain("int LoadRecord(int value);");
		expect(first).not.toContain("LocalOnly");
	});
});
