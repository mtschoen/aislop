import path from "node:path";
import { runSubprocess } from "../../utils/subprocess.js";
import { findCppSources, hasCppOnlySources } from "../cpp-targets.js";
import type { Diagnostic, EngineContext, Severity } from "../types.js";
import type { JbSeverity } from "./jb.js";

export interface CppLintConfig {
	cppcheck: boolean;
	clangTidy: boolean;
	cppcheckEnable: string;
	jb: boolean;
	jbProjects?: string;
	jbSeverityFloor: JbSeverity;
	jbExcludeTypes: string[];
}

export const CPP_LINT_DEFAULTS: CppLintConfig = {
	cppcheck: true,
	clangTidy: true,
	cppcheckEnable: "warning,performance,portability",
	jb: false,
	jbSeverityFloor: "WARNING",
	jbExcludeTypes: [],
};

export const resolveCppLintConfig = (context: EngineContext): CppLintConfig => {
	const cpp = context.config.lint.cpp;
	if (!cpp) return { ...CPP_LINT_DEFAULTS };
	return {
		cppcheck: cpp.cppcheck,
		clangTidy: cpp.clangTidy,
		cppcheckEnable: cpp.cppcheckEnable,
		jb: cpp.jb,
		jbProjects: cpp.jbProjects,
		jbSeverityFloor: cpp.jbSeverityFloor,
		jbExcludeTypes: cpp.jbExcludeTypes,
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

// cppcheck self-diagnostics that signal it could not parse a translation unit,
// not a code defect: they fire when a project macro or system header that the
// real compiler has is missing from cppcheck's flag-free view (e.g. the Windows
// `min`/`max` macros, an unknown attribute). cppcheck's own docs say these are
// unreliable without the build's defines/includes, so a standalone scan
// suppresses them rather than scoring clean code as broken. clang-tidy, which
// does run with the compilation database, remains the source of truth for real
// parse errors.
const PARSE_CONTEXT_SUPPRESSIONS = [
	"syntaxError",
	"unknownMacro",
	"internalAstError",
	"internalError",
] as const;

// Build the cppcheck argv. Pass --language=c++ for C++ trees so cppcheck stops
// treating ambiguous `.h` headers as C and rejecting C++ constructs in them.
export const buildCppcheckArgs = (sources: string[], config: CppLintConfig): string[] => {
	const args = [`--enable=${config.cppcheckEnable}`, "--inline-suppr", "--quiet"];
	if (hasCppOnlySources(sources)) args.push("--language=c++");
	for (const id of PARSE_CONTEXT_SUPPRESSIONS) args.push(`--suppress=${id}`);
	args.push("--xml", "--xml-version=2", ...sources);
	return args;
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
		const result = await runSubprocess("cppcheck", buildCppcheckArgs(sources, config), {
			cwd: context.rootDirectory,
			timeout: 180000,
		});
		return parseCppcheckXml(result.stderr, context.rootDirectory);
	} catch {
		return [];
	}
};
