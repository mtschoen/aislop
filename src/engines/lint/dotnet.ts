import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectRelativePosix } from "../../utils/paths.js";
import {
	isMissingToolError,
	runSubprocess,
	warnSubprocessFailure,
} from "../../utils/subprocess.js";
import { resolveBundledAnalyzerAssemblies, resolveToolBinary } from "../../utils/tooling.js";
import {
	findCsprojFiles,
	findDotnetTargets,
	hasRestoreEvidence,
	MAXIMUM_PROJECT_TARGETS,
	projectsSkippedNotice,
} from "../dotnet-targets.js";
import type { Diagnostic, EngineContext } from "../types.js";
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

interface AnalyzeResult {
	diagnostics: Diagnostic[];
	// True when roslynator itself failed to produce a usable report for this
	// target (crash, timeout, or a report file that was never written), as
	// opposed to a clean run that simply found nothing.
	failed: boolean;
	timedOut?: boolean;
}

const analyzeTarget = async (
	context: EngineContext,
	roslynator: string,
	analyzerAssemblies: string[],
	target: string,
): Promise<AnalyzeResult> => {
	const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-roslynator-"));
	const outputPath = path.join(outputDirectory, "report.xml");
	const label = `roslynator analyze (${projectRelativePosix(context.rootDirectory, target)})`;
	try {
		const analyzeArgs = ["analyze", target, "--output", outputPath];
		if (analyzerAssemblies.length > 0) {
			analyzeArgs.push("--analyzer-assemblies", ...analyzerAssemblies);
		}
		let result: { stdout: string; stderr: string; exitCode: number | null };
		try {
			result = await runSubprocess(roslynator, analyzeArgs, {
				cwd: context.rootDirectory,
				timeout: ANALYZE_TIMEOUT_MS,
			});
		} catch (error) {
			// A missing binary is gated out before this ever runs (installedTools.roslynator);
			// anything else - a timeout, a crash the spawn layer surfaces directly - is
			// roslynator present but failing, which must not go silent.
			if (isMissingToolError(error)) return { diagnostics: [], failed: false };
			warnSubprocessFailure(label, error);
			const timedOut = error instanceof Error && /timed out/i.test(error.message);
			return { diagnostics: [], failed: true, timedOut };
		}
		// roslynator's exit code alone cannot distinguish "ran clean" from "crashed
		// before writing anything": the code also varies with the highest diagnostic
		// severity found on a normal run. A missing report file is the unambiguous
		// signal that analysis never completed (e.g. roslynator crashing at solution
		// load under a newer .NET SDK), so check for the file rather than the code.
		if (!fs.existsSync(outputPath)) {
			const detail = result.stderr || result.stdout || "no output";
			warnSubprocessFailure(
				label,
				new Error(`no report written (exit code ${result.exitCode}): ${detail}`),
			);
			return { diagnostics: [], failed: true };
		}
		const xml = fs.readFileSync(outputPath, "utf-8");
		return { diagnostics: parseRoslynatorXml(xml, context.rootDirectory), failed: false };
	} finally {
		fs.rmSync(outputDirectory, { recursive: true, force: true });
	}
};

// Restored .csproj files (capped the same way findDotnetTargets caps a
// project-only selection) to retry individually when a solution-level pass
// fails. Confirmed for the SDK 10 / roslynator solution-load crash: per-project
// `analyze` succeeds even when `analyze <solution>.sln` cannot load the solution.
const restoredProjectFallbackTargets = (context: EngineContext): string[] =>
	findCsprojFiles(context.rootDirectory, context.excludePatterns)
		.filter((csproj) => hasRestoreEvidence(csproj, context.rootDirectory))
		.slice(0, MAXIMUM_PROJECT_TARGETS);

const isSolutionTarget = (target: string): boolean => target.toLowerCase().endsWith(".sln");

export const runDotnetLint = async (context: EngineContext): Promise<Diagnostic[]> => {
	const selection = findDotnetTargets(context);
	const notice = projectsSkippedNotice(selection, context.rootDirectory);
	if (selection.targets.length === 0) return notice;
	const roslynator = resolveToolBinary("roslynator");
	// Bundled analyzers extend coverage to projects that don't reference them;
	// when none are bundled, roslynator still runs the project's own analyzers.
	const analyzerAssemblies = resolveBundledAnalyzerAssemblies();
	const diagnostics: Diagnostic[] = [];
	for (const target of selection.targets) {
		const result = await analyzeTarget(context, roslynator, analyzerAssemblies, target);
		if (!result.failed || result.timedOut || !isSolutionTarget(target)) {
			diagnostics.push(...result.diagnostics);
			continue;
		}
		const fallbackTargets = restoredProjectFallbackTargets(context);
		if (fallbackTargets.length === 0) continue;
		console.error(
			`aislop: roslynator analyze failed for the solution; falling back to per-project analyze for ${fallbackTargets.length} restored project(s)`,
		);
		for (const project of fallbackTargets) {
			const projectResult = await analyzeTarget(context, roslynator, analyzerAssemblies, project);
			diagnostics.push(...projectResult.diagnostics);
		}
	}
	return [...diagnostics, ...notice];
};
