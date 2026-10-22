import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRelativePosix } from "../../utils/paths.js";
import { runSubprocess, truncateFailureDetail } from "../../utils/subprocess.js";
import { resolveBundledAnalyzerAssemblies, resolveToolBinary } from "../../utils/tooling.js";
import {
	findDotnetTargets,
	hasRestoreEvidence,
	MAXIMUM_PROJECT_TARGETS,
	projectsSkippedNotice,
} from "../dotnet-targets.js";
import type {
	AnalyzerExecution,
	AnalyzerRunResult,
	Diagnostic,
	EngineContext,
	EngineFailure,
} from "../types.js";
import {
	buildExecution,
	type CsharpProjectInventory,
	createCsharpProjectInventory,
	getSolutionIndex,
	isSolutionTarget,
	toRelative,
} from "./csharp-execution.js";
import { decodeEntities } from "./xml-entities.js";

// Diagnostic IDs from the bundled analyzers that map onto aislop's AI-slop thesis.
const RELEVANT_IDS = new Set([
	"AsyncFixer01",
	"AsyncFixer02",
	"AsyncFixer03", // async misuse / sync-over-async
	"MA0040",
	"MA0042",
	"MA0045", // Meziantou async/Task best practices
	"CS0219",
	"CS0162", // unused/unreachable
	"IDISP001", // IDisposableAnalyzers: a created IDisposable is never disposed (resource leak)
]);

interface ParsedDiagnostic {
	id: string;
	message: string;
	filePath: string;
	line: number;
	column: number;
}

// Defensive regex parse (no XML dependency). Matches each <Diagnostic Id="..."> ... </Diagnostic>.
// Summary-section entries have no <FilePath> and are skipped.
const extractDiagnostics = (xml: string): ParsedDiagnostic[] => {
	const result: ParsedDiagnostic[] = [];
	const blockRe = /<Diagnostic\b[^>]*\bId="([^"]+)"[\s\S]*?<\/Diagnostic>/g;
	let block = blockRe.exec(xml);
	while (block !== null) {
		const id = block[1];
		const body = block[0];
		const message = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1] ?? "";
		const filePath = /<FilePath>([\s\S]*?)<\/FilePath>/.exec(body)?.[1] ?? "";
		const location = /<Location\b[^>]*\bLine="(\d+)"[^>]*\bCharacter="(\d+)"/.exec(body);
		block = blockRe.exec(xml);
		if (!filePath) continue;
		result.push({
			id,
			message: decodeEntities(message.trim()),
			filePath: decodeEntities(filePath.trim()),
			line: location ? Number(location[1]) : 1,
			column: location ? Number(location[2]) : 1,
		});
	}
	return result;
};

export const parseRoslynatorXml = (xml: string, rootDirectory: string): Diagnostic[] => {
	let parsed: ParsedDiagnostic[];
	try {
		parsed = extractDiagnostics(xml);
	} catch {
		return [];
	}
	return parsed
		.filter((d) => RELEVANT_IDS.has(d.id))
		.map((d) => ({
			filePath: projectRelativePosix(rootDirectory, d.filePath),
			engine: "lint" as const,
			rule: `dotnet/${d.id}`,
			severity: "warning" as const,
			message: d.message,
			help: "",
			line: d.line,
			column: d.column,
			category: "C# Lint",
			fixable: false,
		}));
};

const ANALYZE_TIMEOUT_MS = 180000;

// The summary roslynator prints on stdout after analysis ("{count} diagnostics found").
const ZERO_DIAGNOSTICS_SUMMARY = /^\s*0 diagnostics found\s*$/m;

// Exit 0 is CommandStatus.Success, which analyze returns only when no diagnostic was
// found (aislop never passes --return-success-on-diagnostics); the summary line
// confirms analysis reached the end rather than exiting early.
const completedWithoutDiagnostics = (result: { stdout: string; exitCode: number | null }) =>
	result.exitCode === 0 && ZERO_DIAGNOSTICS_SUMMARY.test(result.stdout);

type AnalyzeResult =
	| { diagnostics: Diagnostic[]; failed: false }
	| { diagnostics: Diagnostic[]; failed: true; reason: string; timedOut: boolean };

const analyzeTarget = async (
	context: EngineContext,
	roslynator: string,
	analyzerAssemblies: string[],
	target: string,
): Promise<AnalyzeResult> => {
	let outputDirectory: string | undefined;
	try {
		outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-roslynator-"));
		const outputPath = path.join(outputDirectory, "report.xml");
		const analyzeArgs = ["analyze", target, "--output", outputPath];
		if (analyzerAssemblies.length > 0) {
			analyzeArgs.push("--analyzer-assemblies", ...analyzerAssemblies);
		}
		const result = await runSubprocess(roslynator, analyzeArgs, {
			cwd: context.rootDirectory,
			timeout: ANALYZE_TIMEOUT_MS,
		});
		// roslynator writes --output only when analysis found at least one diagnostic,
		// so a clean run leaves no file: it exits 0 after printing its zero summary.
		// Any other missing report (a crash at solution load under a newer .NET SDK,
		// a nonzero exit, a count with no file) means analysis never completed.
		if (!fs.existsSync(outputPath)) {
			if (completedWithoutDiagnostics(result)) {
				return { diagnostics: [], failed: false };
			}
			const detail = truncateFailureDetail(result.stderr || result.stdout || "no output");
			throw new Error(`no report written (exit code ${result.exitCode}): ${detail}`);
		}
		const xml = fs.readFileSync(outputPath, "utf-8");
		return { diagnostics: parseRoslynatorXml(xml, context.rootDirectory), failed: false };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { diagnostics: [], failed: true, reason, timedOut: /timed out/i.test(reason) };
	} finally {
		if (outputDirectory) {
			try {
				fs.rmSync(outputDirectory, { recursive: true, force: true });
			} catch (cleanupError) {
				console.error(
					`aislop: warning: failed to clean up temporary directory ${outputDirectory}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
		}
	}
};

const ROSLYNATOR_TOOL: AnalyzerExecution["tool"] = "roslynator";

export const runDotnetLint = async (
	context: EngineContext,
	inventory?: CsharpProjectInventory,
): Promise<AnalyzerRunResult> => {
	const csharpInventory = inventory ?? createCsharpProjectInventory(context);
	const selection = findDotnetTargets(context, csharpInventory);
	const notice = projectsSkippedNotice(selection, context.rootDirectory);
	if (selection.targets.length === 0) {
		return {
			diagnostics: notice,
			failures: [],
			executions: [
				{
					...buildExecution(context, {
						tool: ROSLYNATOR_TOOL,
						failureReasons: [],
						targets: [],
						analyzedProjects: [],
						elapsed: 0,
						inventory: csharpInventory,
					}),
					status: "not-selected",
					reason: "no solution or restored project targets",
				},
			],
		};
	}
	const startedAt = Date.now();
	const attemptedTargets: string[] = [];
	const analyzedProjects: string[] = [];
	const roslynator = resolveToolBinary(ROSLYNATOR_TOOL);
	// Bundled analyzers extend coverage to projects that don't reference them;
	// when none are bundled, roslynator still runs the project's own analyzers.
	const analyzerAssemblies = resolveBundledAnalyzerAssemblies();
	const diagnostics: Diagnostic[] = [];
	const failures: EngineFailure[] = [];
	for (const target of selection.targets) {
		attemptedTargets.push(toRelative(context, target));
		const result = await analyzeTarget(context, roslynator, analyzerAssemblies, target);
		diagnostics.push(...result.diagnostics);
		if (!result.failed) {
			if (isSolutionTarget(target)) {
				const solution = getSolutionIndex(csharpInventory, target);
				const memberProjects = solution.csharpProjects
					.map((project) => project.relativePath)
					.filter((project) =>
						csharpInventory.visibleProjectsSet
							? csharpInventory.visibleProjectsSet.has(project)
							: csharpInventory.visibleProjects.includes(project),
					);
				analyzedProjects.push(...memberProjects);
			} else {
				analyzedProjects.push(toRelative(context, target));
			}
			continue;
		}
		const failure: EngineFailure = {
			tool: ROSLYNATOR_TOOL,
			target: projectRelativePosix(context.rootDirectory, target),
			reason: result.reason,
		};
		if (result.timedOut || !isSolutionTarget(target)) {
			failures.push(failure);
			continue;
		}
		const projects = csharpInventory.visibleProjects;
		const fallbackTargets = projects
			.filter((project) =>
				hasRestoreEvidence(path.resolve(context.rootDirectory, project), context.rootDirectory),
			)
			.slice(0, MAXIMUM_PROJECT_TARGETS);
		if (fallbackTargets.length === 0) {
			failures.push(failure);
			continue;
		}
		if (fallbackTargets.length !== projects.length) {
			failures.push({
				...failure,
				reason: `${failure.reason}; fallback covers only ${fallbackTargets.length} of ${projects.length} visible projects (restore evidence or project cap)`,
			});
		}
		console.error(
			`aislop: roslynator analyze failed for the solution (${failure.reason}); falling back to per-project analyze for ${fallbackTargets.length} restored project(s)`,
		);
		for (const project of fallbackTargets) {
			const projectAbsolute = path.resolve(context.rootDirectory, project);
			attemptedTargets.push(toRelative(context, projectAbsolute));
			const projectResult = await analyzeTarget(
				context,
				roslynator,
				analyzerAssemblies,
				projectAbsolute,
			);
			diagnostics.push(...projectResult.diagnostics);
			if (!projectResult.failed) analyzedProjects.push(toRelative(context, projectAbsolute));
			if (projectResult.failed) {
				failures.push({
					tool: ROSLYNATOR_TOOL,
					target: projectRelativePosix(context.rootDirectory, projectAbsolute),
					reason: projectResult.reason,
				});
			}
		}
	}
	const execution = buildExecution(context, {
		tool: ROSLYNATOR_TOOL,
		failureReasons: failures.map((failure) => `${failure.target}: ${failure.reason}`),
		targets: attemptedTargets,
		analyzedProjects,
		elapsed: Date.now() - startedAt,
		inventory: csharpInventory,
	});
	return { diagnostics: [...diagnostics, ...notice], failures, executions: [execution] };
};
