import { detectInvocation } from "../../ui/invocation.js";

export type JsAuditSource = "npm audit" | "pnpm audit";

export const withFixHint = (rest: string): string => {
	const invocation = detectInvocation();
	const suffix = rest ? ` — ${rest}` : "";
	return `Run \`${invocation} fix -f\` to apply this fix${suffix}`;
};

export const SEVERITY_RANK: Record<string, number> = {
	critical: 4,
	high: 3,
	moderate: 2,
	low: 1,
};

export const toSeverity = (value: string): "error" | "warning" =>
	value === "critical" || value === "high" ? "error" : "warning";
