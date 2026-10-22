export interface HookRegistration {
	event: string;
	matcher?: string;
	receiver: string;
}

const NO_HOOK_EDIT_SECTION =
	"This harness has no edit hook. After every edit, run `aislop scan --changes` yourself and act on the findings it reports the same turn.";

const describeHook = (hook: HookRegistration): string => {
	const trigger = hook.matcher
		? `A \`${hook.event}\` hook (matcher \`${hook.matcher}\`) runs \`${hook.receiver}\` after every matching file edit.`
		: `A \`${hook.event}\` hook runs \`${hook.receiver}\` after every file edit.`;
	return `${trigger} It scans the touched files and returns findings as JSON shaped like \`AislopFeedback\` (schema \`aislop.hook.v2\` - score, baseline, delta, regressed, counts, findings, newSinceBaseline, suggestedActions). Act on them the same turn; the \`suggestedActions\` field tells you exactly what to run next.`;
};

/** editSection: a HookRegistration, or the literal paragraph for a harness with no edit hook. */
export const renderAislopMdBody = (
	editSection: HookRegistration | string = NO_HOOK_EDIT_SECTION,
): string => `# aislop - agent instructions

[aislop](https://github.com/scanaislop/aislop) is your guardrail for shipping clean, maintainable, production-grade code. It catches the patterns AI coding tools leave behind: dead imports, redundant code, duplicate logic, unsafe any-typed casts, narrative comments, swallowed errors, hidden fallbacks, oversized functions, risky security constructs - and grades the project out of 100 so regressions are visible. Treat its findings as blocking, not advisory: the goal is code a human maintainer would happily inherit.

## On every edit

${typeof editSection === "string" ? editSection : describeHook(editSection)}

## Severity ladder

- \`error\` - MUST fix this turn.
- \`warning\` + \`fixable: true\` - MUST fix this turn.
- \`warning\` + \`fixable: false\` - fix if trivially mechanical, otherwise surface in your reply.

## Rules

- \`.aislop/config.yaml\` - thresholds and engine toggles. Treat as authoritative; don't edit without user consent.
- \`.aislop/rules.yaml\` - project-specific architecture rules (may be absent). When a finding cites \`architecture/*\`, open this file and follow it.
- Custom rules can change between sessions. Trust what the scan returns, not a cached understanding of what the rules are.

## Principles

- Do not disable rules to pass the scan. Fix the underlying issue.
- If a finding is a false positive, leave it and explain in your reply - do not delete the rule config.
- The findings payload includes \`nextSteps[]\` - treat those as your plan for the turn.
`;
