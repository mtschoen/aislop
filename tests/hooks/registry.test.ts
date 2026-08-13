import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installClaude, resolveClaudePaths } from "../../src/hooks/install/claude.js";
import { installCursor, resolveCursorPaths } from "../../src/hooks/install/cursor.js";
import { installGemini, resolveGeminiPaths } from "../../src/hooks/install/gemini.js";
import { installKimi, resolveKimiPaths } from "../../src/hooks/install/kimi.js";
import { installPi, resolvePiPaths } from "../../src/hooks/install/pi.js";
import {
	AGENTS_GLOBAL_ONLY,
	AGENTS_PROJECT_ONLY,
	AGENTS_SUPPORTING_BOTH_SCOPES,
	ALL_AGENTS,
	defaultScopeFor,
	detectInstalledAgents,
	REGISTRY,
	resolveInstalledScope,
	resolveManagedInstalledScope,
} from "../../src/hooks/install/registry.js";
import { sentinelHash } from "../../src/hooks/io/sentinel.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
	vi.stubEnv("CODEX_HOME", "");
	vi.stubEnv("KIMI_CODE_HOME", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("agent registry", () => {
	it("covers every declared agent with install + uninstall + paths", () => {
		for (const agent of ALL_AGENTS) {
			expect(REGISTRY[agent]).toBeDefined();
			expect(typeof REGISTRY[agent].install).toBe("function");
			expect(typeof REGISTRY[agent].uninstall).toBe("function");
			expect(typeof REGISTRY[agent].paths).toBe("function");
		}
	});

	it("partitions agents by supported scope with no overlap", () => {
		for (const agent of AGENTS_PROJECT_ONLY) {
			expect(AGENTS_SUPPORTING_BOTH_SCOPES).not.toContain(agent);
		}
		for (const agent of AGENTS_SUPPORTING_BOTH_SCOPES) {
			expect(AGENTS_PROJECT_ONLY).not.toContain(agent);
			expect(AGENTS_GLOBAL_ONLY).not.toContain(agent);
		}
		for (const agent of AGENTS_GLOBAL_ONLY) {
			expect(AGENTS_PROJECT_ONLY).not.toContain(agent);
			expect(AGENTS_SUPPORTING_BOTH_SCOPES).not.toContain(agent);
		}
		const union = new Set([
			...AGENTS_PROJECT_ONLY,
			...AGENTS_GLOBAL_ONLY,
			...AGENTS_SUPPORTING_BOTH_SCOPES,
		]);
		expect(union.size).toBe(ALL_AGENTS.length);
	});

	it("defaultScopeFor returns 'project' for project-only agents", () => {
		for (const agent of AGENTS_PROJECT_ONLY) {
			expect(defaultScopeFor(agent)).toBe("project");
		}
	});

	it("defaultScopeFor returns 'global' for both-scope agents", () => {
		for (const agent of AGENTS_SUPPORTING_BOTH_SCOPES) {
			expect(defaultScopeFor(agent)).toBe("global");
		}
	});

	it("keeps Kimi global because its rules live in the user data directory", () => {
		expect(AGENTS_GLOBAL_ONLY).toContain("kimi");
		expect(defaultScopeFor("kimi")).toBe("global");
		expect(REGISTRY.kimi.mode).toBe("rules-only");
	});
});

describe("detectInstalledAgents", () => {
	it("returns empty array when no agent config exists", () => {
		const installed = detectInstalledAgents({ home, cwd });
		expect(installed).toEqual([]);
	});

	it.each([
		{
			agent: "claude" as const,
			target: () => resolveClaudePaths({ home, cwd, scope: "global" }).settings,
			content: "{}",
		},
		{
			agent: "cursor" as const,
			target: () => resolveCursorPaths({ home, cwd, scope: "global" }).hooks,
			content: "{}",
		},
		{
			agent: "gemini" as const,
			target: () => resolveGeminiPaths({ home, cwd, scope: "global" }).settings,
			content: "{}",
		},
		{
			agent: "pi" as const,
			target: () => resolvePiPaths({ home, cwd, scope: "global" }).extension,
			content: "export default {};\n",
		},
	])(
		"does not report unrelated $agent runtime configuration as an installed hook",
		({ agent, target, content }) => {
			const configuration = target();
			fs.mkdirSync(path.dirname(configuration), { recursive: true });
			fs.writeFileSync(configuration, content);

			expect(resolveInstalledScope(agent, { home, cwd })).toBeNull();
			expect(detectInstalledAgents({ home, cwd })).not.toContain(agent);
		},
	);
	it("does not resolve malformed Claude settings as managed", () => {
		const settings = resolveClaudePaths({ home, cwd, scope: "project" }).settings;
		fs.mkdirSync(path.dirname(settings), { recursive: true });
		fs.writeFileSync(settings, "{ invalid");

		expect(resolveManagedInstalledScope("claude", { home, cwd })).toBeNull();
	});

	describe.each([
		{
			agent: "claude" as const,
			managedCommand: "aislop hook claude",
			managedSentinel: {
				v: 1,
				managed: true,
				hash: sentinelHash(
					JSON.stringify({ command: "aislop hook claude", matcher: "Edit|Write|MultiEdit" }),
				),
			},
			install: installClaude,
			resolvePath: () => resolveClaudePaths({ home, cwd, scope: "project" }).settings,
			buildConfiguration: (command: string, sentinel: unknown) => ({
				hooks: {
					PostToolUse: [
						{
							matcher: "Edit|Write|MultiEdit",
							hooks: [{ type: "command", command, __aislop: sentinel }],
						},
					],
				},
			}),
		},
		{
			agent: "cursor" as const,
			managedCommand: "aislop hook cursor",
			managedSentinel: {
				v: 1,
				managed: true,
				hash: sentinelHash(JSON.stringify({ command: "aislop hook cursor", timeout: 5000 })),
			},
			install: installCursor,
			resolvePath: () => resolveCursorPaths({ home, cwd, scope: "project" }).hooks,
			buildConfiguration: (command: string, sentinel: unknown) => ({
				version: 1,
				hooks: {
					afterFileEdit: [{ type: "command", command, timeout: 5000, __aislop: sentinel }],
				},
			}),
		},
		{
			agent: "gemini" as const,
			managedCommand: "aislop hook gemini",
			managedSentinel: {
				v: 1,
				managed: true,
				hash: sentinelHash(
					JSON.stringify({ command: "aislop hook gemini", matcher: "write_file|replace" }),
				),
			},
			install: installGemini,
			resolvePath: () => resolveGeminiPaths({ home, cwd, scope: "project" }).settings,
			buildConfiguration: (command: string, sentinel: unknown) => ({
				hooks: {
					AfterTool: [
						{
							matcher: "write_file|replace",
							hooks: [
								{ name: "aislop", type: "command", command, timeout: 5000, __aislop: sentinel },
							],
						},
					],
				},
			}),
		},
	])(
		"$agent managed scope",
		({ agent, managedCommand, managedSentinel, install, resolvePath, buildConfiguration }) => {
			it.each([
				{
					name: "a malformed sentinel",
					command: (expectedCommand: string) => expectedCommand,
					sentinel: () => ({}),
				},
				{
					name: "an unrelated command",
					command: () => "other-hook",
					sentinel: (validSentinel: unknown) => validSentinel,
				},
			])("ignores $name in the project configuration", ({ command, sentinel }) => {
				install({ home, cwd, scope: "global" });
				const projectPath = resolvePath();
				fs.mkdirSync(path.dirname(projectPath), { recursive: true });
				fs.writeFileSync(
					projectPath,
					JSON.stringify(buildConfiguration(command(managedCommand), sentinel(managedSentinel))),
				);

				expect(resolveManagedInstalledScope(agent, { home, cwd })).toBe("global");
			});
		},
	);

	it("ignores an incomplete managed pi marker in project scope", () => {
		installPi({ home, cwd, scope: "global" });
		const extension = resolvePiPaths({ home, cwd, scope: "project" }).extension;
		fs.mkdirSync(path.dirname(extension), { recursive: true });
		fs.writeFileSync(
			extension,
			"// aislop [managed:v1]\\n// auto-generated pi extension. Do not edit by hand.\\n",
		);

		expect(resolveManagedInstalledScope("pi", { home, cwd })).toBe("global");
	});

	it("detects Windsurf from .windsurfrules in cwd", () => {
		fs.writeFileSync(path.join(cwd, ".windsurfrules"), "# rules");
		const installed = detectInstalledAgents({ home, cwd });
		expect(installed).toContain("windsurf");
	});

	it("does not treat Codex rules alone as a runtime hook", () => {
		const dir = path.join(home, ".codex");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "AGENTS.md"), "# rules");
		const installed = detectInstalledAgents({ home, cwd });
		expect(installed).not.toContain("codex");
	});

	it("does not treat an unrelated Codex hooks file as the aislop runtime hook", () => {
		const dir = path.join(home, ".codex");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "hooks.json"),
			JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "other-hook" }] }],
				},
			}),
		);

		expect(detectInstalledAgents({ home, cwd })).not.toContain("codex");
	});

	it("does not treat unrelated Kimi configuration as installed rules", () => {
		const config = path.join(home, ".kimi-code", "config.toml");
		fs.mkdirSync(path.dirname(config), { recursive: true });
		fs.writeFileSync(config, "[thinking]\nenabled = true\n");

		expect(detectInstalledAgents({ home, cwd })).not.toContain("kimi");
	});

	it("does not treat unrelated Kimi AGENTS.md content as installed rules", () => {
		const rules = resolveKimiPaths({ home, cwd, scope: "global" }).rules;
		fs.mkdirSync(path.dirname(rules), { recursive: true });
		fs.writeFileSync(rules, "# User rules\n");

		expect(resolveInstalledScope("kimi", { home, cwd })).toBeNull();
		expect(detectInstalledAgents({ home, cwd })).not.toContain("kimi");
	});

	it("detects installed Kimi rules", () => {
		installKimi({ home, cwd, scope: "global" });

		expect(fs.existsSync(resolveKimiPaths({ home, cwd, scope: "global" }).rules)).toBe(true);
		expect(resolveInstalledScope("kimi", { home, cwd })).toBe("global");
		expect(detectInstalledAgents({ home, cwd })).toContain("kimi");
	});

	it("detects a project-scoped Codex runtime hook", () => {
		const dir = path.join(cwd, ".codex");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "hooks.json"),
			JSON.stringify({
				hooks: {
					PostToolUse: [
						{
							matcher: "apply_patch",
							hooks: [
								{
									type: "command",
									command: "aislop hook codex",
									timeout: 15,
									statusMessage: "Running aislop [managed:v1]",
								},
							],
						},
					],
				},
			}),
		);

		expect(resolveInstalledScope("codex", { home, cwd })).toBe("project");
		expect(detectInstalledAgents({ home, cwd })).toContain("codex");
	});
});
