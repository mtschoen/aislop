import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installGemini,
	resolveGeminiPaths,
	uninstallGemini,
} from "../../src/hooks/install/gemini.js";
import { parseJsonc } from "../../src/utils/read-jsonc.js";

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

describe("installGemini", () => {
	it("writes AfterTool hook and rules file", () => {
		const opts = { home, cwd, scope: "global" as const };
		installGemini(opts);
		const paths = resolveGeminiPaths(opts);
		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(settings.hooks.AfterTool).toHaveLength(1);
		expect(settings.hooks.AfterTool[0].matcher).toBe("write_file|replace");
		expect(settings.hooks.AfterTool[0].hooks[0].command).toBe("aislop hook gemini");
		expect(fs.readFileSync(paths.aislopMd, "utf-8")).toContain("<!-- aislop:begin");
		expect(fs.readFileSync(paths.geminiMd, "utf-8")).toContain("@AISLOP.md");
	});

	it("uninstalls cleanly", () => {
		const opts = { home, cwd, scope: "global" as const };
		installGemini(opts);
		uninstallGemini(opts);
		const paths = resolveGeminiPaths(opts);
		expect(fs.existsSync(paths.aislopMd)).toBe(false);
	});

	it("preserves unrelated settings and hooks across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const initial = {
			theme: "dark",
			hooks: {
				BeforeTool: [{ command: "my-guard", type: "command" }],
			},
		};
		fs.writeFileSync(paths.settings, `${JSON.stringify(initial, null, 2)}\n`);

		installGemini(opts);
		const afterInstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(afterInstall.theme).toBe("dark");
		expect(afterInstall.hooks.BeforeTool).toHaveLength(1);
		expect(afterInstall.hooks.AfterTool).toHaveLength(1);

		uninstallGemini(opts);
		const afterUninstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(afterUninstall.theme).toBe("dark");
		expect(afterUninstall.hooks.BeforeTool).toHaveLength(1);
		expect(afterUninstall.hooks.AfterTool).toBeUndefined();
	});

	it("preserves unrelated commands when sharing a group with an aislop-managed command", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		installGemini(opts);

		// Add custom command to AfterTool group
		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		settings.hooks.AfterTool[0].hooks.push({
			name: "custom-validator",
			type: "command",
			command: "run-custom-validator",
		});
		fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`);

		// Reinstall preserves custom command
		installGemini(opts);
		const afterReinstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		const commands = afterReinstall.hooks.AfterTool.flatMap(
			(g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command),
		);
		expect(commands).toContain("run-custom-validator");
		expect(commands).toContain("aislop hook gemini");

		// Uninstall removes only aislop hook
		uninstallGemini(opts);
		const afterUninstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(afterUninstall.hooks.AfterTool).toHaveLength(1);
		expect(afterUninstall.hooks.AfterTool[0].hooks).toEqual([
			{ name: "custom-validator", type: "command", command: "run-custom-validator" },
		]);
	});

	it("preserves BOM, CRLF line endings, comments, trailing commas, and custom indentation", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const content =
			'\uFEFF// Header comment\r\n{\r\n    /* Theme comment */\r\n    "theme": "light",\r\n    "custom": { "k": "v", },\r\n}\r\n';
		fs.writeFileSync(paths.settings, content, "utf-8");

		installGemini(opts);
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall.startsWith("\uFEFF")).toBe(true);
		expect(rawAfterInstall).toContain("\r\n");
		expect(rawAfterInstall).toContain("// Header comment");
		expect(rawAfterInstall).toContain("/* Theme comment */");
		expect(rawAfterInstall).toContain('    "theme": "light"');
		expect(rawAfterInstall).toContain('    "custom": { "k": "v", }');
		expect(rawAfterInstall).toContain('    "hooks": {');

		uninstallGemini(opts);
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toBe(content);
	});

	it("refuses to overwrite malformed settings.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		fs.writeFileSync(paths.settings, "{ invalid");

		expect(() => installGemini(opts)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe("{ invalid");
	});

	it("refuses to install or uninstall when hooks is not an object", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const invalid = JSON.stringify({ hooks: 123, theme: "dark" });
		fs.writeFileSync(paths.settings, invalid);

		expect(() => installGemini(opts)).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalid);

		expect(() => uninstallGemini(opts)).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalid);
	});

	it("refuses to install or uninstall when hooks.AfterTool is not an array", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const invalid = JSON.stringify({ hooks: { AfterTool: "disabled" }, theme: "dark" });
		fs.writeFileSync(paths.settings, invalid);

		expect(() => installGemini(opts)).toThrow(/expected hooks.AfterTool to be an array/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalid);

		expect(() => uninstallGemini(opts)).toThrow(/expected hooks.AfterTool to be an array/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalid);
	});

	it("preserves comments, trailing commas, and token layout inside AfterTool array across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const contentWithComments =
			"{\r\n" +
			'  "theme": "dark",\r\n' +
			'  "hooks": {\r\n' +
			"    // Comment before AfterTool\r\n" +
			'    "AfterTool": [\r\n' +
			"      // Unrelated AfterTool hook comment\r\n" +
			"      {\r\n" +
			'        "matcher": "custom_tool",\r\n' +
			'        "hooks": [\r\n' +
			"          {\r\n" +
			'            "name": "custom-check",\r\n' +
			'            "type": "command",\r\n' +
			'            "command": "custom-script", // inline comment\r\n' +
			'            "timeout": 3000,\r\n' +
			"          },\r\n" +
			"        ],\r\n" +
			"      },\r\n" +
			"    ]\r\n" +
			"  }\r\n" +
			"}\r\n";
		fs.writeFileSync(paths.settings, contentWithComments, "utf-8");

		installGemini(opts);
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall).toContain("// Comment before AfterTool");
		expect(rawAfterInstall).toContain("// Unrelated AfterTool hook comment");
		expect(rawAfterInstall).toContain('"command": "custom-script", // inline comment');
		expect(rawAfterInstall).toContain('"timeout": 3000,');
		expect(rawAfterInstall).toContain('"matcher": "write_file|replace"');

		uninstallGemini(opts);
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toBe(contentWithComments);
	});

	it("preserves empty settings.json containing only comments across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveGeminiPaths(opts);
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const commentedEmpty =
			"// Top header comment\r\n{\r\n  /* Inside empty object comment */\r\n}\r\n";
		fs.writeFileSync(paths.settings, commentedEmpty, "utf-8");

		installGemini(opts);
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall).toContain("// Top header comment");
		expect(rawAfterInstall).toContain("/* Inside empty object comment */");
		expect(rawAfterInstall).toContain('"hooks": {');

		uninstallGemini(opts);
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toBe(commentedEmpty);
	});
});
