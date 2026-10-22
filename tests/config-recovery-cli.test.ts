import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = path.resolve("dist/cli.js");
const WARNING_LINE = "Invalid aislop configuration field";
let root: string;

const run = (command: "scan" | "ci") =>
	spawnSync(process.execPath, [cli, command, ".", "--json"], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, CI: "1", AISLOP_NO_TELEMETRY: "1", AISLOP_NO_UPDATE_NOTIFIER: "1" },
	});

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

const writeConfig = (content: string) =>
	fs.writeFileSync(path.join(root, ".aislop", "config.yml"), content);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-config-recovery-"));
	fs.mkdirSync(path.join(root, ".aislop"));
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x", private: true }));
	fs.writeFileSync(path.join(root, "index.ts"), "export const value = 1;\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const INVALID_OVERRIDE = "version: 1\noverrides:\n  - engines:\n      lint: false\n";

describe("config recovery in the CLI", () => {
	it("prints each config warning exactly once per scan", () => {
		writeConfig(INVALID_OVERRIDE);
		const result = run("scan");
		expect(result.status).toBe(0);
		expect(occurrences(result.stderr, WARNING_LINE)).toBe(1);
	});

	it("fails ci after recovering an invalid field, naming the file and field once", () => {
		writeConfig(INVALID_OVERRIDE);
		const result = run("ci");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(path.join(root, ".aislop", "config.yml"));
		expect(result.stderr).toContain("overrides.0.files");
		expect(occurrences(result.stderr, WARNING_LINE)).toBe(1);
	});

	it("fails ci when the config cannot be parsed", () => {
		writeConfig("version: 1\nengines: [unclosed\n");
		const result = run("ci");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(path.join(root, ".aislop", "config.yml"));
		expect(occurrences(result.stderr, "Failed to parse")).toBe(1);
	});

	it("keeps scan warning-only for an unparseable config", () => {
		writeConfig("version: 1\nengines: [unclosed\n");
		expect(run("scan").status).toBe(0);
	});

	it("passes ci with a valid config", () => {
		writeConfig("version: 1\n");
		const result = run("ci");
		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain(WARNING_LINE);
	});

	it("passes ci when no config file exists", () => {
		fs.rmSync(path.join(root, ".aislop"), { recursive: true });
		expect(run("ci").status).toBe(0);
	});
});
