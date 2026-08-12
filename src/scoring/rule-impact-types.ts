export type RuleImpactTier =
	| "strict"
	| "standard"
	| "maintainability"
	| "mechanical"
	| "style"
	| "advisory"
	| "report-only";

export interface RuleScoreImpact {
	tier: RuleImpactTier;
	multiplier: number;
	cap?: number;
	rationale: string;
}
