import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRelativePosix } from "../../utils/paths.js";
import { runSubprocess, truncateFailureDetail } from "../../utils/subprocess.js";
import { resolveBundledJbSettings, resolveToolBinary } from "../../utils/tooling.js";
import { findJbTargets, projectsSkippedNotice } from "../dotnet-targets.js";
import type {
	AnalyzerExecution,
	AnalyzerRunResult,
	Diagnostic,
	EngineContext,
	EngineFailure,
	Severity,
} from "../types.js";
import { resolveCppLintConfig } from "./cppcheck.js";
import {
	buildExecution,
	type CsharpProjectInventory,
	createCsharpProjectInventory,
	getSolutionIndex,
	isSolutionTarget,
	toRelative,
} from "./csharp-execution.js";
import { decodeEntities, xmlAttribute } from "./xml-entities.js";

const JB_TOOL: AnalyzerExecution["tool"] = "jb inspectcode";

export type JbSeverity = "ERROR" | "WARNING" | "SUGGESTION" | "HINT";

interface JbLanguageOptions {
	excludeTypes: Set<string>;
	severityFloor: JbSeverity;
}

interface JbParseOptions {
	csharp: JbLanguageOptions;
	cpp: JbLanguageOptions;
}

const SEVERITY_RANK: Record<JbSeverity, number> = { HINT: 0, SUGGESTION: 1, WARNING: 2, ERROR: 3 };

// jb elevates style nits (e.g. CS9191) to ERROR, so an ERROR is not a bug
// signal. Map ERROR/WARNING to aislop "warning" and the advisory tiers to
// "info"; scoring weights the rest.
const toAislopSeverity = (severity: JbSeverity): Severity =>
	SEVERITY_RANK[severity] >= SEVERITY_RANK.WARNING ? "warning" : "info";

const attribute = (tag: string, name: string): string | null => {
	const value = xmlAttribute(tag, name);
	return value !== null ? decodeEntities(value) : null;
};

const asSeverity = (raw: string | null): JbSeverity =>
	raw === "ERROR" || raw === "SUGGESTION" || raw === "HINT" ? raw : "WARNING";

// Regex parse (no XML dependency, matching dotnet.ts). Builds a TypeId->Severity
// map from <IssueType> tags, then maps each <Issue> tag to a Diagnostic.
// Per-language floors and exclude sets are applied by the "Cpp" prefix test.
// A parse exception propagates so the caller records the target as not-run.
export const parseJbXml = (
	xml: string,
	rootDirectory: string,
	options: JbParseOptions,
): Diagnostic[] => {
	const severityByType = new Map<string, JbSeverity>();
	const typeTagRe = /<IssueType\b[^>]*\/?>/g;
	let typeTag = typeTagRe.exec(xml);
	while (typeTag !== null) {
		const id = attribute(typeTag[0], "Id");
		if (id) severityByType.set(id, asSeverity(attribute(typeTag[0], "Severity")));
		typeTag = typeTagRe.exec(xml);
	}

	const result: Diagnostic[] = [];
	const issueTagRe = /<Issue\b[^>]*\/?>/g;
	let issueTag = issueTagRe.exec(xml);
	while (issueTag !== null) {
		const tag = issueTag[0];
		issueTag = issueTagRe.exec(xml);
		const typeId = attribute(tag, "TypeId");
		const file = attribute(tag, "File");
		if (!typeId || !file) continue;
		const isCpp = typeId.startsWith("Cpp");
		const langOptions = isCpp ? options.cpp : options.csharp;
		if (langOptions.excludeTypes.has(typeId)) continue;
		const severity = severityByType.get(typeId) ?? "WARNING";
		if (SEVERITY_RANK[severity] < SEVERITY_RANK[langOptions.severityFloor]) continue;

		// jb reports File with backslash separators regardless of host OS, and on
		// Linux path.sep never matches them, so normalize before relativizing to
		// keep diagnostic paths forward-slashed on every OS.
		const relative = projectRelativePosix(rootDirectory, file.replace(/\\/g, "/"));
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
			category: isCpp ? "C++ Lint" : "C# Lint",
			fixable: false,
		});
	}
	return result;
};

interface CsharpLintConfig {
	projectEvaluation: boolean;
	jb: boolean;
	roslynator: boolean;
	jbSeverityFloor: JbSeverity;
	jbExcludeTypes: string[];
	jbProjects?: string;
}

const CSHARP_LINT_DEFAULTS: CsharpLintConfig = {
	projectEvaluation: false,
	jb: true,
	roslynator: true,
	jbSeverityFloor: "WARNING",
	jbExcludeTypes: ["InconsistentNaming"],
};

export const resolveCsharpLintConfig = (context: EngineContext): CsharpLintConfig => {
	const raw = context.config.lint.csharp;
	if (!raw) return { ...CSHARP_LINT_DEFAULTS };
	return {
		projectEvaluation: raw.projectEvaluation === true,
		jb: raw.jb,
		roslynator: raw.roslynator,
		jbSeverityFloor: raw.jbSeverityFloor,
		jbExcludeTypes: raw.jbExcludeTypes,
		jbProjects: raw.jbProjects,
	};
};

// XML comments carry no report structure; an unterminated one runs to the end.
const stripXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?(?:-->|$)/g, "");

// jb omits <Project> elements from a report without findings, so a clean
// solution writes a well-formed <Report> with an empty <Issues /> section.
// Completeness is structural: an opened <Report> holding either a
// self-closing <Issues /> or an <Issues> section closed by </Issues>, with
// </Report> ending the document. A bounded shape check, not an XML parser. A
// missing or truncated report (cold cache, killed process) fails it and is
// discarded. See reference_jb_inspectcode_cache.
const COMPLETE_REPORT_SHAPE =
	/<Report\b(?:[^>]*[^/>])?>[\s\S]*?(?:<Issues\b[^>]*\/>|<Issues\b(?:[^>]*[^/>])?>[\s\S]*<\/Issues\s*>)[\s\S]*<\/Report\s*>\s*$/;

const reportLooksComplete = (report: string): boolean => COMPLETE_REPORT_SHAPE.test(report);

const reportHasProject = (report: string): boolean => /<Project\b/.test(report);

const escapeRegExpCharacters = (text: string): string =>
	text.replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`);

// A jb wildcard: '*' matches any run, '?' any single character.
const wildcardToRegExp = (pattern: string): RegExp =>
	new RegExp(
		`^${pattern
			.split("*")
			.map((part) => part.split("?").map(escapeRegExpCharacters).join("."))
			.join(".*")}$`,
		"i",
	);

// jb's --project is a ';'-separated list of project-name wildcards.
const projectNameInScope = (name: string, projectScope: string | undefined): boolean => {
	if (!projectScope) return true;
	return projectScope
		.split(";")
		.filter((pattern) => pattern.length > 0)
		.some((pattern) => wildcardToRegExp(pattern).test(name));
};

// Pick the lower of two severity floors so the inspectcode pre-filter lets both
// languages' issues through; parseJbXml re-applies each language's floor authoritatively.
const minSeverityFloor = (a: JbSeverity, b: JbSeverity): JbSeverity =>
	SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;

const analyzeJbTarget = async (
	context: EngineContext,
	jb: string,
	settings: string | null,
	parseOptions: JbParseOptions,
	coarseFloor: JbSeverity,
	projectScope: string | undefined,
	includeCsharp: boolean,
	includeCpp: boolean,
	target: string,
): Promise<AnalyzerRunResult> => {
	// Fresh caches every run: jb's result cache survives config edits and a cold
	// cache yields partial reports. Removed in the finally block.
	let cachesHome: string | undefined;
	try {
		cachesHome = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-jb-"));
		const outputPath = path.join(cachesHome, "report.xml");
		const args = [
			"inspectcode",
			target,
			"--format=Xml",
			`--output=${outputPath}`,
			`--caches-home=${cachesHome}`,
			// Coarse pre-filter only; parseJbXml re-applies per-language floors.
			`--severity=${coarseFloor}`,
		];
		if (settings) args.push(`--settings=${settings}`);
		if (projectScope) args.push(`--project=${projectScope}`);
		if (includeCsharp) {
			// Solution-wide analysis ensures cross-project symbol usage is indexed,
			// preventing spurious UnusedAutoPropertyAccessor.Global / UnusedMember.Global
			// findings on cold caches.
			args.push("--swea");
		}
		// C++-only inspection does not require an MSBuild build pass.
		// C# inspections require the build pass for project model and intermediate assemblies.
		if (includeCpp && !includeCsharp) {
			args.push("--no-build");
		}
		// jb is slow (solution-wide, with build): allow up to 10 minutes.
		const result = await runSubprocess(jb, args, { cwd: context.rootDirectory, timeout: 600000 });
		if (!fs.existsSync(outputPath)) {
			throw new Error(
				`no report written (exit code ${result.exitCode}): ${truncateFailureDetail(result.stderr || result.stdout || "no output")}`,
			);
		}
		const xml = fs.readFileSync(outputPath, "utf-8");
		const report = stripXmlComments(xml);
		if (!reportLooksComplete(report))
			throw new Error("incomplete report: no closed Report and Issues elements");
		// A report naming a finding-bearing project is accepted at any exit code
		// (the nonzero diagnostic exit policy). A clean report proves nothing on
		// its own, so it counts only after a successful exit.
		if (!reportHasProject(report) && result.exitCode !== 0) {
			throw new Error(
				`clean report after unsuccessful exit (exit code ${result.exitCode}): ${truncateFailureDetail(result.stderr || result.stdout || "no output")}`,
			);
		}
		return {
			diagnostics: parseJbXml(xml, context.rootDirectory, parseOptions),
			failures: [],
		};
	} catch (error) {
		return {
			diagnostics: [],
			failures: includeCsharp
				? [
						{
							tool: JB_TOOL,
							target: projectRelativePosix(context.rootDirectory, target),
							reason: error instanceof Error ? error.message : String(error),
						},
					]
				: [],
		};
	} finally {
		if (cachesHome) {
			try {
				fs.rmSync(cachesHome, { recursive: true, force: true });
			} catch (cleanupError) {
				console.error(
					`aislop: warning: failed to clean up cache directory ${cachesHome}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
		}
	}
};

export const buildJbProjectScope = (
	csharpProjects: string | undefined,
	cppProjects: string | undefined,
): string | undefined => {
	const parts = [csharpProjects, cppProjects].filter((p): p is string => !!p && p.length > 0);
	return parts.length > 0 ? parts.join(";") : undefined;
};

export const runJbLint = async (
	context: EngineContext,
	options: { includeCsharp: boolean; includeCpp: boolean },
	inventory?: CsharpProjectInventory,
): Promise<AnalyzerRunResult> => {
	const csharpInventory = inventory ?? createCsharpProjectInventory(context);
	const selection = findJbTargets(context, csharpInventory);
	// Only the C# side owns the notice: a C++-only inspection has no stake in
	// skipped .csproj projects (and would misattribute them to C++ lint).
	const notice = options.includeCsharp
		? projectsSkippedNotice(selection, context.rootDirectory)
		: [];
	if (selection.targets.length === 0) {
		return {
			diagnostics: notice,
			failures: [],
			executions: options.includeCsharp
				? [
						{
							...buildExecution(context, {
								tool: JB_TOOL,
								failureReasons: [],
								targets: [],
								analyzedProjects: [],
								elapsed: 0,
								inventory: csharpInventory,
							}),
							status: "not-selected",
							reason: "no solution or restored project targets",
						},
					]
				: [],
		};
	}
	const startedAt = Date.now();
	const csharp = resolveCsharpLintConfig(context);
	const cpp = resolveCppLintConfig(context);
	const jbBinary = resolveToolBinary("jb"); // not bundled -> resolves to "jb" on PATH
	const settings = resolveBundledJbSettings();

	const projectScope = buildJbProjectScope(
		options.includeCsharp ? csharp.jbProjects : undefined,
		options.includeCpp ? cpp.jbProjects : undefined,
	);
	const coarseFloor = minSeverityFloor(
		options.includeCsharp ? csharp.jbSeverityFloor : "ERROR",
		options.includeCpp ? cpp.jbSeverityFloor : "ERROR",
	);
	const parseOptions: JbParseOptions = {
		csharp: {
			excludeTypes: new Set(csharp.jbExcludeTypes),
			severityFloor: csharp.jbSeverityFloor,
		},
		cpp: {
			excludeTypes: new Set(cpp.jbExcludeTypes),
			severityFloor: cpp.jbSeverityFloor,
		},
	};

	const diagnostics: Diagnostic[] = [];
	const failures: EngineFailure[] = [];
	const analyzedProjects: string[] = [];
	for (const target of selection.targets) {
		const result = await analyzeJbTarget(
			context,
			jbBinary,
			settings,
			parseOptions,
			coarseFloor,
			projectScope,
			options.includeCsharp,
			options.includeCpp,
			target,
		);
		diagnostics.push(...result.diagnostics);
		failures.push(...result.failures);
		if (result.failures.length === 0) {
			if (isSolutionTarget(target)) {
				// jb reports only finding-bearing projects, so a solution pass records
				// the solution's declared members (restricted to the --project scope
				// and to visible projects), as the roslynator pass does.
				for (const project of getSolutionIndex(csharpInventory, target).csharpProjects) {
					if (
						csharpInventory.visibleProjectsSet.has(project.relativePath) &&
						projectNameInScope(project.name, projectScope)
					) {
						analyzedProjects.push(project.relativePath);
					}
				}
			} else if (projectNameInScope(path.basename(target, path.extname(target)), projectScope)) {
				// jb names a project after its project file; --project scopes this run too.
				analyzedProjects.push(toRelative(context, target));
			}
		}
	}
	const executions = options.includeCsharp
		? [
				buildExecution(context, {
					tool: JB_TOOL,
					failureReasons: failures.map((failure) => `${failure.target}: ${failure.reason}`),
					targets: selection.targets.map((target) => toRelative(context, target)),
					analyzedProjects,
					elapsed: Date.now() - startedAt,
					inventory: csharpInventory,
				}),
			]
		: [];
	return { diagnostics: [...diagnostics, ...notice], failures, executions };
};
