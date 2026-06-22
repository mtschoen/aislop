import path from "node:path";
import { runSubprocess } from "../../utils/subprocess.js";
import { findCppSources } from "../cpp-targets.js";
import type { Diagnostic, EngineContext, Severity } from "../types.js";

export interface CppLintConfig {
	cppcheck: boolean;
	clangTidy: boolean;
	cppcheckEnable: string;
}

export const CPP_LINT_DEFAULTS: CppLintConfig = {
	cppcheck: true,
	clangTidy: true,
	cppcheckEnable: "warning,performance,portability",
};

export const resolveCppLintConfig = (context: EngineContext): CppLintConfig => {
	const cpp = context.config.lint.cpp;
	if (!cpp) return CPP_LINT_DEFAULTS;
	return {
		cppcheck: cpp.cppcheck,
		clangTidy: cpp.clangTidy,
		cppcheckEnable: cpp.cppcheckEnable,
	};
};

// cppcheck severities -> aislop severity. `information` is dropped (noise like
// missingInclude); everything actionable maps to error or warning.
const SEVERITY_MAP: Record<string, Severity | undefined> = {
	error: "error",
	warning: "warning",
	performance: "warning",
	portability: "warning",
	style: "warning",
};

const decodeEntities = (value: string): string =>
	value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string =>
	new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? "";

// Defensive regex parse (no XML dependency), mirroring parseRoslynatorXml. cppcheck
// emits each finding as <error ...><location .../></error>; entries without a
// <location> (e.g. whole-program notes) are skipped.
export const parseCppcheckXml = (xml: string, rootDirectory: string): Diagnostic[] => {
	if (!xml || !xml.includes("<error")) return [];
	const out: Diagnostic[] = [];
	for (const block of xml.match(/<error\b[\s\S]*?<\/error>/g) ?? []) {
		const open = /<error\b[^>]*>/.exec(block)?.[0] ?? "";
		const severity = SEVERITY_MAP[attr(open, "severity")];
		if (!severity) continue;
		const loc = /<location\b[^>]*>/.exec(block)?.[0];
		if (!loc) continue;
		const file = attr(loc, "file");
		if (!file) continue;
		out.push({
			filePath: path.isAbsolute(file) ? path.relative(rootDirectory, file) : file,
			engine: "lint",
			rule: `cppcheck/${attr(open, "id")}`,
			severity,
			message: decodeEntities(attr(open, "msg")),
			help: "",
			line: Number(attr(loc, "line")) || 1,
			column: Number(attr(loc, "column")) || 1,
			category: "C++ Lint",
			fixable: false,
		});
	}
	return out;
};

export const runCppcheck = async (context: EngineContext): Promise<Diagnostic[]> => {
	const sources = findCppSources(context);
	if (sources.length === 0) return [];
	const config = resolveCppLintConfig(context);
	try {
		// cppcheck writes its XML report to STDERR.
		const result = await runSubprocess(
			"cppcheck",
			[
				`--enable=${config.cppcheckEnable}`,
				"--inline-suppr",
				"--quiet",
				"--xml",
				"--xml-version=2",
				...sources,
			],
			{ cwd: context.rootDirectory, timeout: 180000 },
		);
		return parseCppcheckXml(result.stderr, context.rootDirectory);
	} catch {
		return [];
	}
};
