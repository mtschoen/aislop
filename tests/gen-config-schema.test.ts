import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(PROJECT_ROOT, "scripts", "gen-config-schema.mjs");
const COMMITTED_SCHEMA_PATH = path.join(PROJECT_ROOT, "schema", "aislop.config.schema.json");

let outputDirectory: string;

beforeEach(() => {
	outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-gen-schema-"));
});

afterEach(() => {
	fs.rmSync(outputDirectory, { recursive: true, force: true });
});

describe("gen:schema script", () => {
	// The script imports the TypeScript config schema directly under Node's type
	// stripping, which does not map a ".js" import specifier to its ".ts" file.
	// A relative import inside src/config that works for the bundler can therefore
	// break the script; running it here is what catches that in CI.
	it("runs and writes a schema identical to the committed copy", () => {
		const outputPath = path.join(outputDirectory, "schema.json");
		execFileSync(process.execPath, ["--experimental-strip-types", SCRIPT_PATH, outputPath], {
			cwd: PROJECT_ROOT,
			encoding: "utf-8",
			stdio: "pipe",
		});

		expect(fs.readFileSync(outputPath, "utf-8")).toBe(
			fs.readFileSync(COMMITTED_SCHEMA_PATH, "utf-8"),
		);
	});
});
