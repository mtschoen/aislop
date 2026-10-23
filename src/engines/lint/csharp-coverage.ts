import path from "node:path";
import { isPathExcluded, normalizeExcludePatterns } from "../../utils/exclude.js";
import { getGitIgnoredPaths } from "../../utils/git-ignore.js";
import { projectRelativePosix } from "../../utils/paths.js";
import { runSubprocess } from "../../utils/subprocess.js";
import type { EngineFailure } from "../types.js";
import type { CsharpProjectInventory, CsharpTool } from "./csharp-execution.js";

const SOLUTION_LIST_TIMEOUT_MILLISECONDS = 60_000;
const PROJECT_TABLE_HEADING = "project(s)";
const NO_PROJECTS_MESSAGE = "no projects found in the solution.";
const MAXIMUM_NAMED_PROJECTS = 20;
const MAXIMUM_DETAIL_LENGTH = 300;

type SolutionMembers = { ok: true; projects: string[] } | { ok: false; reason: string };

/** Lists a solution's project members as repository-relative POSIX paths. */
export type SolutionMemberLister = (
	solutionPath: string,
	rootDirectory: string,
) => Promise<SolutionMembers>;

/**
 * Parse `dotnet sln list` stdout: a "Project(s)" heading, a dashes-only
 * separator, then one project path per line. Returns null when the shape is
 * not recognized, so the caller fails closed instead of guessing.
 */
const parseSolutionListOutput = (stdout: string): string[] | null => {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const separatorIndex = lines.findIndex(
		(line, index) =>
			index > 0 && /^-+$/.test(line) && lines[index - 1].toLowerCase() === PROJECT_TABLE_HEADING,
	);
	if (separatorIndex > 0) return lines.slice(separatorIndex + 1);
	if (lines.length === 1 && lines[0].toLowerCase() === NO_PROJECTS_MESSAGE) return [];
	return null;
};

/** The .NET SDK's own solution parser, for .sln and .slnx alike. */
export const listSolutionMembersWithDotnet: SolutionMemberLister = async (
	solutionPath,
	rootDirectory,
) => {
	try {
		const result = await runSubprocess("dotnet", ["sln", solutionPath, "list"], {
			cwd: path.dirname(solutionPath),
			timeout: SOLUTION_LIST_TIMEOUT_MILLISECONDS,
			env: { DOTNET_CLI_UI_LANGUAGE: "en", DOTNET_NOLOGO: "1" },
		});
		if (result.exitCode !== 0) {
			const detail = (result.stderr || result.stdout || "no output")
				.trim()
				.slice(0, MAXIMUM_DETAIL_LENGTH);
			return { ok: false, reason: `dotnet sln list exited ${result.exitCode}: ${detail}` };
		}
		const listed = parseSolutionListOutput(result.stdout);
		if (listed === null) {
			return { ok: false, reason: "dotnet sln list produced unrecognized output" };
		}
		const solutionDirectory = path.dirname(solutionPath);
		return {
			ok: true,
			projects: listed.map((entry) =>
				projectRelativePosix(
					rootDirectory,
					path.resolve(solutionDirectory, entry.replace(/\\/g, "/")),
				),
			),
		};
	} catch (error) {
		return {
			ok: false,
			reason: `dotnet sln list could not run: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
};

export interface SolutionCoverageInput {
	tool: CsharpTool;
	rootDirectory: string;
	solutionPath: string;
	inventory: CsharpProjectInventory;
	analyzedProjects: Iterable<string>;
	excludePatterns?: string[];
	/** Narrows which members this pass was asked to cover (jb --project scope). */
	inScope?: (projectPath: string) => boolean;
	lister?: SolutionMemberLister;
}

/**
 * A pass that ran against a solution must have analyzed every C# member the
 * solution declares, except members the user excluded or .gitignore hides.
 * Returns a failure naming the missing projects, or a failure when the
 * solution's members could not be listed; null when coverage is complete.
 */
export const checkSolutionCoverage = async (
	input: SolutionCoverageInput,
): Promise<EngineFailure | null> => {
	const target = projectRelativePosix(input.rootDirectory, input.solutionPath);
	const lister = input.lister ?? listSolutionMembersWithDotnet;
	const members = await lister(input.solutionPath, input.rootDirectory);
	if (!members.ok) {
		return {
			tool: input.tool,
			target,
			reason: `analysis completeness unverified: ${members.reason}`,
		};
	}
	const analyzed = new Set(input.analyzedProjects);
	const knownOnDisk = new Set([
		...input.inventory.allProjects,
		...input.inventory.gitIgnoredProjects,
	]);
	const normalizedExcludePatterns = normalizeExcludePatterns(input.excludePatterns ?? []);
	const exempt = new Set([
		...input.inventory.excludedProjects,
		...input.inventory.gitIgnoredProjects,
	]);
	const unanalyzedCandidates = [
		...new Set(
			members.projects.filter(
				(project) =>
					project.toLowerCase().endsWith(".csproj") &&
					!exempt.has(project) &&
					!isPathExcluded(project, normalizedExcludePatterns) &&
					!analyzed.has(project) &&
					(input.inScope?.(project) ?? true),
			),
		),
	];
	const absentCandidates = unanalyzedCandidates.filter((project) => !knownOnDisk.has(project));
	const gitIgnoredAbsent = getGitIgnoredPaths(input.rootDirectory, absentCandidates);
	const missing = unanalyzedCandidates.filter((project) => !gitIgnoredAbsent.has(project)).sort();
	if (missing.length === 0) return null;
	const named = missing.slice(0, MAXIMUM_NAMED_PROJECTS).join(", ");
	const remaining = missing.length - MAXIMUM_NAMED_PROJECTS;
	return {
		tool: input.tool,
		target,
		reason: `analysis incomplete: ${missing.length} solution project(s) not analyzed: ${named}${remaining > 0 ? ` (and ${remaining} more)` : ""}`,
	};
};
