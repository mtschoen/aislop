import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Diagnostic, EngineName } from "../engines/types.js";
import { toProjectPath } from "../utils/source-file-policy.js";
import {
	BASELINE_VERSION,
	type Baseline,
	type BaselineEntry,
	sortEntries,
} from "./baseline-file.js";

export interface BaselineMatch {
	diagnostics: Diagnostic[];
	accepted: number;
	newFindings: number;
	stale: BaselineEntry[];
	staleCount: number;
}

interface MatchInput {
	baseline: Baseline;
	diagnostics: Diagnostic[];
	rootDirectory: string;
	scopeFiles: Set<string> | null;
	staleEngines: Set<EngineName>;
}

const MESSAGE_FINGERPRINT_PREFIX = "message:";

const fingerprintOf = (text: string): string =>
	createHash("sha256").update(text.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 16);

const IN_PROCESS_ENGINES = new Set<EngineName>(["ai-slop", "code-quality", "architecture"]);
const TOOL_BACKED_RULE_PREFIXES = ["knip/"];

const isInProcessRule = (entry: BaselineEntry): boolean =>
	IN_PROCESS_ENGINES.has(entry.engine) &&
	!TOOL_BACKED_RULE_PREFIXES.some((prefix) => entry.rule.startsWith(prefix));

const isFileLevel = (fingerprint: string): boolean =>
	fingerprint === "" || fingerprint.startsWith(MESSAGE_FINGERPRINT_PREFIX);

const createSourceCache = (rootDirectory: string) => {
	const lines = new Map<string, string[] | null>();
	const fingerprints = new Map<string, Map<string, number>>();
	const linesOf = (file: string): string[] | null => {
		if (!lines.has(file)) {
			try {
				lines.set(file, fs.readFileSync(path.join(rootDirectory, file), "utf-8").split(/\r?\n/));
			} catch {
				lines.set(file, null);
			}
		}
		return lines.get(file) ?? null;
	};
	return {
		exists: (file: string): boolean => linesOf(file) !== null,
		line: (file: string, line: number): string => linesOf(file)?.[line - 1] ?? "",
		occurrences: (file: string, fingerprint: string): number => {
			let counts = fingerprints.get(file);
			if (!counts) {
				counts = new Map();
				for (const text of linesOf(file) ?? []) {
					const key = fingerprintOf(text);
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
				fingerprints.set(file, counts);
			}
			return counts.get(fingerprint) ?? 0;
		},
	};
};

type SourceCache = ReturnType<typeof createSourceCache>;

const fileLevelStale = (entry: BaselineEntry, left: number, sources: SourceCache): number =>
	isInProcessRule(entry) || !sources.exists(entry.file) ? left : 0;

interface Keyed {
	diagnostic: Diagnostic;
	key: string;
	entry: Omit<BaselineEntry, "count">;
}

const keyOf = (entry: Pick<BaselineEntry, "rule" | "file" | "fingerprint">): string =>
	`${entry.rule}\u0000${entry.file}\u0000${entry.fingerprint}`;

const keyDiagnostics = (
	diagnostics: Diagnostic[],
	rootDirectory: string,
	sources: SourceCache,
): Keyed[] =>
	diagnostics.map((diagnostic) => {
		const file = toProjectPath(rootDirectory, diagnostic.filePath);
		const fingerprint =
			diagnostic.line > 0
				? fingerprintOf(sources.line(file, diagnostic.line))
				: `${MESSAGE_FINGERPRINT_PREFIX}${fingerprintOf(diagnostic.message)}`;
		const entry = { rule: diagnostic.rule, engine: diagnostic.engine, file, fingerprint };
		return { diagnostic, key: keyOf(entry), entry };
	});

export const buildBaseline = (diagnostics: Diagnostic[], rootDirectory: string): Baseline => {
	const entries = new Map<string, BaselineEntry>();
	const sources = createSourceCache(rootDirectory);
	for (const { key, entry } of keyDiagnostics(diagnostics, rootDirectory, sources)) {
		const existing = entries.get(key);
		if (existing) existing.count += 1;
		else entries.set(key, { ...entry, count: 1 });
	}
	return { version: BASELINE_VERSION, entries: sortEntries([...entries.values()]) };
};

export const matchBaseline = (input: MatchInput): BaselineMatch => {
	const remaining = new Map<string, number>();
	for (const entry of input.baseline.entries) {
		remaining.set(keyOf(entry), (remaining.get(keyOf(entry)) ?? 0) + entry.count);
	}
	let accepted = 0;
	const sources = createSourceCache(input.rootDirectory);
	const diagnostics = keyDiagnostics(input.diagnostics, input.rootDirectory, sources).map(
		({ diagnostic, key }) => {
			const left = remaining.get(key) ?? 0;
			if (left === 0) return diagnostic;
			remaining.set(key, left - 1);
			accepted += 1;
			return { ...diagnostic, baselined: true };
		},
	);
	const stale: BaselineEntry[] = [];
	for (const entry of input.baseline.entries) {
		const key = keyOf(entry);
		const left = Math.min(remaining.get(key) ?? 0, entry.count);
		if (left === 0) continue;
		remaining.set(key, (remaining.get(key) ?? 0) - left);
		if (input.scopeFiles && !input.scopeFiles.has(entry.file)) continue;
		if (!input.staleEngines.has(entry.engine)) continue;
		// A physical line may produce several diagnostics; its count cannot prove an allowance stale.
		const unconfirmed = isFileLevel(entry.fingerprint)
			? fileLevelStale(entry, left, sources)
			: sources.occurrences(entry.file, entry.fingerprint) > 0
				? 0
				: left;
		if (unconfirmed > 0) stale.push({ ...entry, count: unconfirmed });
	}
	return {
		diagnostics,
		accepted,
		newFindings: diagnostics.length - accepted,
		stale,
		staleCount: stale.reduce((sum, entry) => sum + entry.count, 0),
	};
};

export const pruneBaseline = (baseline: Baseline, match: BaselineMatch): Baseline => {
	const staleByKey = new Map<string, number>();
	for (const entry of match.stale) {
		const key = keyOf(entry);
		staleByKey.set(key, (staleByKey.get(key) ?? 0) + entry.count);
	}
	const entries = baseline.entries
		.map((entry) => {
			const key = keyOf(entry);
			const stale = Math.min(entry.count, staleByKey.get(key) ?? 0);
			staleByKey.set(key, (staleByKey.get(key) ?? 0) - stale);
			return { ...entry, count: entry.count - stale };
		})
		.filter((entry) => entry.count > 0);
	return { version: BASELINE_VERSION, entries: sortEntries(entries) };
};
