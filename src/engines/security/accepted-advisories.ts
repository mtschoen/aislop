import type { AislopConfig } from "../../config/schema.js";
import type { DependencyAdvisory, Diagnostic } from "../types.js";
import { UNIDENTIFIED_ADVISORY_ID } from "./audit-shared.js";

type AcceptedAdvisory = AislopConfig["security"]["acceptedAdvisories"][number];

interface AcceptanceOptions {
	// Calendar date (YYYY-MM-DD) the `expires` field of an entry is compared against.
	today: string;
	// False when an audit source failed or none ran: an entry that matched nothing
	// then proves nothing, so it is not reported as stale.
	auditCompleted: boolean;
}

const VULNERABLE_DEPENDENCY_RULE = "security/vulnerable-dependency";
const ACCEPTED_ADVISORY_RULE = "security/accepted-advisory";
const STALE_ACCEPTED_ADVISORY_RULE = "security/stale-accepted-advisory";
const OPTION_PATH = "security.acceptedAdvisories";
const CONFIG_FILE_PATH = ".aislop/config.yml";

// True for the two diagnostics this module produces. They record a decision the
// project already made in its configuration, so the CI baseline does not count them
// as new findings.
export const isAdvisoryAcceptanceRecord = (diagnostic: Diagnostic): boolean =>
	diagnostic.rule === ACCEPTED_ADVISORY_RULE || diagnostic.rule === STALE_ACCEPTED_ADVISORY_RULE;

export const dateStamp = (date: Date): string => {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
};

const sameText = (left: string, right: string): boolean =>
	left.trim().toLowerCase() === right.trim().toLowerCase();

const isExpired = (entry: AcceptedAdvisory, today: string): boolean =>
	entry.expires !== undefined && entry.expires < today;

const entryCovers = (
	entry: AcceptedAdvisory,
	diagnostic: Diagnostic,
	advisory: DependencyAdvisory,
): boolean => {
	if (advisory.id === UNIDENTIFIED_ADVISORY_ID) return false;
	if (entry.package !== undefined && !sameText(entry.package, diagnostic.packageName ?? "")) {
		return false;
	}
	return [advisory.id, ...(advisory.aliases ?? [])].some((id) => sameText(id, entry.id));
};

interface AdvisoryReview {
	advisory: DependencyAdvisory;
	accepted?: AcceptedAdvisory;
	expired?: AcceptedAdvisory;
}

const describeAdvisory = (review: AdvisoryReview): string => {
	const aliases = review.advisory.aliases?.length
		? ` (also ${review.advisory.aliases.join(", ")})`
		: "";
	return `${review.advisory.id}${aliases}${review.accepted ? " [accepted]" : ""}`;
};

const describeAcceptance = (review: AdvisoryReview): string => {
	const expiry = review.accepted?.expires ? `; expires ${review.accepted.expires}` : "";
	return `${review.advisory.id} (${review.accepted?.reason.trim()}${expiry})`;
};

const acceptedDiagnostic = (diagnostic: Diagnostic, reviews: AdvisoryReview[]): Diagnostic => ({
	...diagnostic,
	rule: ACCEPTED_ADVISORY_RULE,
	severity: "info",
	message: `${diagnostic.message} [accepted]`,
	help: `Accepted in ${OPTION_PATH}: ${reviews.map(describeAcceptance).join("; ")}.`,
});

const openDiagnostic = (diagnostic: Diagnostic, reviews: AdvisoryReview[]): Diagnostic => {
	const open = reviews.filter((review) => !review.accepted);
	const notes = [`Advisories: ${reviews.map(describeAdvisory).join(", ")}.`];
	if (open.length < reviews.length) {
		notes.push(`Not accepted: ${open.map((review) => review.advisory.id).join(", ")}.`);
	}
	for (const review of open) {
		if (!review.expired) continue;
		notes.push(
			`Failing again: the acceptance of ${review.advisory.id} expired on ${review.expired.expires}.`,
		);
	}
	return { ...diagnostic, help: [diagnostic.help, ...notes].filter(Boolean).join(" ") };
};

const staleDiagnostic = (entry: AcceptedAdvisory, today: string): Diagnostic => {
	const scope = entry.package ? ` for ${entry.package}` : "";
	const expiry = isExpired(entry, today) ? ` It also expired on ${entry.expires}.` : "";
	return {
		filePath: CONFIG_FILE_PATH,
		engine: "security",
		rule: STALE_ACCEPTED_ADVISORY_RULE,
		severity: "info",
		message: `Accepted advisory ${entry.id.trim()}${scope} matches nothing in the current dependency audit`,
		help: `Remove the entry from ${OPTION_PATH}: the audit no longer reports this advisory.${expiry}`,
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
	};
};

/**
 * Applies the `security.acceptedAdvisories` list to dependency-audit findings.
 *
 * A package finding becomes a score-neutral `security/accepted-advisory` only when
 * every advisory behind it has a live entry; otherwise it keeps its rule and
 * severity, and its help names the advisories (and which ones are not accepted).
 * Entries that matched no advisory are reported as stale once the audit completed.
 */
export const applyAcceptedAdvisories = (
	diagnostics: Diagnostic[],
	entries: AcceptedAdvisory[],
	options: AcceptanceOptions,
): Diagnostic[] => {
	const matched = new Set<AcceptedAdvisory>();

	const review = (diagnostic: Diagnostic, advisory: DependencyAdvisory): AdvisoryReview => {
		const covering = entries.filter((entry) => entryCovers(entry, diagnostic, advisory));
		for (const entry of covering) matched.add(entry);
		return {
			advisory,
			accepted: covering.find((entry) => !isExpired(entry, options.today)),
			expired: covering.find((entry) => isExpired(entry, options.today)),
		};
	};

	const reviewed = diagnostics.map((diagnostic) => {
		if (diagnostic.rule !== VULNERABLE_DEPENDENCY_RULE || !diagnostic.advisories?.length) {
			return diagnostic;
		}
		const reviews = diagnostic.advisories.map((advisory) => review(diagnostic, advisory));
		return reviews.every((entry) => entry.accepted)
			? acceptedDiagnostic(diagnostic, reviews)
			: openDiagnostic(diagnostic, reviews);
	});

	if (!options.auditCompleted) return reviewed;
	const stale = entries
		.filter((entry) => !matched.has(entry))
		.map((entry) => staleDiagnostic(entry, options.today));
	return [...reviewed, ...stale];
};
