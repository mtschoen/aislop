import type { AislopFeedback } from "../feedback.js";

export const formatPlainTextFeedback = (feedback: AislopFeedback): string => {
	if (feedback.counts.total === 0 && !feedback.regressed) return "";

	const { error, warning } = feedback.counts;
	const header =
		`aislop: score ${feedback.score}/100` +
		`${feedback.baseline != null ? ` (baseline ${feedback.baseline})` : ""}, ` +
		`${error} error${error === 1 ? "" : "s"}, ${warning} warning${warning === 1 ? "" : "s"}.`;
	const lines = feedback.findings.map(
		(finding) =>
			`  - ${finding.file}:${finding.line} [${finding.severity}] ${finding.ruleId}: ${finding.message}`,
	);
	if (feedback.elided && feedback.elided > 0) {
		lines.push(`  ...and ${feedback.elided} more.`);
	}
	const tail = feedback.nextSteps.length > 0 ? `\n${feedback.nextSteps.join("\n")}` : "";
	return `${header}\n${lines.join("\n")}${tail}`;
};
