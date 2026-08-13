import fs from "node:fs";
import { readIfExists } from "../io/atomic-write.js";
import { AISLOP_SENTINEL_KEY } from "../io/json-patch.js";
import { sentinelHash } from "../io/sentinel.js";
import {
	installAntigravity,
	resolveAntigravityPaths,
	uninstallAntigravity,
} from "./antigravity.js";
import { installClaude, resolveClaudePaths, uninstallClaude } from "./claude.js";
import { installCline, resolveClinePaths, resolveRooPaths, uninstallCline } from "./cline.js";
import { hasManagedCodexHook, installCodex, resolveCodexPaths, uninstallCodex } from "./codex.js";
import { installCopilot, resolveCopilotPaths, uninstallCopilot } from "./copilot.js";
import { installCursor, resolveCursorPaths, uninstallCursor } from "./cursor.js";
import { installGemini, resolveGeminiPaths, uninstallGemini } from "./gemini.js";
import { installKilocode, resolveKilocodePaths, uninstallKilocode } from "./kilocode.js";
import { hasManagedKimiRules, installKimi, resolveKimiPaths, uninstallKimi } from "./kimi.js";
import { hasManagedPiHook, installPi, resolvePiPaths, uninstallPi } from "./pi.js";
import type { HookInstallOpts, HookInstallResult, HookUninstallResult } from "./types.js";
import { installWindsurf, resolveWindsurfPaths, uninstallWindsurf } from "./windsurf.js";

export type AgentName =
	| "claude"
	| "cursor"
	| "gemini"
	| "pi"
	| "codex"
	| "kimi"
	| "windsurf"
	| "cline"
	| "kilocode"
	| "antigravity"
	| "copilot";

export const ALL_AGENTS: AgentName[] = [
	"claude",
	"cursor",
	"gemini",
	"pi",
	"codex",
	"kimi",
	"windsurf",
	"cline",
	"kilocode",
	"antigravity",
	"copilot",
];

export const AGENTS_PROJECT_ONLY: AgentName[] = [
	"windsurf",
	"cline",
	"kilocode",
	"antigravity",
	"copilot",
];
export const AGENTS_GLOBAL_ONLY: AgentName[] = ["kimi"];
export const AGENTS_SUPPORTING_BOTH_SCOPES: AgentName[] = [
	"claude",
	"cursor",
	"gemini",
	"pi",
	"codex",
];

interface AgentEntry {
	mode: "rules-only" | "runtime";
	install: (opts: HookInstallOpts) => HookInstallResult;
	uninstall: (opts: Omit<HookInstallOpts, "qualityGate">) => HookUninstallResult;
	paths: (opts: HookInstallOpts) => string[];
	isManaged?: (opts: HookInstallOpts) => boolean;
}

const paths = {
	claude: (opts: HookInstallOpts): string[] => {
		const p = resolveClaudePaths(opts);
		return [p.settings, p.aislopMd, p.claudeMd];
	},
	cursor: (opts: HookInstallOpts): string[] => {
		const p = resolveCursorPaths(opts);
		return opts.scope === "project" ? [p.hooks, p.rules] : [p.hooks];
	},
	gemini: (opts: HookInstallOpts): string[] => {
		const p = resolveGeminiPaths(opts);
		return [p.settings, p.aislopMd, p.geminiMd];
	},
	pi: (opts: HookInstallOpts): string[] => [resolvePiPaths(opts).extension],
	codex: (opts: HookInstallOpts): string[] => {
		const resolved = resolveCodexPaths(opts);
		return [resolved.hooks, resolved.rules];
	},
	kimi: (opts: HookInstallOpts): string[] => [resolveKimiPaths(opts).rules],
	windsurf: (opts: HookInstallOpts): string[] => [resolveWindsurfPaths(opts).rules],
	cline: (opts: HookInstallOpts): string[] => [
		resolveClinePaths(opts).rules,
		resolveRooPaths(opts).rules,
	],
	kilocode: (opts: HookInstallOpts): string[] => [resolveKilocodePaths(opts).rules],
	antigravity: (opts: HookInstallOpts): string[] => [resolveAntigravityPaths(opts).rules],
	copilot: (opts: HookInstallOpts): string[] => [resolveCopilotPaths(opts).rules],
};
interface ManagedJsonHookDescriptor {
	event: string;
	command: string;
	matcher?: string;
	name?: string;
	timeout?: number;
	expectedHash: string;
}

const MANAGED_JSON_HOOKS = {
	claude: {
		event: "PostToolUse",
		command: "aislop hook claude",
		matcher: "Edit|Write|MultiEdit",
		expectedHash: sentinelHash(
			JSON.stringify({ command: "aislop hook claude", matcher: "Edit|Write|MultiEdit" }),
		),
	},
	cursor: {
		event: "afterFileEdit",
		command: "aislop hook cursor",
		timeout: 5000,
		expectedHash: sentinelHash(JSON.stringify({ command: "aislop hook cursor", timeout: 5000 })),
	},
	gemini: {
		event: "AfterTool",
		command: "aislop hook gemini",
		matcher: "write_file|replace",
		name: "aislop",
		timeout: 5000,
		expectedHash: sentinelHash(
			JSON.stringify({ command: "aislop hook gemini", matcher: "write_file|replace" }),
		),
	},
} satisfies Record<"claude" | "cursor" | "gemini", ManagedJsonHookDescriptor>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isManagedCommandHook = (value: unknown, descriptor: ManagedJsonHookDescriptor): boolean => {
	if (!isRecord(value) || value.type !== "command" || value.command !== descriptor.command) {
		return false;
	}
	if (descriptor.name !== undefined && value.name !== descriptor.name) return false;
	if (descriptor.timeout !== undefined && value.timeout !== descriptor.timeout) return false;

	const sentinel = value[AISLOP_SENTINEL_KEY];
	return (
		isRecord(sentinel) &&
		sentinel.v === 1 &&
		sentinel.managed === true &&
		sentinel.hash === descriptor.expectedHash
	);
};

const hasManagedJsonHook = (
	content: string | null,
	descriptor: ManagedJsonHookDescriptor,
): boolean => {
	if (content == null) return false;
	try {
		const configuration = JSON.parse(content) as Record<string, unknown>;
		if (!isRecord(configuration.hooks)) return false;
		const eventHooks = configuration.hooks[descriptor.event];
		if (!Array.isArray(eventHooks)) return false;
		if (descriptor.matcher === undefined) {
			return eventHooks.some((hook) => isManagedCommandHook(hook, descriptor));
		}
		return eventHooks.some(
			(group) =>
				isRecord(group) &&
				group.matcher === descriptor.matcher &&
				Array.isArray(group.hooks) &&
				group.hooks.some((hook) => isManagedCommandHook(hook, descriptor)),
		);
	} catch {
		return false;
	}
};

export const REGISTRY: Record<AgentName, AgentEntry> = {
	claude: {
		mode: "runtime",
		install: installClaude,
		uninstall: uninstallClaude,
		paths: paths.claude,
		isManaged: (options) =>
			hasManagedJsonHook(
				readIfExists(resolveClaudePaths(options).settings),
				MANAGED_JSON_HOOKS.claude,
			),
	},
	cursor: {
		mode: "runtime",
		install: installCursor,
		uninstall: uninstallCursor,
		paths: paths.cursor,
		isManaged: (options) =>
			hasManagedJsonHook(
				readIfExists(resolveCursorPaths(options).hooks),
				MANAGED_JSON_HOOKS.cursor,
			),
	},
	gemini: {
		mode: "runtime",
		install: installGemini,
		uninstall: uninstallGemini,
		paths: paths.gemini,
		isManaged: (options) =>
			hasManagedJsonHook(
				readIfExists(resolveGeminiPaths(options).settings),
				MANAGED_JSON_HOOKS.gemini,
			),
	},
	pi: {
		mode: "runtime",
		install: installPi,
		uninstall: uninstallPi,
		paths: paths.pi,
		isManaged: (options) => hasManagedPiHook(readIfExists(resolvePiPaths(options).extension)),
	},
	codex: {
		mode: "runtime",
		install: installCodex,
		uninstall: uninstallCodex,
		paths: paths.codex,
		isManaged: (opts) => hasManagedCodexHook(readIfExists(resolveCodexPaths(opts).hooks)),
	},
	kimi: {
		mode: "rules-only",
		install: installKimi,
		uninstall: uninstallKimi,
		paths: paths.kimi,
		isManaged: (opts) => hasManagedKimiRules(readIfExists(resolveKimiPaths(opts).rules)),
	},
	windsurf: {
		mode: "rules-only",
		install: installWindsurf,
		uninstall: uninstallWindsurf,
		paths: paths.windsurf,
	},
	cline: {
		mode: "rules-only",
		install: installCline,
		uninstall: uninstallCline,
		paths: paths.cline,
	},
	kilocode: {
		mode: "rules-only",
		install: installKilocode,
		uninstall: uninstallKilocode,
		paths: paths.kilocode,
	},
	antigravity: {
		mode: "rules-only",
		install: installAntigravity,
		uninstall: uninstallAntigravity,
		paths: paths.antigravity,
	},
	copilot: {
		mode: "rules-only",
		install: installCopilot,
		uninstall: uninstallCopilot,
		paths: paths.copilot,
	},
};

export const defaultScopeFor = (agent: AgentName): "global" | "project" =>
	AGENTS_PROJECT_ONLY.includes(agent) ? "project" : "global";

const scopeCandidatesFor = (agent: AgentName): Array<"global" | "project"> => {
	if (AGENTS_PROJECT_ONLY.includes(agent)) return ["project"];
	if (AGENTS_GLOBAL_ONLY.includes(agent)) return ["global"];
	return ["project", "global"];
};

const isInstalledAtScope = (
	agent: AgentName,
	opts: { home: string; cwd: string },
	scope: "global" | "project",
): boolean => {
	const entry = REGISTRY[agent];
	if (entry.isManaged) return entry.isManaged({ ...opts, scope });
	if (entry.mode === "runtime") return false;
	const targets = entry.paths({ ...opts, scope });
	return targets.some((target) => fs.existsSync(target));
};

export const resolveInstalledScope = (
	agent: AgentName,
	opts: { home: string; cwd: string },
): "global" | "project" | null => {
	for (const scope of scopeCandidatesFor(agent)) {
		if (isInstalledAtScope(agent, opts, scope)) return scope;
	}
	return null;
};

/**
 * Resolve a scope only when the registry can prove aislop owns the installation.
 * This is deliberately stricter than status detection so uninstall never uses an
 * unrelated configuration file as evidence for the project scope.
 */
export const resolveManagedInstalledScope = (
	agent: AgentName,
	opts: { home: string; cwd: string },
): "global" | "project" | null => {
	const entry = REGISTRY[agent];
	const isManaged = entry.isManaged;
	if (!isManaged) return null;

	for (const scope of scopeCandidatesFor(agent)) {
		if (isManaged({ ...opts, scope })) return scope;
	}
	return null;
};

export const detectInstalledAgents = (opts: { home: string; cwd: string }): AgentName[] => {
	return ALL_AGENTS.filter((agent) => resolveInstalledScope(agent, opts) !== null);
};
