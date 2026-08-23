import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cppSyncInternalCommand } from "../../src/commands/cpp-sync-internal.js";

let temporaryDirectory: string;

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cpp-sync-"));
});

afterEach(() => {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

const writeFragment = (name: string, body: string): void => {
	fs.writeFileSync(path.join(temporaryDirectory, name), body, "utf-8");
};

const syncAndRead = (component = "demo"): string => {
	cppSyncInternalCommand(component, { directory: temporaryDirectory });
	return fs.readFileSync(path.join(temporaryDirectory, `${component}.internal.h`), "utf-8");
};

describe("cpp sync-internal", () => {
	it("regenerates cross-fragment function declarations deterministically", () => {
		fs.writeFileSync(path.join(temporaryDirectory, "demo.internal.h"), "stale\n", "utf-8");
		writeFragment(
			"demo.records.cpp",
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
		);
		writeFragment(
			"demo.parse.cpp",
			`#include "demo.internal.h"

namespace {
int Parse() {
	return LoadRecord(41);
}
}
`,
		);

		const first = syncAndRead();
		const second = syncAndRead();

		expect(first).toBe(second);
		expect(first).toContain("int LoadRecord(int value);");
		expect(first).not.toContain("LocalOnly");
	});

	it("declares a helper whose parameter list carries a brace-initialized default", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace {
std::vector<BYTE> ReadRun(const Source& source, Flags flags = {}) {
	return {};
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
void Parse(const Source& source) {
	ReadRun(source);
}
}
`,
		);

		expect(syncAndRead()).toContain(
			"std::vector<BYTE> ReadRun(const Source& source, Flags flags = {});",
		);
	});

	it("declares a helper carrying trailing specifiers beyond const", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace {
std::vector<BYTE> ReadRun(const Source& source) noexcept {
	return {};
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
void Parse(const Source& source) {
	ReadRun(source);
}
}
`,
		);

		const internal = syncAndRead();
		expect(internal).toContain("std::vector<BYTE> ReadRun(const Source& source) noexcept;");
	});

	it("declares a helper written with a trailing return type", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace {
auto ReadRun(const Source& source) -> std::vector<BYTE> {
	return {};
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
void Parse(const Source& source) {
	ReadRun(source);
}
}
`,
		);

		expect(syncAndRead()).toContain("auto ReadRun(const Source& source) -> std::vector<BYTE>;");
	});

	it("declares a helper defined inside an indented namespace block", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace detail {
	std::vector<BYTE> ReadRun(const Source& source) {
		return {};
	}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace detail {
	void Parse(const Source& source) {
		ReadRun(source);
	}
}
`,
		);

		expect(syncAndRead()).toContain("std::vector<BYTE> ReadRun(const Source& source);");
	});

	it("ignores function-shaped text inside comments and string literals", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace {
// std::vector<BYTE> Ghost(const Source& source) {
/* std::string Spectre(int code) {
   } */
const char* kBanner = "std::string Phantom(int code) {";
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
void Parse(const Source& source) {
	Ghost(source);
	Spectre(1);
	Phantom(2);
}
}
`,
		);

		const internal = syncAndRead();
		expect(internal).not.toContain("Ghost");
		expect(internal).not.toContain("Spectre");
		expect(internal).not.toContain("Phantom");
	});

	it("ignores control flow, prototypes, and lambdas", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace {
std::string Prototype(int code);

int Counted(int limit) {
	int total = 0;
	for (int index = 0; index < limit; index += 1) {
		total += index;
	}
	auto Doubler = [](int value) {
		return value * 2;
	};
	return Doubler(total);
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
int Parse() {
	Prototype(1);
	Doubler(2);
	return Counted(3);
}
}
`,
		);

		const internal = syncAndRead();
		expect(internal).toContain("int Counted(int limit);");
		expect(internal).not.toContain("Prototype");
		expect(internal).not.toContain("Doubler");
		expect(internal).not.toContain("for (");
	});

	it("does not mistake a preprocessor function-like macro for a definition", () => {
		writeFragment(
			"demo.records.cpp",
			`#define RETURN_IF_FAILED(expression) { if (!(expression)) return {}; }

namespace {
int Real(int value) {
	return value;
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
int Parse() {
	RETURN_IF_FAILED(true);
	return Real(1);
}
}
`,
		);

		const internal = syncAndRead();
		expect(internal).toContain("int Real(int value);");
		expect(internal).not.toContain("RETURN_IF_FAILED");
	});

	it("ignores qualified member definitions and inline class/struct methods", () => {
		writeFragment(
			"demo.records.cpp",
			`#include "demo.internal.h"

struct Helper {
	int Compute(int x) {
		return x;
	}
	int InlineOther() const {
		return 0;
	}
};

class Parser {
public:
	int ParseHeader() {
		return 1;
	}
};

int Parser::Compute(int x) {
	return x;
}

auto Helper::Calculate() -> int {
	return 42;
}

namespace {
int FreeHelper(int x) {
	return x + 10;
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`#include "demo.internal.h"

namespace {
int Parse(Helper& h, Parser& p) {
	h.Compute(1);
	p.ParseHeader();
	Parser::Compute(2);
	return FreeHelper(3);
}
}
`,
		);

		const internal = syncAndRead();
		expect(internal).toContain("int FreeHelper(int x);");
		expect(internal).not.toContain("Compute");
		expect(internal).not.toContain("InlineOther");
		expect(internal).not.toContain("ParseHeader");
		expect(internal).not.toContain("Calculate");
		expect(internal).not.toContain("Parser::");
		expect(internal).not.toContain("Helper::");
	});

	it("does not pull in declarations when another fragment only accesses a same-named member", () => {
		writeFragment(
			"demo.records.cpp",
			`namespace {
int Load(int x) {
	return x;
}
}
`,
		);
		writeFragment(
			"demo.parse.cpp",
			`namespace {
int Parse(Reader* reader, const Context& context) {
	reader->Load(1);
	context.Load(2);
	return 0;
}
}
`,
		);

		const internal = syncAndRead();
		expect(internal).not.toContain("int Load(int x);");
	});
});
