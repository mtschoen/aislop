import { type AuditOutcome, mergeSamePackage, SKIPPED_AUDIT_RULE } from "./audit-shared.js";

// pnpm and npm can read different lockfiles, so a clean or failed npm run never erases a
// vulnerability pnpm already reported, and never makes the failed pnpm audit complete: the
// run is incomplete and keeps pnpm's skipped warning. A package both found is reported once,
// at the worse severity, with every distinct advisory of both.
export const mergeFallbackOutcome = (
	primary: AuditOutcome,
	fallback: AuditOutcome,
): AuditOutcome => {
	const isWarning = (diagnostic: { rule: string }): boolean =>
		diagnostic.rule === SKIPPED_AUDIT_RULE;
	const diagnostics = [...primary.diagnostics, ...fallback.diagnostics];
	return {
		diagnostics: [
			...diagnostics.filter(isWarning),
			...mergeSamePackage(diagnostics.filter((diagnostic) => !isWarning(diagnostic))),
		],
		completed: false,
	};
};
