import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	installClaude,
	resolveClaudePaths,
	uninstallClaude,
} from "../../src/hooks/install/claude.js";
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

const globalOpts = () => ({ home, cwd, scope: "global" as const });
const projectOpts = () => ({ home, cwd, scope: "project" as const });

describe("installClaude global", () => {
	it("writes settings.json, AISLOP.md, and CLAUDE.md on fresh install", () => {
		const result = installClaude(globalOpts());
		const paths = resolveClaudePaths(globalOpts());

		expect(result.wrote).toContain(paths.settings);
		expect(result.wrote).toContain(paths.aislopMd);
		expect(result.wrote).toContain(paths.claudeMd);

		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(settings.hooks.PostToolUse).toHaveLength(1);
		expect(settings.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit");
		expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("aislop hook claude");
		expect(settings.hooks.PostToolUse[0].hooks[0].__aislop.managed).toBe(true);

		const md = fs.readFileSync(paths.aislopMd, "utf-8");
		expect(md).toContain("<!-- aislop:begin v1");
		expect(md).toContain("<!-- aislop:end v1 -->");

		const claudeMd = fs.readFileSync(paths.claudeMd, "utf-8");
		expect(claudeMd).toContain("@AISLOP.md");
	});

	it("registers a FileChanged hook for the aislop config + manifest files", () => {
		installClaude(globalOpts());
		const paths = resolveClaudePaths(globalOpts());
		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(settings.hooks.FileChanged).toHaveLength(1);
		expect(settings.hooks.FileChanged[0].matcher).toBe(
			".aislop/config.yml|.aislop/rules.yml|package.json",
		);
		expect(settings.hooks.FileChanged[0].hooks[0].command).toBe(
			"aislop hook claude --on-file-changed",
		);
		expect(settings.hooks.FileChanged[0].hooks[0].__aislop.managed).toBe(true);
	});

	it("is idempotent across repeated runs", () => {
		installClaude(globalOpts());
		const second = installClaude(globalOpts());
		expect(second.wrote).toHaveLength(0);
	});

	it("preserves unrelated PostToolUse hooks", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const userSettings = {
			hooks: {
				PostToolUse: [
					{
						matcher: "Bash",
						hooks: [{ type: "command", command: "my-other-tool" }],
					},
				],
			},
		};
		fs.writeFileSync(paths.settings, `${JSON.stringify(userSettings, null, 2)}\n`);

		installClaude(globalOpts());
		const after = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(after.hooks.PostToolUse).toHaveLength(2);
		const userHook = after.hooks.PostToolUse.find((g: { matcher: string }) => g.matcher === "Bash");
		expect(userHook).toBeDefined();
		expect(userHook.hooks[0].command).toBe("my-other-tool");
	});

	it("appends @AISLOP.md only once to CLAUDE.md", () => {
		installClaude(globalOpts());
		installClaude(globalOpts());
		const paths = resolveClaudePaths(globalOpts());
		const content = fs.readFileSync(paths.claudeMd, "utf-8");
		const matches = content.match(/@AISLOP\.md/g) ?? [];
		expect(matches).toHaveLength(1);
	});

	it("respects existing CLAUDE.md content", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.claudeMd), { recursive: true });
		fs.writeFileSync(paths.claudeMd, "# My prior rules\n\nDo not delete me.\n");

		installClaude(globalOpts());
		const content = fs.readFileSync(paths.claudeMd, "utf-8");
		expect(content).toContain("My prior rules");
		expect(content).toContain("Do not delete me.");
		expect(content).toContain("@AISLOP.md");
	});
});

describe("installClaude project scope", () => {
	it("writes to .claude/ inside cwd", () => {
		const result = installClaude(projectOpts());
		const paths = resolveClaudePaths(projectOpts());
		expect(paths.settings.startsWith(path.join(cwd, ".claude"))).toBe(true);
		expect(result.wrote).toContain(paths.settings);
	});
});

describe("installClaude dry-run", () => {
	it("records planned writes without touching disk", () => {
		const result = installClaude({ ...globalOpts(), dryRun: true });
		expect(result.wrote).toHaveLength(0);
		expect(result.planned.length).toBeGreaterThan(0);
		const paths = resolveClaudePaths(globalOpts());
		expect(fs.existsSync(paths.settings)).toBe(false);
	});
});

describe("installClaude quality gate", () => {
	it("adds a Stop hook when qualityGate=true", () => {
		installClaude({ ...globalOpts(), qualityGate: true });
		const paths = resolveClaudePaths(globalOpts());
		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(settings.hooks.Stop).toHaveLength(1);
		expect(settings.hooks.Stop[0].hooks[0].command).toBe("aislop hook claude --stop");
	});

	it("removes the Stop hook when qualityGate is disabled on reinstall", () => {
		installClaude({ ...globalOpts(), qualityGate: true });
		installClaude(globalOpts());
		const paths = resolveClaudePaths(globalOpts());
		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(settings.hooks.Stop).toBeUndefined();
	});
});

describe("uninstallClaude", () => {
	it("removes PostToolUse + FileChanged hooks and deletes AISLOP.md", () => {
		installClaude(globalOpts());
		const result = uninstallClaude(globalOpts());
		const paths = resolveClaudePaths(globalOpts());
		expect(fs.existsSync(paths.aislopMd)).toBe(false);
		expect(result.removed).toContain(paths.aislopMd);
		// settings.json becomes empty after both aislop entries are removed → file is deleted per spec
		expect(fs.existsSync(paths.settings)).toBe(false);
		expect(result.removed).toContain(paths.settings);
	});

	it("preserves unrelated FileChanged hooks during uninstall", () => {
		const paths = resolveClaudePaths(globalOpts());
		installClaude(globalOpts());
		const current = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		current.hooks.FileChanged.push({
			matcher: ".envrc",
			hooks: [{ type: "command", command: "my-direnv-handler" }],
		});
		fs.writeFileSync(paths.settings, `${JSON.stringify(current, null, 2)}\n`);

		uninstallClaude(globalOpts());
		const after = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(after.hooks.FileChanged).toHaveLength(1);
		expect(after.hooks.FileChanged[0].matcher).toBe(".envrc");
	});

	it("preserves unrelated PostToolUse hooks during uninstall", () => {
		const paths = resolveClaudePaths(globalOpts());
		installClaude(globalOpts());
		const current = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		current.hooks.PostToolUse.push({
			matcher: "Bash",
			hooks: [{ type: "command", command: "my-other-tool" }],
		});
		fs.writeFileSync(paths.settings, `${JSON.stringify(current, null, 2)}\n`);

		uninstallClaude(globalOpts());
		const after = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(after.hooks.PostToolUse).toHaveLength(1);
		expect(after.hooks.PostToolUse[0].matcher).toBe("Bash");
	});

	it("removes @AISLOP.md from CLAUDE.md while preserving user content", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.claudeMd), { recursive: true });
		fs.writeFileSync(paths.claudeMd, "# My rules\n\nKeep me.\n");
		installClaude(globalOpts());
		uninstallClaude(globalOpts());
		const content = fs.readFileSync(paths.claudeMd, "utf-8");
		expect(content).toContain("My rules");
		expect(content).toContain("Keep me.");
		expect(content).not.toContain("@AISLOP.md");
	});

	it("preserves all top-level settings and unrelated hook events across install and uninstall", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const initialSettings = {
			statusLine: "custom-status",
			subagentStatusLine: "custom-subagent",
			env: { FOO: "bar" },
			permissions: { allow: ["read"] },
			cleanupPeriodDays: 30,
			deniedMcpServers: ["untrusted"],
			extraKnownMarketplaces: { corp: "https://example.com" },
			hooks: {
				SessionStart: [
					{ matcher: "", hooks: [{ type: "command", command: "replica memory sync" }] },
				],
				SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "replica memory sync" }] }],
				UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "prompt-guard" }] }],
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "pre-bash" }] }],
				PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-bash-tool" }] }],
			},
		};
		fs.writeFileSync(paths.settings, `${JSON.stringify(initialSettings, null, 2)}\n`);

		installClaude(globalOpts());
		const afterInstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(afterInstall.statusLine).toBe("custom-status");
		expect(afterInstall.subagentStatusLine).toBe("custom-subagent");
		expect(afterInstall.env).toEqual({ FOO: "bar" });
		expect(afterInstall.permissions).toEqual({ allow: ["read"] });
		expect(afterInstall.cleanupPeriodDays).toBe(30);
		expect(afterInstall.deniedMcpServers).toEqual(["untrusted"]);
		expect(afterInstall.extraKnownMarketplaces).toEqual({ corp: "https://example.com" });
		expect(afterInstall.hooks.SessionStart).toHaveLength(1);
		expect(afterInstall.hooks.SessionEnd).toHaveLength(1);
		expect(afterInstall.hooks.UserPromptSubmit).toHaveLength(1);
		expect(afterInstall.hooks.PreToolUse).toHaveLength(1);
		expect(afterInstall.hooks.PostToolUse).toHaveLength(2);
		expect(afterInstall.hooks.FileChanged).toHaveLength(1);

		uninstallClaude(globalOpts());
		const afterUninstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(afterUninstall.statusLine).toBe("custom-status");
		expect(afterUninstall.subagentStatusLine).toBe("custom-subagent");
		expect(afterUninstall.env).toEqual({ FOO: "bar" });
		expect(afterUninstall.permissions).toEqual({ allow: ["read"] });
		expect(afterUninstall.cleanupPeriodDays).toBe(30);
		expect(afterUninstall.deniedMcpServers).toEqual(["untrusted"]);
		expect(afterUninstall.extraKnownMarketplaces).toEqual({ corp: "https://example.com" });
		expect(afterUninstall.hooks.SessionStart).toHaveLength(1);
		expect(afterUninstall.hooks.SessionEnd).toHaveLength(1);
		expect(afterUninstall.hooks.UserPromptSubmit).toHaveLength(1);
		expect(afterUninstall.hooks.PreToolUse).toHaveLength(1);
		expect(afterUninstall.hooks.PostToolUse).toHaveLength(1);
		expect(afterUninstall.hooks.PostToolUse[0].matcher).toBe("Bash");
		expect(afterUninstall.hooks.FileChanged).toBeUndefined();
	});

	it("preserves settings.json with UTF-8 BOM, comments, and trailing commas", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const bomSettings =
			'\uFEFF// Top level comment\r\n{\r\n  /* Status comment */\r\n  "statusLine": "active",\r\n  "env": { "TEST": "1", },\r\n}\r\n';
		fs.writeFileSync(paths.settings, bomSettings, "utf-8");

		installClaude(globalOpts());
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall.startsWith("\uFEFF")).toBe(true);
		expect(rawAfterInstall).toContain("\r\n");
		expect(rawAfterInstall).toContain("// Top level comment");
		expect(rawAfterInstall).toContain("/* Status comment */");
		expect(rawAfterInstall).toContain('"statusLine": "active"');
		expect(rawAfterInstall).toContain('"env": { "TEST": "1", }');
		const afterInstall = parseJsonc(rawAfterInstall) as Record<string, unknown>;
		expect(afterInstall.statusLine).toBe("active");
		expect(afterInstall.env).toEqual({ TEST: "1" });
		expect((afterInstall.hooks as Record<string, unknown[]>).PostToolUse).toHaveLength(1);

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toBe(bomSettings);
	});

	it("preserves 4-space indentation across install and uninstall", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const formatted =
			'{\n    "statusLine": "custom",\n    "env": {\n        "KEY": "val"\n    }\n}\n';
		fs.writeFileSync(paths.settings, formatted, "utf-8");

		installClaude(globalOpts());
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall).toContain('    "statusLine": "custom"');
		expect(rawAfterInstall).toContain('    "hooks": {');

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toContain('    "statusLine": "custom"');
	});

	it("preserves unrelated commands when sharing a group with an aislop-managed command", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });

		// Install aislop first
		installClaude(globalOpts());

		// User adds a custom command to the same matcher group
		const settings = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		settings.hooks.PostToolUse[0].hooks.push({
			type: "command",
			command: "prettier --write",
		});
		fs.writeFileSync(paths.settings, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");

		// Reinstalling should preserve the user's command
		installClaude(globalOpts());
		const afterReinstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		const postToolUseReinstall = afterReinstall.hooks.PostToolUse;
		const allCommands = postToolUseReinstall.flatMap((g: { hooks: Array<{ command: string }> }) =>
			g.hooks.map((h) => h.command),
		);
		expect(allCommands).toContain("prettier --write");
		expect(allCommands).toContain("aislop hook claude");

		// Uninstalling should remove the aislop command but keep the user's prettier hook in place
		uninstallClaude(globalOpts());
		const afterUninstall = JSON.parse(fs.readFileSync(paths.settings, "utf-8"));
		expect(afterUninstall.hooks.PostToolUse).toHaveLength(1);
		expect(afterUninstall.hooks.PostToolUse[0].hooks).toEqual([
			{ type: "command", command: "prettier --write" },
		]);
	});

	it("refuses to overwrite malformed settings.json and leaves the file untouched", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		fs.writeFileSync(paths.settings, "{ invalid json ::: ");

		expect(() => installClaude(globalOpts())).toThrow(/invalid JSON/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe("{ invalid json ::: ");
	});

	it("refuses to uninstall from malformed settings.json and leaves the file untouched", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		fs.writeFileSync(paths.settings, "{ invalid json ::: ");

		expect(() => uninstallClaude(globalOpts())).toThrow(/invalid JSON/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe("{ invalid json ::: ");
	});

	it("refuses to install or uninstall when hooks is not an object", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const invalidHooks = JSON.stringify({ hooks: "disabled", statusLine: true });
		fs.writeFileSync(paths.settings, invalidHooks);

		expect(() => installClaude(globalOpts())).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalidHooks);

		expect(() => uninstallClaude(globalOpts())).toThrow(/expected hooks to be a JSON object/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalidHooks);
	});

	it("refuses to install or uninstall when targeted hook event is not an array", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const invalidEvent = JSON.stringify({ hooks: { PostToolUse: 123 }, statusLine: true });
		fs.writeFileSync(paths.settings, invalidEvent);

		expect(() => installClaude(globalOpts())).toThrow(/expected hooks.PostToolUse to be an array/);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalidEvent);

		expect(() => uninstallClaude(globalOpts())).toThrow(
			/expected hooks.PostToolUse to be an array/,
		);
		expect(fs.readFileSync(paths.settings, "utf-8")).toBe(invalidEvent);
	});

	it("preserves comments, trailing commas, and token layout attached to unrelated entries inside targeted arrays across install and uninstall", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const contentWithTargetedArrayComments =
			"{\r\n" +
			'  "statusLine": "active",\r\n' +
			'  "hooks": {\r\n' +
			"    // Comment before PostToolUse\r\n" +
			'    "PostToolUse": [\r\n' +
			"      // Unrelated Bash hook comment\r\n" +
			"      {\r\n" +
			"        /* Matcher block comment */\r\n" +
			'        "matcher": "Bash",\r\n' +
			'        "hooks": [\r\n' +
			"          {\r\n" +
			'            "type": "command",\r\n' +
			'            "command": "echo hello", // inline command comment\r\n' +
			'            "timeout": 10,\r\n' +
			"          },\r\n" +
			"        ],\r\n" +
			"      },\r\n" +
			"    ],\r\n" +
			'    "SessionStart": [\r\n' +
			'      { "type": "command", "command": "init.sh" }\r\n' +
			"    ]\r\n" +
			"  }\r\n" +
			"}\r\n";
		fs.writeFileSync(paths.settings, contentWithTargetedArrayComments, "utf-8");

		installClaude(globalOpts());
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall).toContain("// Comment before PostToolUse");
		expect(rawAfterInstall).toContain("// Unrelated Bash hook comment");
		expect(rawAfterInstall).toContain("/* Matcher block comment */");
		expect(rawAfterInstall).toContain('"command": "echo hello", // inline command comment');
		expect(rawAfterInstall).toContain('"timeout": 10,');
		expect(rawAfterInstall).toContain('"matcher": "Edit|Write|MultiEdit"');
		expect(rawAfterInstall).toContain('"command": "aislop hook claude"');

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toBe(contentWithTargetedArrayComments);
	});

	it("preserves empty settings.json containing only comments across install and uninstall", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const commentedEmpty =
			"// Top header comment\r\n{\r\n  /* Inside empty object comment */\r\n}\r\n";
		fs.writeFileSync(paths.settings, commentedEmpty, "utf-8");

		installClaude(globalOpts());
		const rawAfterInstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterInstall).toContain("// Top header comment");
		expect(rawAfterInstall).toContain("/* Inside empty object comment */");
		expect(rawAfterInstall).toContain('"hooks": {');

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toBe(commentedEmpty);
	});

	it("keeps a comment on the opening bracket line of an event array whose only entry was removed", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const withOpenBracketComment =
			"{\n" +
			'  "statusLine": "keep me",\n' +
			'  "hooks": {\n' +
			'    "PostToolUse": [ // keep me\n' +
			"      {\n" +
			'        "matcher": "Edit|Write|MultiEdit",\n' +
			'        "hooks": [\n' +
			"          {\n" +
			'            "type": "command",\n' +
			'            "command": "aislop hook claude",\n' +
			'            "__aislop": { "managed": true }\n' +
			"          }\n" +
			"        ]\n" +
			"      }\n" +
			"    ]\n" +
			"  }\n" +
			"}\n";
		fs.writeFileSync(paths.settings, withOpenBracketComment, "utf-8");

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toContain("// keep me");
		expect(rawAfterUninstall).toContain('"PostToolUse"');
		expect(rawAfterUninstall).toContain('"statusLine": "keep me"');
	});

	it("keeps a trailing comment between the last removed entry and the closing bracket of an event array", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const withTrailingComment =
			"{\n" +
			'  "statusLine": "keep me",\n' +
			'  "hooks": {\n' +
			'    "PostToolUse": [\n' +
			"      {\n" +
			'        "matcher": "Edit|Write|MultiEdit",\n' +
			'        "hooks": [\n' +
			"          {\n" +
			'            "type": "command",\n' +
			'            "command": "aislop hook claude",\n' +
			'            "__aislop": { "managed": true }\n' +
			"          }\n" +
			"        ]\n" +
			"      }\n" +
			"      // trailing keep\n" +
			"    ]\n" +
			"  }\n" +
			"}\n";
		fs.writeFileSync(paths.settings, withTrailingComment, "utf-8");

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toContain("// trailing keep");
		expect(rawAfterUninstall).toContain('"PostToolUse"');
		expect(rawAfterUninstall).toContain('"statusLine": "keep me"');
	});

	it("keeps a comment inside the hooks object when its last event property is removed", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const withHooksLevelComment =
			"{\n" +
			'  "statusLine": "keep me",\n' +
			'  "hooks": {\n' +
			"    // keep hooks note\n" +
			'    "PostToolUse": [\n' +
			"      {\n" +
			'        "matcher": "Edit|Write|MultiEdit",\n' +
			'        "hooks": [\n' +
			"          {\n" +
			'            "type": "command",\n' +
			'            "command": "aislop hook claude",\n' +
			'            "__aislop": { "managed": true }\n' +
			"          }\n" +
			"        ]\n" +
			"      }\n" +
			"    ]\n" +
			"  }\n" +
			"}\n";
		fs.writeFileSync(paths.settings, withHooksLevelComment, "utf-8");

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		expect(rawAfterUninstall).toContain("// keep hooks note");
		expect(rawAfterUninstall).toContain('"hooks"');
		expect(rawAfterUninstall).not.toContain('"PostToolUse"');
		expect(rawAfterUninstall).toContain('"statusLine": "keep me"');
	});

	it("still removes a genuinely empty event array and hooks object with no comment trivia", () => {
		const paths = resolveClaudePaths(globalOpts());
		fs.mkdirSync(path.dirname(paths.settings), { recursive: true });
		const withoutComments =
			"{\n" +
			'  "statusLine": "keep me",\n' +
			'  "hooks": {\n' +
			'    "PostToolUse": [\n' +
			"      {\n" +
			'        "matcher": "Edit|Write|MultiEdit",\n' +
			'        "hooks": [\n' +
			"          {\n" +
			'            "type": "command",\n' +
			'            "command": "aislop hook claude",\n' +
			'            "__aislop": { "managed": true }\n' +
			"          }\n" +
			"        ]\n" +
			"      }\n" +
			"    ]\n" +
			"  }\n" +
			"}\n";
		fs.writeFileSync(paths.settings, withoutComments, "utf-8");

		uninstallClaude(globalOpts());
		const rawAfterUninstall = fs.readFileSync(paths.settings, "utf-8");
		const parsed = JSON.parse(rawAfterUninstall) as Record<string, unknown>;
		expect(parsed.hooks).toBeUndefined();
		expect(parsed.statusLine).toBe("keep me");
	});
});
