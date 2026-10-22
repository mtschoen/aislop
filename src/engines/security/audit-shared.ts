import type { DependencyAdvisory, Diagnostic } from "../types.js";

// `completed` is false when the audit tool could not be started, failed, or printed
// something other than its report. Its findings are then not the whole picture, so
// nothing may be concluded from an advisory being absent.
export interface AuditOutcome {
	diagnostics: Diagnostic[];
	completed: boolean;
}

export const incompleteAudit = (): AuditOutcome => ({ diagnostics: [], completed: false });

export const SKIPPED_AUDIT_RULE = "security/dependency-audit-skipped";

export const skippedAuditDiagnostic = (
	filePath: string,
	tool: string,
	help: string,
): Diagnostic => ({
	filePath,
	engine: "security",
	rule: SKIPPED_AUDIT_RULE,
	severity: "warning",
	message: `Dependency audit did not complete (${tool})`,
	help,
	line: 0,
	column: 0,
	category: "Security",
	fixable: false,
});

// An audit that did not complete must never read as a clean result, so it carries the
// visible skipped-audit warning in front of whatever findings could still be read.
export const warnWhenIncomplete = (outcome: AuditOutcome, skipped: Diagnostic): AuditOutcome =>
	outcome.completed
		? outcome
		: { diagnostics: [skipped, ...outcome.diagnostics], completed: false };

export const SEVERITY_RANK: Record<string, number> = {
	critical: 4,
	high: 3,
	moderate: 2,
	low: 1,
};

// Audit tools that exit 1 precisely when they find vulnerabilities (cargo audit,
// pip-audit, bun audit) completed when they exit 0, or exit 1 and printed a report
// that does list findings. Any other status, or exit 1 with nothing listed, is a
// failed run whose report proves nothing about what is absent.
export const exitedAsAuditTool = (exitCode: number | null, foundFindings: boolean): boolean =>
	exitCode === 0 || (exitCode === 1 && foundFindings);

export const toSeverity = (value: string): "error" | "warning" =>
	value === "critical" || value === "high" ? "error" : "warning";

// Placeholder for an advisory the audit source reported without any identifier.
// It keeps the advisory counted, and an acceptance entry can never match it.
export const UNIDENTIFIED_ADVISORY_ID = "unidentified";

const ADVISORY_ID_SEGMENT = /^GHSA(-[a-z0-9]{4}){3}$/i;

// Recognized shape: http(s)://<host>/advisories/<GitHub advisory id>, optionally
// followed by a trailing slash. The id must be that whole path segment: an id in the query string,
// in the fragment, as part of a longer segment or deeper in the path names nothing.
export const advisoryIdFromUrl = (url: string | undefined): string | undefined => {
	if (!url) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
	const [leading, collection, identifier, ...rest] = parsed.pathname.replace(/\/$/, "").split("/");
	if (leading !== "" || collection !== "advisories" || rest.length > 0) return undefined;
	return identifier !== undefined && ADVISORY_ID_SEGMENT.test(identifier) ? identifier : undefined;
};

const readIdentifiers = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
		: [];

// The first identifier found names the advisory; the rest are kept as aliases so an
// acceptance may be written against whichever id the user has (GHSA, CVE, ...).
export const toDependencyAdvisory = (
	identifiers: Array<string | undefined>,
	aliases?: unknown,
): DependencyAdvisory => {
	const named = identifiers.filter((id): id is string => id !== undefined && id !== "");
	const known = [...new Set([...named, ...readIdentifiers(aliases)])];
	const [id, ...rest] = known;
	if (id === undefined) return { id: UNIDENTIFIED_ADVISORY_ID };
	return rest.length > 0 ? { id, aliases: rest } : { id };
};

const unionAliases = (left: DependencyAdvisory, right: DependencyAdvisory): DependencyAdvisory => {
	const aliases = [...new Set([...(left.aliases ?? []), ...(right.aliases ?? [])])];
	return aliases.length > 0 ? { id: left.id, aliases } : { id: left.id };
};

// Two reports of the same advisory (same primary id) become one entry carrying the
// aliases of both. Unidentified advisories never merge: each stays counted.
export const mergeAdvisories = (
	existing: DependencyAdvisory[],
	incoming: DependencyAdvisory[],
): DependencyAdvisory[] => {
	const merged = [...existing];
	for (const advisory of incoming) {
		const index =
			advisory.id === UNIDENTIFIED_ADVISORY_ID
				? -1
				: merged.findIndex((entry) => entry.id === advisory.id);
		if (index === -1) merged.push(advisory);
		else merged[index] = unionAliases(merged[index], advisory);
	}
	return merged;
};

const DIAGNOSTIC_RANK: Record<string, number> = { error: 3, warning: 2, info: 1 };
const LEVEL_IN_MESSAGE = /\((critical|high|moderate|low)\b/;

const findingRank = (diagnostic: Diagnostic): [number, number] => [
	DIAGNOSTIC_RANK[diagnostic.severity] ?? 0,
	SEVERITY_RANK[LEVEL_IN_MESSAGE.exec(diagnostic.message)?.[1] ?? ""] ?? 0,
];

const outranks = (candidate: Diagnostic, current: Diagnostic): boolean => {
	const [candidateSeverity, candidateLevel] = findingRank(candidate);
	const [currentSeverity, currentLevel] = findingRank(current);
	return candidateSeverity !== currentSeverity
		? candidateSeverity > currentSeverity
		: candidateLevel > currentLevel;
};

const hasAdvisories = (diagnostic: Diagnostic): boolean => (diagnostic.advisories?.length ?? 0) > 0;

// Findings about one package collapse into one: the worse severity wins (never a
// downgrade) and every distinct advisory of every report is kept. A finding with no
// advisory ids stays separate from one that has them, so accepting an identified
// advisory never covers an unidentified finding. Entries without a package name pass
// through untouched.
export const mergeSamePackage = (diagnostics: Diagnostic[]): Diagnostic[] => {
	const byPackage = new Map<string, Diagnostic>();
	const result: Diagnostic[] = [];
	for (const diagnostic of diagnostics) {
		const name = diagnostic.packageName;
		const key = name === undefined ? undefined : `${name}\0${hasAdvisories(diagnostic)}`;
		const earlier = key === undefined ? undefined : byPackage.get(key);
		if (key === undefined || earlier === undefined) {
			result.push(diagnostic);
			if (key !== undefined) byPackage.set(key, diagnostic);
			continue;
		}
		const winner = outranks(diagnostic, earlier) ? diagnostic : earlier;
		const advisories = mergeAdvisories(earlier.advisories ?? [], diagnostic.advisories ?? []);
		const combined = advisories.length > 0 ? { ...winner, advisories } : winner;
		result[result.indexOf(earlier)] = combined;
		byPackage.set(key, combined);
	}
	return result;
};
