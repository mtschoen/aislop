import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { AISLOP_MD_BODY } from "../assets.js";
import { readIfExists } from "../io/atomic-write.js";
import { sentinelHash, upsertMarkdownFence } from "../io/sentinel.js";
import {
	applyContent,
	applyRemoval,
	emptyResult,
	type HookInstallOpts,
	type HookInstallResult,
	type HookUninstallResult,
} from "./types.js";

const LEGACY_BEGIN_MARKER = "# aislop:begin kimi-hook v1";
const LEGACY_END_MARKER = "# aislop:end kimi-hook v1";
const EDIT_SECTION_HEADING = "## On every edit\n\n";
const NEXT_SECTION_HEADING = "\n\n## Severity ladder";
const editInstructionsBegin =
	AISLOP_MD_BODY.indexOf(EDIT_SECTION_HEADING) + EDIT_SECTION_HEADING.length;
const editInstructionsEnd = AISLOP_MD_BODY.indexOf(NEXT_SECTION_HEADING, editInstructionsBegin);
const KIMI_RULES_BODY =
	`${AISLOP_MD_BODY.slice(0, editInstructionsBegin)}Kimi Code uses these instructions without a runtime callback. After editing files, run \`aislop scan\` and act on its findings in the same turn.${AISLOP_MD_BODY.slice(editInstructionsEnd)}`.replace(
		/^- The findings payload includes .*$/m,
		"- Treat the terminal output from `aislop scan` as the plan for the turn.",
	);
const RULES_HASH = sentinelHash(KIMI_RULES_BODY);
const RULES_BEGIN_MARKER_PATTERN = /<!--\s*aislop:begin\s+v1\s+hash=([^\s>]+)\s*-->/;
const RULES_END_MARKER = "<!-- aislop:end v1 -->";
const RULES_MARKER_PATTERN = /<!--\s*aislop:(?:begin|end)\b/;

const joinRemainingContent = (before: string, after: string): string => {
	const trimmedBefore = before.trimEnd();
	const trimmedAfter = after.trimStart().trimEnd();
	if (trimmedBefore && trimmedAfter) return `${trimmedBefore}\n\n${trimmedAfter}\n`;
	if (trimmedBefore) return `${trimmedBefore}\n`;
	if (trimmedAfter) return `${trimmedAfter}\n`;
	return "";
};

const legacyHookRange = (content: string): { begin: number; end: number } | null => {
	const begin = content.indexOf(LEGACY_BEGIN_MARKER);
	const end = content.indexOf(LEGACY_END_MARKER, begin + LEGACY_BEGIN_MARKER.length);
	if (begin < 0 || end < 0) return null;

	const markedContent = content.slice(begin, end + LEGACY_END_MARKER.length);
	try {
		const hooks = parse(markedContent).hooks;
		const isManagedHook = (value: unknown): boolean => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const hook = value as Record<string, unknown>;
			return (
				hook.event === "PostToolUse" &&
				hook.matcher === "Write" &&
				hook.command === "aislop hook kimi" &&
				hook.timeout === 15
			);
		};
		if (!Array.isArray(hooks) || !hooks.some(isManagedHook)) return null;
	} catch {
		return null;
	}

	return { begin, end: end + LEGACY_END_MARKER.length };
};

const withoutLegacyHook = (content: string): string => {
	const range = legacyHookRange(content);
	if (!range) return content;
	return joinRemainingContent(content.slice(0, range.begin), content.slice(range.end));
};

const managedRulesRange = (content: string): { begin: number; end: number } | null => {
	const beginMatch = content.match(RULES_BEGIN_MARKER_PATTERN);
	if (!beginMatch || beginMatch.index === undefined) return null;
	const begin = beginMatch.index;
	const afterBegin = begin + beginMatch[0].length;
	const end = content.indexOf(RULES_END_MARKER, afterBegin);
	if (end < 0) return null;
	const body = content.slice(afterBegin, end);
	if (!body.startsWith("\n") || !body.endsWith("\n")) return null;
	const renderedBody = body.slice(1, -1);
	const declaredHash = beginMatch[1];
	if (
		declaredHash !== sentinelHash(renderedBody) &&
		declaredHash !== sentinelHash(`${renderedBody}\n`)
	) {
		return null;
	}
	return { begin, end: end + RULES_END_MARKER.length };
};

export const hasManagedKimiRules = (content: string | null): boolean =>
	content !== null && managedRulesRange(content) !== null;

const withoutManagedRules = (content: string): string => {
	const range = managedRulesRange(content);
	if (!range) return content;
	return joinRemainingContent(content.slice(0, range.begin), content.slice(range.end));
};

const hasUnmanagedRulesMarker = (content: string): boolean => {
	const range = managedRulesRange(content);
	if (!range) return RULES_MARKER_PATTERN.test(content);
	return (
		RULES_MARKER_PATTERN.test(content.slice(0, range.begin)) ||
		RULES_MARKER_PATTERN.test(content.slice(range.end))
	);
};

const replaceExistingFilePreservingMode = (targetPath: string, content: string): void => {
	const existingMode = fs.statSync(targetPath).mode & 0o777;
	const directory = path.dirname(targetPath);
	const randomSuffix = Math.random().toString(36).slice(2, 10);
	const temporaryPath = path.join(directory, `.aislop-tmp-${process.pid}-${randomSuffix}`);
	let ownsTemporaryPath = false;
	try {
		const fileDescriptor = fs.openSync(temporaryPath, "wx", existingMode);
		ownsTemporaryPath = true;
		try {
			fs.writeFileSync(fileDescriptor, content, "utf8");
			fs.fchmodSync(fileDescriptor, existingMode);
		} finally {
			fs.closeSync(fileDescriptor);
		}
		fs.renameSync(temporaryPath, targetPath);
		ownsTemporaryPath = false;
	} finally {
		if (ownsTemporaryPath && fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
	}
};

const applyKimiConfigurationContent = (
	result: HookInstallResult,
	opts: HookInstallOpts,
	targetPath: string,
	nextContent: string,
	summary: string,
): void => {
	if (opts.dryRun) {
		result.planned.push({ path: targetPath, summary });
		return;
	}
	replaceExistingFilePreservingMode(targetPath, nextContent);
	result.wrote.push(targetPath);
};

const applyKimiConfigurationRemoval = (
	result: HookUninstallResult,
	opts: Omit<HookInstallOpts, "qualityGate">,
	targetPath: string,
	nextContent: string,
): void => {
	if (opts.dryRun) {
		result.removed.push(targetPath);
		return;
	}
	replaceExistingFilePreservingMode(targetPath, nextContent);
	result.removed.push(targetPath);
};

export const resolveKimiPaths = (opts: HookInstallOpts) => {
	const kimiHome = process.env.KIMI_CODE_HOME || path.join(opts.home, ".kimi-code");
	return {
		rules: path.join(kimiHome, "AGENTS.md"),
		configuration: path.join(kimiHome, "config.toml"),
	};
};

export const installKimi = (opts: HookInstallOpts): HookInstallResult => {
	const paths = resolveKimiPaths(opts);
	const rules = readIfExists(paths.rules);
	const hasUnmanagedMarker = rules !== null && hasUnmanagedRulesMarker(rules);
	const result = emptyResult();
	if (hasUnmanagedMarker) {
		result.skipped.push(paths.rules);
	} else {
		const nextRules = upsertMarkdownFence(rules, KIMI_RULES_BODY, RULES_HASH).nextContent;
		applyContent(result, opts, paths.rules, nextRules, "write AGENTS.md rules for Kimi Code");
	}
	const configuration = readIfExists(paths.configuration);
	if (configuration !== null) {
		const nextConfiguration = withoutLegacyHook(configuration);
		if (nextConfiguration !== configuration) {
			applyKimiConfigurationContent(
				result,
				opts,
				paths.configuration,
				nextConfiguration,
				"remove obsolete Kimi PostToolUse hook",
			);
		}
	}
	return result;
};

export const uninstallKimi = (opts: Omit<HookInstallOpts, "qualityGate">): HookUninstallResult => {
	const paths = resolveKimiPaths(opts);
	const rules = readIfExists(paths.rules);
	const result: HookUninstallResult = { removed: [], skipped: [] };
	if (hasManagedKimiRules(rules)) {
		const nextRules = withoutManagedRules(rules ?? "");
		applyRemoval(result, opts, paths.rules, nextRules || null);
	} else {
		result.skipped.push(paths.rules);
	}

	const configuration = readIfExists(paths.configuration);
	if (configuration !== null) {
		const nextConfiguration = withoutLegacyHook(configuration);
		if (nextConfiguration !== configuration) {
			if (nextConfiguration) {
				applyKimiConfigurationRemoval(result, opts, paths.configuration, nextConfiguration);
			} else {
				applyRemoval(result, opts, paths.configuration, null);
			}
		}
	}
	return result;
};
