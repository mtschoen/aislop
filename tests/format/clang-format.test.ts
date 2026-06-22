import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults.js";
import { hasClangFormatConfig, runClangFormat } from "../../src/engines/format/clang-format.js";
import type { EngineContext } from "../../src/engines/types.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-clang-format-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const makeContext = (
	rootDirectory: string,
	overrides: Partial<EngineContext> = {},
): EngineContext => ({
	rootDirectory,
	languages: ["cpp"],
	frameworks: [],
	installedTools: { "clang-format": true },
	config: {
		quality: DEFAULT_CONFIG.quality,
		security: DEFAULT_CONFIG.security,
		lint: DEFAULT_CONFIG.lint,
	},
	...overrides,
});

describe("hasClangFormatConfig", () => {
	it("detects a .clang-format file", () => {
		fs.writeFileSync(path.join(tmpDir, ".clang-format"), "BasedOnStyle: Google\n");
		expect(hasClangFormatConfig(tmpDir)).toBe(true);
	});

	it("detects a _clang-format file", () => {
		fs.writeFileSync(path.join(tmpDir, "_clang-format"), "BasedOnStyle: LLVM\n");
		expect(hasClangFormatConfig(tmpDir)).toBe(true);
	});

	it("returns false when no config is present", () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "a.cpp"), "int a;\n");
		expect(hasClangFormatConfig(tmpDir)).toBe(false);
	});
});

describe("runClangFormat", () => {
	it("returns [] when no .clang-format is present", async () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "a.cpp"), "int  a ;\n");
		const context = makeContext(tmpDir);
		expect(await runClangFormat(context)).toEqual([]);
	});
});
