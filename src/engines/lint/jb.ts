import path from "node:path";
import type { Diagnostic, Severity } from "../types.js";

export type JbSeverity = "ERROR" | "WARNING" | "SUGGESTION" | "HINT";

export interface JbParseOptions {
	excludeTypes: Set<string>;
	severityFloor: JbSeverity;
}

const SEVERITY_RANK: Record<JbSeverity, number> = { HINT: 0, SUGGESTION: 1, WARNING: 2, ERROR: 3 };

// jb elevates style nits (e.g. CS9191) to ERROR, so an ERROR is not a bug
// signal. Map ERROR/WARNING to aislop "warning" and the advisory tiers to
// "info"; scoring weights the rest.
const toAislopSeverity = (severity: JbSeverity): Severity =>
	SEVERITY_RANK[severity] >= SEVERITY_RANK.WARNING ? "warning" : "info";

const decodeEntities = (value: string): string =>
	value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");

const attribute = (tag: string, name: string): string | null => {
	const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	return match ? decodeEntities(match[1]) : null;
};

const asSeverity = (raw: string | null): JbSeverity =>
	raw === "ERROR" || raw === "SUGGESTION" || raw === "HINT" ? raw : "WARNING";

// Regex parse (no XML dependency, matching dotnet.ts). Builds a TypeId->Severity
// map from <IssueType> tags, then maps each <Issue> tag to a Diagnostic.
export const parseJbXml = (
	xml: string,
	rootDirectory: string,
	options: JbParseOptions,
): Diagnostic[] => {
	try {
		const severityByType = new Map<string, JbSeverity>();
		const typeTagRe = /<IssueType\b[^>]*\/?>/g;
		let typeTag = typeTagRe.exec(xml);
		while (typeTag !== null) {
			const id = attribute(typeTag[0], "Id");
			if (id) severityByType.set(id, asSeverity(attribute(typeTag[0], "Severity")));
			typeTag = typeTagRe.exec(xml);
		}

		const result: Diagnostic[] = [];
		const floorRank = SEVERITY_RANK[options.severityFloor];
		const issueTagRe = /<Issue\b[^>]*\/?>/g;
		let issueTag = issueTagRe.exec(xml);
		while (issueTag !== null) {
			const tag = issueTag[0];
			issueTag = issueTagRe.exec(xml);
			const typeId = attribute(tag, "TypeId");
			const file = attribute(tag, "File");
			if (!typeId || !file || options.excludeTypes.has(typeId)) continue;
			const severity = severityByType.get(typeId) ?? "WARNING";
			if (SEVERITY_RANK[severity] < floorRank) continue;

			const normalized = file.replace(/\\/g, "/");
			const relative = path.isAbsolute(normalized)
				? path.relative(rootDirectory, normalized).replace(/\\/g, "/")
				: normalized;
			const lineRaw = attribute(tag, "Line");
			result.push({
				filePath: relative,
				engine: "lint",
				rule: `jb/${typeId}`,
				severity: toAislopSeverity(severity),
				message: attribute(tag, "Message") ?? "",
				help: "",
				line: lineRaw ? Number(lineRaw) : 1,
				column: 1,
				category: "C# Lint",
				fixable: false,
			});
		}
		return result;
	} catch {
		return [];
	}
};
