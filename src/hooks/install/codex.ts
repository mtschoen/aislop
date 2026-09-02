import path from "node:path";
import { readIfExists } from "../io/atomic-write.js";
import { installRulesOnly, uninstallRulesOnly } from "./rules-only.js";
import {
	applyContent,
	applyRemoval,
	type HookInstallOpts,
	type HookInstallResult,
	type HookUninstallResult,
} from "./types.js";

import {
	type EventHookOperation,
	parseJsonConfiguration,
	patchJsonHooks,
} from "../io/json-patch.js";

const CODEX_HOOK_COMMAND = "aislop hook codex";
const CODEX_MANAGED_STATUS = "Running aislop [managed:v1]";

const CODEX_HOOK_GROUP = {
	matcher: "apply_patch",
	hooks: [
		{
			type: "command",
			command: CODEX_HOOK_COMMAND,
			timeout: 15,
			statusMessage: CODEX_MANAGED_STATUS,
		},
	],
};

export const resolveCodexPaths = (opts: HookInstallOpts) => {
	const codexHome =
		opts.scope === "project"
			? path.join(opts.cwd, ".codex")
			: process.env.CODEX_HOME || path.join(opts.home, ".codex");
	return {
		hooks: path.join(codexHome, "hooks.json"),
		rules:
			opts.scope === "project"
				? path.join(opts.cwd, "AGENTS.md")
				: path.join(codexHome, "AGENTS.md"),
	};
};

const isManagedHookCommand = (handler: unknown): boolean => {
	if (typeof handler !== "object" || handler === null || Array.isArray(handler)) return false;
	const command = handler as Record<string, unknown>;
	return (
		command.type === "command" &&
		command.command === CODEX_HOOK_COMMAND &&
		command.timeout === 15 &&
		command.statusMessage === CODEX_MANAGED_STATUS
	);
};

const isManagedHookGroup = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const group = value as Record<string, unknown>;
	if (group.matcher !== CODEX_HOOK_GROUP.matcher || !Array.isArray(group.hooks)) return false;
	return group.hooks.some(isManagedHookCommand);
};

export const hasManagedCodexHook = (raw: string | null): boolean => {
	if (!raw) return false;
	try {
		const config = parseJsonConfiguration(raw, "Codex hooks.json");
		if (typeof config.hooks !== "object" || config.hooks === null || Array.isArray(config.hooks)) {
			return false;
		}
		const postToolUse = (config.hooks as Record<string, unknown>).PostToolUse;
		return Array.isArray(postToolUse) && postToolUse.some(isManagedHookGroup);
	} catch {
		return false;
	}
};

const renderHooks = (raw: string | null, target: string): string => {
	const operations: EventHookOperation[] = [
		{ event: "PostToolUse", action: "upsert", group: CODEX_HOOK_GROUP },
	];
	return patchJsonHooks(raw, {
		target,
		isManagedCommand: isManagedHookCommand,
		operations,
	})!;
};

export const installCodex = (opts: HookInstallOpts): HookInstallResult => {
	const paths = resolveCodexPaths(opts);
	const hooksContent = renderHooks(readIfExists(paths.hooks), paths.hooks);
	const result = installRulesOnly(opts, paths, "write AGENTS.md rules for Codex");
	applyContent(result, opts, paths.hooks, hooksContent, "register Codex PostToolUse hook");
	return result;
};

export const uninstallCodex = (opts: Omit<HookInstallOpts, "qualityGate">): HookUninstallResult => {
	const paths = resolveCodexPaths(opts);
	const raw = readIfExists(paths.hooks);
	if (raw === null) {
		const result = uninstallRulesOnly(opts, paths);
		result.skipped.push(paths.hooks);
		return result;
	}

	const operations: EventHookOperation[] = [{ event: "PostToolUse", action: "remove" }];
	const next = patchJsonHooks(raw, {
		target: paths.hooks,
		isManagedCommand: isManagedHookCommand,
		operations,
	});
	const result = uninstallRulesOnly(opts, paths);
	applyRemoval(result, opts, paths.hooks, next);
	return result;
};
