import path from "node:path";
import type { Diagnostic, EngineConfig, EngineContext } from "../engines/types.js";
import { applyRuleSeverities } from "../scoring/rule-severity.js";
import { matchesGlobList } from "../utils/globs.js";
import type { AislopConfig } from "./schema.js";

type FilePolicy = Pick<EngineConfig, "quality"> &
	Partial<Pick<AislopConfig, "rules" | "overrides">>;

export const overrideRelativePath = (rootDirectory: string, filePath: string): string => {
	const paths =
		path.win32.isAbsolute(rootDirectory) && !path.posix.isAbsolute(rootDirectory)
			? path.win32
			: path.posix;
	const root = rootDirectory.replaceAll("\\", "/");
	const file = filePath.replaceAll("\\", "/");
	return paths
		.normalize(paths.isAbsolute(file) ? paths.relative(root, file) : file)
		.replaceAll("\\", "/");
};

const matchesEntry = (relativePath: string, patterns: string[]): boolean =>
	matchesGlobList(relativePath, patterns, { dot: true });

export const resolveFilePolicy = (config: FilePolicy, relativePath: string) => {
	let quality = config.quality;
	let rules = config.rules ?? {};
	if (
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		path.win32.isAbsolute(relativePath)
	) {
		return { quality, rules };
	}
	for (const entry of config.overrides ?? []) {
		if (!matchesEntry(relativePath, entry.files)) continue;
		if (entry.quality) quality = { ...quality, ...entry.quality };
		if (entry.rules) rules = { ...rules, ...entry.rules };
	}
	return { quality, rules };
};

/**
 * Applies the per-file rule policy (top-level `rules` merged with matching
 * `overrides` entries) to engine diagnostics. Runs for every config, with or
 * without overrides, so rule severities always take effect before the
 * comment dedupe in the orchestrator.
 */
export const applyFileOverrides = (
	diagnostics: Diagnostic[],
	context: EngineContext,
): Diagnostic[] => {
	const { overrides, rules } = context.config;
	if (!overrides?.length && !Object.keys(rules ?? {}).length) return diagnostics;
	return diagnostics.flatMap((diagnostic) => {
		const relativePath = overrideRelativePath(context.rootDirectory, diagnostic.filePath);
		const { rules: fileRules } = resolveFilePolicy(context.config, relativePath);
		return applyRuleSeverities([diagnostic], fileRules);
	});
};
