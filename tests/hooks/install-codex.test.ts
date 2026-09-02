import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	hasManagedCodexHook,
	installCodex,
	resolveCodexPaths,
	uninstallCodex,
} from "../../src/hooks/install/codex.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("installCodex global", () => {
	it("writes hooks.json and AGENTS.md on fresh install", () => {
		const opts = { home, cwd, scope: "global" as const };
		const result = installCodex(opts);
		const paths = resolveCodexPaths(opts);

		expect(result.wrote).toContain(paths.hooks);
		expect(result.wrote).toContain(paths.rules);

		const hooks = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		expect(hooks.hooks.PostToolUse).toHaveLength(1);
		expect(hooks.hooks.PostToolUse[0].matcher).toBe("apply_patch");
		expect(hooks.hooks.PostToolUse[0].hooks[0].command).toBe("aislop hook codex");
		expect(hasManagedCodexHook(fs.readFileSync(paths.hooks, "utf-8"))).toBe(true);

		const rules = fs.readFileSync(paths.rules, "utf-8");
		expect(rules).toContain("aislop");
	});

	it("is idempotent across repeated runs", () => {
		const opts = { home, cwd, scope: "global" as const };
		installCodex(opts);
		const second = installCodex(opts);
		expect(second.wrote).toHaveLength(0);
	});

	it("preserves unrelated commands in the same hook group across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		installCodex(opts);

		// Add custom command to PostToolUse group
		const hooks = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		hooks.hooks.PostToolUse[0].hooks.push({
			type: "command",
			command: "my-custom-patch-validator",
		});
		fs.writeFileSync(paths.hooks, `${JSON.stringify(hooks, null, 2)}\n`);

		// Reinstall preserves custom command
		installCodex(opts);
		const afterReinstall = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		const commands = afterReinstall.hooks.PostToolUse.flatMap(
			(g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command),
		);
		expect(commands).toContain("my-custom-patch-validator");
		expect(commands).toContain("aislop hook codex");

		// Uninstall removes only the aislop command and preserves custom command
		uninstallCodex(opts);
		const afterUninstall = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		expect(afterUninstall.hooks.PostToolUse).toHaveLength(1);
		expect(afterUninstall.hooks.PostToolUse[0].hooks).toEqual([
			{ type: "command", command: "my-custom-patch-validator" },
		]);
	});

	it("preserves BOM, CRLF line endings, comments, trailing commas, and custom indentation in hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const content =
			'\uFEFF// Header comment\r\n{\r\n    /* Custom comment */\r\n    "customSetting": true,\r\n    "extra": { "k": "v", },\r\n}\r\n';
		fs.writeFileSync(paths.hooks, content, "utf-8");

		installCodex(opts);
		const rawAfterInstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterInstall.startsWith("\uFEFF")).toBe(true);
		expect(rawAfterInstall).toContain("\r\n");
		expect(rawAfterInstall).toContain("// Header comment");
		expect(rawAfterInstall).toContain("/* Custom comment */");
		expect(rawAfterInstall).toContain('    "customSetting": true');
		expect(rawAfterInstall).toContain('    "extra": { "k": "v", }');
		expect(rawAfterInstall).toContain('    "hooks": {');

		uninstallCodex(opts);
		const rawAfterUninstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterUninstall).toBe(content);
	});

	it("refuses to overwrite malformed hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		fs.writeFileSync(paths.hooks, "{ invalid json ::: ");

		expect(() => installCodex(opts)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe("{ invalid json ::: ");
	});

	it("refuses to install or uninstall when hooks is not an object", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const invalid = JSON.stringify({ hooks: "disabled" });
		fs.writeFileSync(paths.hooks, invalid);

		expect(() => installCodex(opts)).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);

		expect(() => uninstallCodex(opts)).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);
	});

	it("refuses to install or uninstall when hooks.PostToolUse is not an array", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const invalid = JSON.stringify({ hooks: { PostToolUse: {} } });
		fs.writeFileSync(paths.hooks, invalid);

		expect(() => installCodex(opts)).toThrow(/expected hooks.PostToolUse to be an array/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);

		expect(() => uninstallCodex(opts)).toThrow(/expected hooks.PostToolUse to be an array/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);
	});

	it("preserves comments, trailing commas, and token layout inside PostToolUse array across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const contentWithComments =
			"{\r\n" +
			'  "customSetting": true,\r\n' +
			'  "hooks": {\r\n' +
			"    // Targeted array comment\r\n" +
			'    "PostToolUse": [\r\n' +
			"      // Unrelated hook comment\r\n" +
			"      {\r\n" +
			'        "matcher": "custom_matcher",\r\n' +
			'        "hooks": [\r\n' +
			"          {\r\n" +
			'            "type": "command",\r\n' +
			'            "command": "custom-cmd", // inline hook comment\r\n' +
			'            "timeout": 30,\r\n' +
			"          },\r\n" +
			"        ],\r\n" +
			"      },\r\n" +
			"    ]\r\n" +
			"  }\r\n" +
			"}\r\n";
		fs.writeFileSync(paths.hooks, contentWithComments, "utf-8");

		installCodex(opts);
		const rawAfterInstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterInstall).toContain("// Targeted array comment");
		expect(rawAfterInstall).toContain("// Unrelated hook comment");
		expect(rawAfterInstall).toContain('"command": "custom-cmd", // inline hook comment');
		expect(rawAfterInstall).toContain('"timeout": 30,');
		expect(rawAfterInstall).toContain('"matcher": "apply_patch"');

		uninstallCodex(opts);
		const rawAfterUninstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterUninstall).toBe(contentWithComments);
	});

	it("preserves empty hooks.json containing only comments across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCodexPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const commentedEmpty =
			"// Top header comment\r\n{\r\n  /* Inside empty object comment */\r\n}\r\n";
		fs.writeFileSync(paths.hooks, commentedEmpty, "utf-8");

		installCodex(opts);
		const rawAfterInstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterInstall).toContain("// Top header comment");
		expect(rawAfterInstall).toContain("/* Inside empty object comment */");
		expect(rawAfterInstall).toContain('"hooks": {');

		uninstallCodex(opts);
		const rawAfterUninstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterUninstall).toBe(commentedEmpty);
	});
});
