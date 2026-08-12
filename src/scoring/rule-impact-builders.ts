import type { RuleScoreImpact } from "./rule-impact-types.js";

export const strict = (rationale: string): RuleScoreImpact => ({
	tier: "strict",
	multiplier: 1,
	rationale,
});

export const standard = (rationale: string): RuleScoreImpact => ({
	tier: "standard",
	multiplier: 1,
	rationale,
});

export const maintainability = (rationale: string, cap = 24): RuleScoreImpact => ({
	tier: "maintainability",
	multiplier: 0.75,
	cap,
	rationale,
});

export const mechanical = (rationale: string, cap = 16): RuleScoreImpact => ({
	tier: "mechanical",
	multiplier: 0.5,
	cap,
	rationale,
});

export const style = (rationale: string, cap = 8): RuleScoreImpact => ({
	tier: "style",
	multiplier: 0.5,
	cap,
	rationale,
});

export const advisory = (rationale: string, cap = 8): RuleScoreImpact => ({
	tier: "advisory",
	multiplier: 0.25,
	cap,
	rationale,
});

/**
 * Zero multiplier: the finding is rendered and counted, but contributes nothing to the
 * score and (at info severity) nothing to the exit code. Rollout tier for rules whose
 * backlog has to be measured and swept before anyone can be asked to gate on them.
 */
export const reportOnly = (rationale: string): RuleScoreImpact => ({
	tier: "report-only",
	multiplier: 0,
	rationale,
});
