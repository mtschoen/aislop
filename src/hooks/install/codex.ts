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

const isManagedHookGroup = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const group = value as Record<string, unknown>;
	if (group.matcher !== CODEX_HOOK_GROUP.matcher || !Array.isArray(group.hooks)) return false;
	if (group.hooks.length !== 1) return false;
	const handler = group.hooks[0];
	if (typeof handler !== "object" || handler === null || Array.isArray(handler)) return false;
	const command = handler as Record<string, unknown>;
	return (
		command.type === "command" &&
		command.command === CODEX_HOOK_COMMAND &&
		command.timeout === 15 &&
		command.statusMessage === CODEX_MANAGED_STATUS
	);
};

const parseHooks = (raw: string | null, target: string): Record<string, unknown> => {
	if (raw === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Cannot update ${target}: invalid JSON. Fix or remove it, then rerun.`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Cannot update ${target}: expected a JSON object.`);
	}
	return parsed as Record<string, unknown>;
};

const parseHookSections = (
	configuration: Record<string, unknown>,
	target: string,
): Record<string, unknown> => {
	if (configuration.hooks === undefined) return {};
	if (
		typeof configuration.hooks !== "object" ||
		configuration.hooks === null ||
		Array.isArray(configuration.hooks)
	) {
		throw new Error(`Cannot update ${target}: expected hooks to be a JSON object.`);
	}
	const hooks = configuration.hooks as Record<string, unknown>;
	if (hooks.PostToolUse !== undefined && !Array.isArray(hooks.PostToolUse))
		throw new Error(`Cannot update ${target}: expected hooks.PostToolUse to be an array.`);
	return hooks;
};

export const hasManagedCodexHook = (raw: string | null): boolean => {
	if (!raw) return false;
	try {
		const config = parseHooks(raw, "Codex hooks.json");
		if (typeof config.hooks !== "object" || config.hooks === null) return false;
		const postToolUse = (config.hooks as Record<string, unknown>).PostToolUse;
		return Array.isArray(postToolUse) && postToolUse.some(isManagedHookGroup);
	} catch {
		return false;
	}
};

const renderHooks = (raw: string | null, target: string): string => {
	const config = parseHooks(raw, target);
	const hooks = parseHookSections(config, target);
	const existing = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
	const nextHooks = {
		...hooks,
		PostToolUse: [...existing.filter((entry) => !isManagedHookGroup(entry)), CODEX_HOOK_GROUP],
	};
	return `${JSON.stringify({ ...config, hooks: nextHooks }, null, 2)}\n`;
};

const removeRuntimeHook = (raw: string, target: string): Record<string, unknown> => {
	const config = parseHooks(raw, target);
	const hooks = parseHookSections(config, target);
	const existing = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
	const remaining = existing.filter((entry) => !isManagedHookGroup(entry));
	const nextHooks = { ...hooks };
	if (remaining.length > 0) nextHooks.PostToolUse = remaining;
	else delete nextHooks.PostToolUse;

	const next = { ...config };
	if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
	else delete next.hooks;
	return next;
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

	const next = removeRuntimeHook(raw, paths.hooks);
	const result = uninstallRulesOnly(opts, paths);
	applyRemoval(
		result,
		opts,
		paths.hooks,
		Object.keys(next).length > 0 ? `${JSON.stringify(next, null, 2)}\n` : null,
	);
	return result;
};
