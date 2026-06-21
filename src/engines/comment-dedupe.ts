import type { EngineResult } from "./types.js";

// Comment-shaped ai-slop rules that can legitimately fire on the SAME comment.
// `narrative-comment` and `meta-comment` both inspect comment blocks, so a single
// comment ("we used to do X, now we do Y") can satisfy both - which double-counts
// one underlying issue under two rule IDs and inflates the score impact.
const COMMENT_RULES = new Set(["ai-slop/narrative-comment", "ai-slop/meta-comment"]);

// Keep at most one comment-rule finding per file:line. The first finding at a
// location wins (engine order is stable), so the dedupe is deterministic. Findings
// outside COMMENT_RULES, and non-ai-slop engines, pass through untouched.
export const dedupeOverlappingComments = (results: EngineResult[]): EngineResult[] =>
	results.map((result) => {
		if (result.engine !== "ai-slop") return result;
		const seen = new Set<string>();
		return {
			...result,
			diagnostics: result.diagnostics.filter((diagnostic) => {
				if (!COMMENT_RULES.has(diagnostic.rule)) return true;
				const key = `${diagnostic.filePath}:${diagnostic.line}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}),
		};
	});
