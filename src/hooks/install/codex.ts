import fs from "node:fs";
import path from "node:path";
import { AISLOP_MD_BODY } from "../assets.js";
import { atomicWrite, readIfExists } from "../io/atomic-write.js";
import { removeMarkdownFence, sentinelHash, upsertMarkdownFence } from "../io/sentinel.js";
import {
	emptyResult,
	type HookInstallOpts,
	type HookInstallResult,
	type HookUninstallResult,
} from "./types.js";

const POST_TOOL_COMMAND = "aislop hook codex";
const STOP_COMMAND = "aislop hook codex --stop";

interface CodexPaths {
	hooks: string;
	rules: string;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const resolveCodexPaths = (opts: HookInstallOpts): CodexPaths => {
	const codexDirectory =
		opts.scope === "project" ? path.join(opts.cwd, ".codex") : path.join(opts.home, ".codex");
	return {
		hooks: path.join(codexDirectory, "hooks.json"),
		rules:
			opts.scope === "project"
				? path.join(opts.cwd, "AGENTS.md")
				: path.join(codexDirectory, "AGENTS.md"),
	};
};

const parseHookFile = (raw: string | null): JsonRecord => {
	if (raw === null) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
};

const groupHasCommand = (group: unknown, command: string): boolean => {
	if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
	return group.hooks.some(
		(hook) => isRecord(hook) && hook.type === "command" && hook.command === command,
	);
};

const replaceManagedGroup = (
	config: JsonRecord,
	event: "PostToolUse" | "Stop",
	command: string,
	replacement?: JsonRecord,
): JsonRecord => {
	const hooks = isRecord(config.hooks) ? config.hooks : {};
	const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
	const retained = existing.filter((group) => !groupHasCommand(group, command));
	const eventGroups = replacement ? [...retained, replacement] : retained;
	const nextHooks = { ...hooks };
	if (eventGroups.length === 0) delete nextHooks[event];
	else nextHooks[event] = eventGroups;

	const next = { ...config };
	if (Object.keys(nextHooks).length === 0) delete next.hooks;
	else next.hooks = nextHooks;
	return next;
};

const postToolGroup = (): JsonRecord => ({
	matcher: "Edit|Write",
	hooks: [{ type: "command", command: POST_TOOL_COMMAND }],
});

const stopGroup = (): JsonRecord => ({
	hooks: [{ type: "command", command: STOP_COMMAND }],
});

const renderHooks = (existing: string | null, qualityGate: boolean): string => {
	let next = replaceManagedGroup(
		parseHookFile(existing),
		"PostToolUse",
		POST_TOOL_COMMAND,
		postToolGroup(),
	);
	next = replaceManagedGroup(next, "Stop", STOP_COMMAND, qualityGate ? stopGroup() : undefined);
	return `${JSON.stringify(next, null, 2)}\n`;
};

const resolveRulesStoragePath = (rulesPath: string): string => {
	try {
		return fs.lstatSync(rulesPath).isSymbolicLink() ? fs.realpathSync(rulesPath) : rulesPath;
	} catch {
		return rulesPath;
	}
};

const applyContent = (
	result: HookInstallResult,
	opts: HookInstallOpts,
	displayPath: string,
	storagePath: string,
	nextContent: string,
	summary: string,
): void => {
	if (readIfExists(storagePath) === nextContent) {
		result.skipped.push(displayPath);
		return;
	}
	if (opts.dryRun) {
		result.planned.push({ path: displayPath, summary });
		return;
	}
	atomicWrite(storagePath, nextContent);
	result.wrote.push(displayPath);
};

const applyRemoval = (
	result: HookUninstallResult,
	opts: Omit<HookInstallOpts, "qualityGate">,
	displayPath: string,
	storagePath: string,
	nextContent: string | null,
	preserveStorage: boolean,
): void => {
	const existing = readIfExists(storagePath);
	if (existing === null || existing === (nextContent ?? "")) {
		result.skipped.push(displayPath);
		return;
	}
	if (opts.dryRun) {
		result.removed.push(displayPath);
		return;
	}
	if (nextContent === null && !preserveStorage) fs.unlinkSync(storagePath);
	else atomicWrite(storagePath, nextContent ?? "");
	result.removed.push(displayPath);
};

export const installCodex = (opts: HookInstallOpts): HookInstallResult => {
	const paths = resolveCodexPaths(opts);
	const result = emptyResult();
	applyContent(
		result,
		opts,
		paths.hooks,
		paths.hooks,
		renderHooks(readIfExists(paths.hooks), Boolean(opts.qualityGate)),
		"register Codex PostToolUse hook",
	);

	const rulesStoragePath = resolveRulesStoragePath(paths.rules);
	const fenced = upsertMarkdownFence(
		readIfExists(rulesStoragePath),
		AISLOP_MD_BODY,
		sentinelHash(AISLOP_MD_BODY),
	);
	applyContent(
		result,
		opts,
		paths.rules,
		rulesStoragePath,
		fenced.nextContent,
		"write AGENTS.md rules for Codex",
	);
	return result;
};

export const uninstallCodex = (opts: Omit<HookInstallOpts, "qualityGate">): HookUninstallResult => {
	const paths = resolveCodexPaths({ ...opts, qualityGate: false });
	const result: HookUninstallResult = { removed: [], skipped: [] };

	const hooksRaw = readIfExists(paths.hooks);
	if (hooksRaw === null) {
		result.skipped.push(paths.hooks);
	} else {
		let hooks = replaceManagedGroup(parseHookFile(hooksRaw), "PostToolUse", POST_TOOL_COMMAND);
		hooks = replaceManagedGroup(hooks, "Stop", STOP_COMMAND);
		const nextHooks =
			Object.keys(hooks).length === 0 ? null : `${JSON.stringify(hooks, null, 2)}\n`;
		applyRemoval(result, opts, paths.hooks, paths.hooks, nextHooks, false);
	}

	const rulesStoragePath = resolveRulesStoragePath(paths.rules);
	const rulesRaw = readIfExists(rulesStoragePath);
	if (rulesRaw === null) {
		result.skipped.push(paths.rules);
	} else {
		applyRemoval(
			result,
			opts,
			paths.rules,
			rulesStoragePath,
			removeMarkdownFence(rulesRaw),
			rulesStoragePath !== paths.rules,
		);
	}

	return result;
};
