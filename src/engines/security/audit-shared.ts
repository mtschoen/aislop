import type { DependencyAdvisory, Diagnostic } from "../types.js";

// `completed` is false when the audit tool could not be started, failed, or printed
// something other than its report. Its findings are then not the whole picture, so
// nothing may be concluded from an advisory being absent.
export interface AuditOutcome {
	diagnostics: Diagnostic[];
	completed: boolean;
}

export const incompleteAudit = (): AuditOutcome => ({ diagnostics: [], completed: false });

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
