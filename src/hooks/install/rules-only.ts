import { type HookRegistration, renderAislopMdBody } from "../assets.js";
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

interface RulesOnlyPaths {
	rules: string;
	host?: string;
	marker?: string;
}

export const installRulesOnly = (
	opts: HookInstallOpts,
	paths: RulesOnlyPaths,
	summary: string,
	hook?: HookRegistration,
): HookInstallResult => {
	const result = emptyResult();

	const existing = readIfExists(paths.rules);
	const body = renderAislopMdBody(hook);
	const hash = sentinelHash(body);
	const next = upsertMarkdownFence(existing, body, hash).nextContent;
	applyContent(result, opts, paths.rules, next, summary);

	if (paths.host && paths.marker) {
		const host = readIfExists(paths.host) ?? "";
		if (!host.includes(paths.marker)) {
			const joiner = host.endsWith("\n") || host.length === 0 ? "" : "\n";
			const prefix = host.length === 0 ? "" : `${host}${joiner}\n`;
			applyContent(
				result,
				opts,
				paths.host,
				`${prefix}${paths.marker}\n`,
				`append ${paths.marker} reference`,
			);
		} else {
			result.skipped.push(paths.host);
		}
	}

	return result;
};

export const uninstallRulesOnly = (
	opts: Omit<HookInstallOpts, "qualityGate">,
	paths: RulesOnlyPaths,
): HookUninstallResult => {
	const result: HookUninstallResult = { removed: [], skipped: [] };

	const existing = readIfExists(paths.rules);
	if (existing != null) applyRemoval(result, opts, paths.rules, null);
	else result.skipped.push(paths.rules);

	if (paths.host && paths.marker) {
		const host = readIfExists(paths.host);
		if (host?.includes(paths.marker)) {
			const stripped = host
				.split("\n")
				.filter((l) => l.trim() !== paths.marker)
				.join("\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			applyRemoval(result, opts, paths.host, stripped.length === 0 ? null : `${stripped}\n`);
		} else {
			result.skipped.push(paths.host);
		}
	}

	return result;
};
