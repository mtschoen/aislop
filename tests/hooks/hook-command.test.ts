import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHookCommand } from "../../src/cli/hook-command.js";
import { defaultInstallTargets, parseAgentFlag, resolveAgents } from "../../src/commands/hook.js";
import { installClaude, resolveClaudePaths } from "../../src/hooks/install/claude.js";
import { installCodex, resolveCodexPaths } from "../../src/hooks/install/codex.js";
import { installCursor, resolveCursorPaths } from "../../src/hooks/install/cursor.js";
import { installGemini, resolveGeminiPaths } from "../../src/hooks/install/gemini.js";
import { installPi, resolvePiPaths } from "../../src/hooks/install/pi.js";
import type { HookInstallOpts, HookInstallResult } from "../../src/hooks/install/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

describe("parseAgentFlag", () => {
	it("returns the fallback when no arg is provided", () => {
		const fallback = defaultInstallTargets();
		expect(parseAgentFlag(undefined, fallback)).toEqual(fallback);
	});

	it("parses a single agent", () => {
		expect(parseAgentFlag("claude", [])).toEqual(["claude"]);
	});

	it("parses a comma-separated list and trims whitespace", () => {
		expect(parseAgentFlag("claude, cursor ,gemini", [])).toEqual(["claude", "cursor", "gemini"]);
	});

	it("drops empty segments from the list", () => {
		expect(parseAgentFlag("claude,,cursor", [])).toEqual(["claude", "cursor"]);
	});

	it("throws on an unknown agent name", () => {
		expect(() => parseAgentFlag("claude,nope", [])).toThrowError(/Unknown agent/);
	});

	it("throws naming every unknown agent at once", () => {
		expect(() => parseAgentFlag("claude,nope,also-nope", [])).toThrowError(/nope, also-nope/);
	});
});

describe("defaultInstallTargets", () => {
	it("returns the both-scope agent list by default", () => {
		const targets = defaultInstallTargets();
		expect(targets).toContain("claude");
		expect(targets).toContain("cursor");
		expect(targets).toContain("gemini");
		expect(targets).toContain("codex");
		expect(targets).toContain("kimi");
		expect(targets).not.toContain("windsurf");
		expect(targets).not.toContain("copilot");
	});
});

describe("resolveAgents", () => {
	it("picks per-agent flags when set", () => {
		expect(resolveAgents({ claude: true, cursor: true }, [], undefined, [])).toEqual([
			"claude",
			"cursor",
		]);
	});

	it("preserves the canonical ordering regardless of flag order", () => {
		expect(resolveAgents({ gemini: true, claude: true }, [], undefined, [])).toEqual([
			"claude",
			"gemini",
		]);
	});

	it("falls back to positional args when no per-agent flags set", () => {
		expect(resolveAgents({}, ["claude", "gemini"], undefined, [])).toEqual(["claude", "gemini"]);
	});

	it("per-agent flags beat positional args", () => {
		expect(resolveAgents({ claude: true }, ["cursor"], undefined, [])).toEqual(["claude"]);
	});

	it("falls back to --agent comma list when neither flags nor positional are set", () => {
		expect(resolveAgents({}, [], "claude,cursor", [])).toEqual(["claude", "cursor"]);
	});

	it("falls back to the provided fallback when nothing is passed", () => {
		const fallback = defaultInstallTargets();
		expect(resolveAgents({}, [], undefined, fallback)).toEqual(fallback);
	});

	it("throws on an unknown positional agent", () => {
		expect(() => resolveAgents({}, ["claude", "nope"], undefined, [])).toThrowError(
			/Unknown agent/,
		);
	});

	it("positional args beat --agent", () => {
		expect(resolveAgents({}, ["claude"], "gemini", [])).toEqual(["claude"]);
	});
});

describe("registerHookCommand", () => {
	it("does not register a runtime callback for rules-only Kimi", () => {
		const program = new Command();
		registerHookCommand(program);
		const hook = program.commands.find((command) => command.name() === "hook");

		expect(hook?.commands.map((command) => command.name())).not.toContain("kimi");
	});
});

describe("hookUninstall", () => {
	it.each([
		{
			agent: "claude",
			install: installClaude,
			installedPath: (options: HookInstallOpts) => resolveClaudePaths(options).settings,
		},
		{
			agent: "cursor",
			install: installCursor,
			installedPath: (options: HookInstallOpts) => resolveCursorPaths(options).hooks,
		},
		{
			agent: "gemini",
			install: installGemini,
			installedPath: (options: HookInstallOpts) => resolveGeminiPaths(options).settings,
		},
		{
			agent: "pi",
			install: installPi,
			installedPath: (options: HookInstallOpts) => resolvePiPaths(options).extension,
		},
	] satisfies Array<{
		agent: string;
		install: (options: HookInstallOpts) => HookInstallResult;
		installedPath: (options: HookInstallOpts) => string;
	}>)("uses the detected project scope when uninstalling $agent", async (testCase) => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
		temporaryDirectories.push(home, cwd);
		vi.stubEnv("AISLOP_NO_TELEMETRY", "1");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const installOptions = { home, cwd, scope: "project" as const };
		testCase.install(installOptions);
		const installedPath = testCase.installedPath(installOptions);
		const program = new Command();
		registerHookCommand(program);

		await program.parseAsync(["node", "aislop", "hook", "uninstall", testCase.agent]);

		expect(fs.existsSync(installedPath)).toBe(false);
	});

	it("uses the detected project scope when no scope was requested", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
		temporaryDirectories.push(home, cwd);
		vi.stubEnv("CODEX_HOME", "");
		vi.stubEnv("AISLOP_NO_TELEMETRY", "1");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const installOptions = { home, cwd, scope: "project" as const };
		installCodex(installOptions);
		const program = new Command();
		registerHookCommand(program);

		await program.parseAsync(["node", "aislop", "hook", "uninstall", "codex"]);

		expect(fs.existsSync(resolveCodexPaths(installOptions).hooks)).toBe(false);
	});

	it("ignores unrelated project config when uninstalling a global hook", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
		temporaryDirectories.push(home, cwd);
		vi.stubEnv("AISLOP_NO_TELEMETRY", "1");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(process, "cwd").mockReturnValue(cwd);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const globalOptions = { home, cwd, scope: "global" as const };
		installClaude(globalOptions);
		const projectSettings = resolveClaudePaths({ home, cwd, scope: "project" }).settings;
		fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
		fs.writeFileSync(projectSettings, "{}\n");
		const program = new Command();
		registerHookCommand(program);

		await program.parseAsync(["node", "aislop", "hook", "uninstall", "claude"]);

		expect(fs.readFileSync(projectSettings, "utf-8")).toBe("{}\n");
		expect(fs.existsSync(resolveClaudePaths(globalOptions).settings)).toBe(false);
	});
});
