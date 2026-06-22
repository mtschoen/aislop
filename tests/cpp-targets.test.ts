import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCompileCommandsDir, findCppSourcesForRoot } from "../src/engines/cpp-targets.js";

describe("cpp-targets", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cpp-targets-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("collects C/C++ sources and skips build output", () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "a.cpp"), "int a;\n");
		fs.writeFileSync(path.join(tmpDir, "src", "a.h"), "int a;\n");
		fs.mkdirSync(path.join(tmpDir, "build"));
		fs.writeFileSync(path.join(tmpDir, "build", "gen.cpp"), "int g;\n");
		const names = findCppSourcesForRoot(tmpDir)
			.map((f) => path.basename(f))
			.sort();
		expect(names).toEqual(["a.cpp", "a.h"]);
	});

	it("finds compile_commands.json at root or under build/", () => {
		fs.mkdirSync(path.join(tmpDir, "build"));
		fs.writeFileSync(path.join(tmpDir, "build", "compile_commands.json"), "[]\n");
		expect(findCompileCommandsDir({ rootDirectory: tmpDir })).toBe(path.join(tmpDir, "build"));
	});

	it("returns null when compile_commands.json is absent", () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "a.cpp"), "int a;\n");
		expect(findCompileCommandsDir({ rootDirectory: tmpDir })).toBe(null);
	});
});
