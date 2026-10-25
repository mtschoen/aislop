import path from "node:path";
import { isPathExcluded, normalizeExcludePatterns } from "../../utils/exclude.js";
import { getGitIgnoredPaths } from "../../utils/git-ignore.js";
import { projectRelativePosix } from "../../utils/paths.js";
import type { EngineFailure } from "../types.js";
import {
	checkSolutionCoverage,
	listSolutionMembersWithDotnet,
	type SolutionCoverageInput,
} from "./csharp-coverage.js";

interface ProjectEvidence {
	fileNames: Set<string>;
	failedProjects: Set<string>;
}

// jb 2026.2: "Inspecting Clean.csproj"; "Inspecting Multi.csproj" repeats per target.
// "Analyzing" under --swea is context only.
export const parseJbProjectEvidence = (stdout: string): ProjectEvidence => ({
	fileNames: new Set(
		stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.startsWith("Inspecting ") && line.endsWith(".csproj"))
			.map((line) => line.slice("Inspecting ".length)),
	),
	failedProjects: new Set(),
});

// roslynator 0.13.0: "Analyze 'Clean' 2/3", "Analyze 'Multi(net9.0)' 2/3",
// "Analyze 'Multi(net10.0)' 3/3", and
// "Msbuild failed when processing the file '<path>' with message: ..." (detailed).
export const parseRoslynatorProjectEvidence = (
	stdout: string,
	rootDirectory: string,
): ProjectEvidence => {
	const fileNames = new Set<string>();
	const failedProjects = new Set<string>();
	const failurePrefix = "Msbuild failed when processing the file '";
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		const analyzed = /^Analyze '(.+?)'(?: \d+\/\d+)?$/.exec(line);
		if (analyzed) fileNames.add(`${analyzed[1]}.csproj`);
		if (!line.startsWith(failurePrefix)) continue;
		const end = line.indexOf("' with message:", failurePrefix.length);
		if (end < 0) continue;
		failedProjects.add(
			projectRelativePosix(
				rootDirectory,
				line.slice(failurePrefix.length, end).replace(/\\/g, "/"),
			),
		);
	}
	return { fileNames, failedProjects };
};

const evidenceCandidatesForFileName = (fileName: string, allowTargetSuffix: boolean): string[] => {
	if (!allowTargetSuffix) return [fileName];
	const suffix = /^(.+)\([^()]+\)\.csproj$/.exec(fileName);
	return suffix ? [fileName, `${suffix[1]}.csproj`] : [fileName];
};

/** Attribute console evidence only to unique SDK-listed, selected project files. */
export const checkSolutionProjectEvidence = async (
	input: Omit<SolutionCoverageInput, "analyzedProjects" | "lister">,
	evidence: ProjectEvidence,
): Promise<{ analyzedProjects: string[]; failure: EngineFailure | null }> => {
	const members = await listSolutionMembersWithDotnet(input.solutionPath, input.rootDirectory);
	const analyzedProjects: string[] = [];
	const reasons: string[] = [];
	if (members.ok) {
		const gitIgnored = new Set(input.inventory.gitIgnoredProjects);
		const excluded = new Set(input.inventory.excludedProjects);
		const excludePatterns = normalizeExcludePatterns(input.excludePatterns ?? []);
		const inScope = (project: string) => input.inScope?.(project) ?? true;
		const csharpMembers = [...new Set(members.projects)].filter(
			(project) =>
				project.toLowerCase().endsWith(".csproj") && !gitIgnored.has(project) && inScope(project),
		);
		const knownOnDisk = new Set([...input.inventory.allProjects, ...gitIgnored]);
		const ignoredAbsent = getGitIgnoredPaths(
			input.rootDirectory,
			csharpMembers.filter((project) => !knownOnDisk.has(project)),
		);
		const activeMembers = csharpMembers.filter((project) => !ignoredAbsent.has(project));
		const expected = activeMembers.filter(
			(project) => !excluded.has(project) && !isPathExcluded(project, excludePatterns),
		);
		const expectedSet = new Set(expected);
		const nameCounts = new Map<string, number>();
		const hasExpectedByName = new Map<string, boolean>();
		for (const project of activeMembers) {
			const fileName = path.posix.basename(project);
			nameCounts.set(fileName, (nameCounts.get(fileName) ?? 0) + 1);
			if (expectedSet.has(project)) hasExpectedByName.set(fileName, true);
		}
		const allowTargetSuffix = input.tool === "roslynator";
		const matchedNames = new Set<string>();
		const ambiguousNames = new Set<string>();
		for (const reported of evidence.fileNames) {
			const present = evidenceCandidatesForFileName(reported, allowTargetSuffix).filter((name) =>
				nameCounts.has(name),
			);
			if (present.length === 1 && nameCounts.get(present[0]) === 1) {
				matchedNames.add(present[0]);
			} else if (present.length > 1) {
				for (const name of present) ambiguousNames.add(name);
			}
		}
		const duplicates = [
			...new Set([
				...[...nameCounts]
					.filter(([name, count]) => count > 1 && hasExpectedByName.get(name))
					.map(([name]) => name),
				...[...ambiguousNames].filter((name) => hasExpectedByName.get(name)),
			]),
		];
		if (duplicates.length > 0) {
			reasons.push(
				`duplicate project file names cannot be attributed: ${duplicates.sort().join(", ")}`,
			);
		}
		if (expected.length > 0 && evidence.fileNames.size === 0) {
			reasons.push(`no per-project evidence in ${input.tool} output`);
		}
		for (const project of expected) {
			const fileName = path.posix.basename(project);
			if (
				matchedNames.has(fileName) &&
				!ambiguousNames.has(fileName) &&
				!evidence.failedProjects.has(project) &&
				input.inventory.visibleProjectsSet.has(project)
			) {
				analyzedProjects.push(project);
			}
		}
	}
	const incomplete = await checkSolutionCoverage({
		...input,
		analyzedProjects,
		lister: async () => members,
	});
	if (incomplete) reasons.push(incomplete.reason);
	return {
		analyzedProjects,
		failure:
			reasons.length > 0
				? {
						tool: input.tool,
						target: projectRelativePosix(input.rootDirectory, input.solutionPath),
						reason: reasons.join("; "),
					}
				: null,
	};
};
