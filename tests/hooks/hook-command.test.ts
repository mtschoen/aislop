import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerHookCommand } from "../../src/cli/hook-command.js";
import {
	AGENT_LABELS,
	defaultInstallTargets,
	parseAgentFlag,
	resolveAgents,
} from "../../src/commands/hook.js";

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

describe("Codex runtime registration", () => {
	it("labels Codex as a PostToolUse runtime adapter", () => {
		expect(AGENT_LABELS.codex.hint).toBe("PostToolUse, runtime");
	});

	it("registers the hidden codex callback with Stop mode", () => {
		const program = new Command();
		registerHookCommand(program);
		const hook = program.commands.find((command) => command.name() === "hook");
		const codex = hook?.commands.find((command) => command.name() === "codex");

		expect(codex).toBeDefined();
		expect(codex?.options.some((option) => option.long === "--stop")).toBe(true);
	});

	it("documents quality-gate support for Claude and Codex", () => {
		const program = new Command();
		registerHookCommand(program);
		const hook = program.commands.find((command) => command.name() === "hook");
		const install = hook?.commands.find((command) => command.name() === "install");
		const qualityGate = install?.options.find((option) => option.long === "--quality-gate");

		expect(qualityGate?.description).toContain("Claude and Codex");
	});
});
