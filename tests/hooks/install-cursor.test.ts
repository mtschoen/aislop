import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installCursor,
	resolveCursorPaths,
	uninstallCursor,
} from "../../src/hooks/install/cursor.js";

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

describe("installCursor global", () => {
	it("writes afterFileEdit hook to ~/.cursor/hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const result = installCursor(opts);
		const paths = resolveCursorPaths(opts);
		expect(result.wrote).toContain(paths.hooks);
		const parsed = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		expect(parsed.version).toBe(1);
		expect(parsed.hooks.afterFileEdit).toHaveLength(1);
		expect(parsed.hooks.afterFileEdit[0].command).toBe("aislop hook cursor");
		expect(parsed.hooks.afterFileEdit[0].__aislop.managed).toBe(true);
	});

	it("is idempotent", () => {
		const opts = { home, cwd, scope: "global" as const };
		installCursor(opts);
		const second = installCursor(opts);
		expect(second.wrote).toHaveLength(0);
	});
});

describe("installCursor project", () => {
	it("writes hooks.json and .cursor/rules/aislop.mdc", () => {
		const opts = { home, cwd, scope: "project" as const };
		const result = installCursor(opts);
		const paths = resolveCursorPaths(opts);
		expect(result.wrote).toContain(paths.hooks);
		expect(result.wrote).toContain(paths.rules);
		expect(fs.existsSync(paths.rules)).toBe(true);
	});
});

describe("uninstallCursor", () => {
	it("removes the afterFileEdit hook", () => {
		const opts = { home, cwd, scope: "global" as const };
		installCursor(opts);
		uninstallCursor(opts);
		const paths = resolveCursorPaths(opts);
		expect(fs.existsSync(paths.hooks)).toBe(false);
	});

	it("preserves unrelated afterFileEdit hooks", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		fs.writeFileSync(
			paths.hooks,
			JSON.stringify(
				{
					version: 1,
					hooks: {
						afterFileEdit: [{ command: "my-other-tool", type: "command" }],
					},
				},
				null,
				2,
			),
		);
		installCursor(opts);
		uninstallCursor(opts);
		const after = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		expect(after.hooks.afterFileEdit).toHaveLength(1);
		expect(after.hooks.afterFileEdit[0].command).toBe("my-other-tool");
	});

	it("preserves BOM, CRLF line endings, comments, trailing commas, and custom indentation in hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const content =
			'\uFEFF// Header comment\r\n{\r\n    /* Version comment */\r\n    "version": 1,\r\n    "customKey": "preserved",\r\n    "extra": { "test": 123, },\r\n}\r\n';
		fs.writeFileSync(paths.hooks, content, "utf-8");

		installCursor(opts);
		const rawAfterInstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterInstall.startsWith("\uFEFF")).toBe(true);
		expect(rawAfterInstall).toContain("\r\n");
		expect(rawAfterInstall).toContain("// Header comment");
		expect(rawAfterInstall).toContain("/* Version comment */");
		expect(rawAfterInstall).toContain('    "customKey": "preserved"');
		expect(rawAfterInstall).toContain('    "extra": { "test": 123, }');
		expect(rawAfterInstall).toContain('    "hooks": {');

		uninstallCursor(opts);
		const rawAfterUninstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterUninstall).toBe(content);
	});

	it("refuses to overwrite malformed hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		fs.writeFileSync(paths.hooks, "{ invalid");

		expect(() => installCursor(opts)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe("{ invalid");
	});

	it("refuses to install or uninstall when hooks is not an object", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const invalid = JSON.stringify({ version: 1, hooks: 123 });
		fs.writeFileSync(paths.hooks, invalid);

		expect(() => installCursor(opts)).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);

		expect(() => uninstallCursor(opts)).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);
	});

	it("refuses to install or uninstall when hooks.afterFileEdit is not an array", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const invalid = JSON.stringify({ version: 1, hooks: { afterFileEdit: true } });
		fs.writeFileSync(paths.hooks, invalid);

		expect(() => installCursor(opts)).toThrow(/expected hooks.afterFileEdit to be an array/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);

		expect(() => uninstallCursor(opts)).toThrow(/expected hooks.afterFileEdit to be an array/);
		expect(fs.readFileSync(paths.hooks, "utf-8")).toBe(invalid);
	});

	it("preserves comments, trailing commas, and token layout inside afterFileEdit array across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const contentWithComments =
			"{\r\n" +
			'  "version": 1,\r\n' +
			'  "customKey": "keep-me",\r\n' +
			'  "hooks": {\r\n' +
			"    // Comment before afterFileEdit\r\n" +
			'    "afterFileEdit": [\r\n' +
			"      // Unrelated afterFileEdit hook comment\r\n" +
			"      {\r\n" +
			'        "type": "command",\r\n' +
			'        "command": "custom-linter", // inline comment\r\n' +
			'        "timeout": 2000,\r\n' +
			"      },\r\n" +
			"    ]\r\n" +
			"  }\r\n" +
			"}\r\n";
		fs.writeFileSync(paths.hooks, contentWithComments, "utf-8");

		installCursor(opts);
		const rawAfterInstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterInstall).toContain("// Comment before afterFileEdit");
		expect(rawAfterInstall).toContain("// Unrelated afterFileEdit hook comment");
		expect(rawAfterInstall).toContain('"command": "custom-linter", // inline comment');
		expect(rawAfterInstall).toContain('"timeout": 2000,');
		expect(rawAfterInstall).toContain('"command": "aislop hook cursor"');

		uninstallCursor(opts);
		const rawAfterUninstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterUninstall).toBe(contentWithComments);
	});

	it("preserves empty hooks.json containing only comments across install and uninstall", () => {
		const opts = { home, cwd, scope: "global" as const };
		const paths = resolveCursorPaths(opts);
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		const commentedEmpty =
			"// Top header comment\r\n{\r\n  /* Inside empty object comment */\r\n}\r\n";
		fs.writeFileSync(paths.hooks, commentedEmpty, "utf-8");

		installCursor(opts);
		const rawAfterInstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterInstall).toContain("// Top header comment");
		expect(rawAfterInstall).toContain("/* Inside empty object comment */");
		expect(rawAfterInstall).toContain('"hooks": {');

		uninstallCursor(opts);
		const rawAfterUninstall = fs.readFileSync(paths.hooks, "utf-8");
		expect(rawAfterUninstall).toBe(commentedEmpty);
	});
});
