export const AISLOP_MD_BODY = `# aislop - agent instructions

[aislop](https://github.com/scanaislop/aislop) catches maintainability problems commonly left by coding agents and grades the project out of 100. Treat its feedback as work for the current turn.

## On every edit

When a runtime hook returns \`AislopFeedback\` (schema \`aislop.hook.v2\`), follow its \`nextSteps\` and \`suggestedActions\`. It reports the score, baseline delta, regression state, counts, and findings for touched files.

## Severity ladder

- \`error\`: MUST fix this turn.
- \`warning\` with \`fixable: true\`: MUST fix this turn.
- \`warning\` with \`fixable: false\`: fix if mechanical, otherwise surface it.

## Rules

- \`.aislop/config.yml\`: thresholds and engine toggles. Do not edit without user consent.
- \`.aislop/rules.yml\`: optional project architecture rules. Follow any cited \`architecture/*\` rule.
- Trust the current scan because custom rules can change between sessions.

## Principles

- Fix the underlying issue instead of disabling a rule.
- If a finding is a false positive, leave it and explain why.
`;
