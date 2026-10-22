import path from "node:path";
import { isPathExcluded, normalizeExcludePatterns } from "../../utils/exclude.js";
import { dropGitIgnoredPaths } from "../../utils/git-ignore.js";
import { projectRelativePosix } from "../../utils/paths.js";
import { collectCsprojFiles } from "../dotnet-targets.js";
import { parseSolutionProjects, type SolutionProject } from "../solution-projects.js";
import type { AnalyzerExecution, EngineContext } from "../types.js";

export type CsharpTool = AnalyzerExecution["tool"];

interface SolutionIndex {
	projects: SolutionProject[];
	csharpProjects: SolutionProject[];
	byPath: Map<string, SolutionProject[]>;
	byName: Map<string, SolutionProject[]>;
	byBasename: Map<string, SolutionProject[]>;
}

export interface CsharpProjectInventory {
	rootDirectory: string;
	allProjects: string[];
	visibleProjects: string[];
	visibleProjectsSet: Set<string>;
	excludedProjects: string[];
	excludedProjectsSet: Set<string>;
	/** Projects on disk that .gitignore hides, repository-relative and sorted. */
	gitIgnoredProjects: string[];
	solutionCache: Map<string, SolutionIndex>;
}

export interface CsharpPassSwitches {
	projectEvaluation: boolean;
	jb: boolean;
	roslynator: boolean;
}

export const toRelative = (
	context: Pick<EngineContext, "rootDirectory"> | { rootDirectory: string },
	absolutePath: string,
): string => projectRelativePosix(context.rootDirectory, absolutePath);

export const createCsharpProjectInventory = (
	context: Pick<EngineContext, "rootDirectory" | "excludePatterns">,
): CsharpProjectInventory => {
	const root = context.rootDirectory;
	const rawProjects = collectCsprojFiles(root);
	const nonIgnored = new Set(dropGitIgnoredPaths(root, rawProjects));
	const toRelativePaths = (projects: string[]): string[] =>
		projects.map((project) => projectRelativePosix(root, project)).sort();
	const allProjects = toRelativePaths(rawProjects.filter((project) => nonIgnored.has(project)));
	const gitIgnoredProjects = toRelativePaths(
		rawProjects.filter((project) => !nonIgnored.has(project)),
	);

	let excludedProjects: string[] = [];
	let visibleProjects: string[] = [];
	if (context.excludePatterns && context.excludePatterns.length > 0) {
		const normalized = normalizeExcludePatterns(context.excludePatterns);
		if (normalized.length > 0) {
			excludedProjects = allProjects.filter((project) => isPathExcluded(project, normalized));
			visibleProjects = allProjects.filter((project) => !isPathExcluded(project, normalized));
		} else {
			visibleProjects = [...allProjects];
		}
	} else {
		visibleProjects = [...allProjects];
	}

	return {
		rootDirectory: root,
		allProjects,
		visibleProjects,
		visibleProjectsSet: new Set(visibleProjects),
		excludedProjects,
		excludedProjectsSet: new Set(excludedProjects),
		gitIgnoredProjects,
		solutionCache: new Map(),
	};
};

const buildSolutionIndex = (projects: SolutionProject[]): SolutionIndex => {
	const csharpProjects: SolutionProject[] = [];
	const byPath = new Map<string, SolutionProject[]>();
	const byName = new Map<string, SolutionProject[]>();
	const byBasename = new Map<string, SolutionProject[]>();

	const append = (
		targetMap: Map<string, SolutionProject[]>,
		key: string,
		project: SolutionProject,
	) => {
		const existing = targetMap.get(key);
		if (existing) {
			existing.push(project);
		} else {
			targetMap.set(key, [project]);
		}
	};

	for (const project of projects) {
		if (project.isCsharp) {
			csharpProjects.push(project);
		}

		append(byPath, project.relativePath, project);
		const extension = path.posix.extname(project.relativePath);
		if (extension.length > 0) {
			const withoutExtension = project.relativePath.slice(0, -extension.length);
			append(byPath, withoutExtension, project);
		}

		append(byName, project.name, project);
		append(byBasename, project.basename, project);
	}

	return {
		projects,
		csharpProjects,
		byPath,
		byName,
		byBasename,
	};
};

export const getSolutionIndex = (
	inventory: CsharpProjectInventory,
	solutionTarget: string,
): SolutionIndex => {
	const absolutePath = path.isAbsolute(solutionTarget)
		? solutionTarget
		: path.resolve(inventory.rootDirectory, solutionTarget);
	const cached = inventory.solutionCache?.get(absolutePath);
	if (cached) return cached;
	const parsed = parseSolutionProjects(absolutePath, inventory.rootDirectory);
	const index = buildSolutionIndex(parsed);
	if (inventory.solutionCache) {
		inventory.solutionCache.set(absolutePath, index);
	}
	return index;
};

export const isSolutionTarget = (target: string): boolean => {
	const lower = target.toLowerCase();
	return lower.endsWith(".sln") || lower.endsWith(".slnx");
};

export const notSelectedReason = (
	tool: CsharpTool,
	switches: CsharpPassSwitches,
	installedTools: Record<string, boolean>,
): string | null => {
	const key = tool === "jb inspectcode" ? "jb" : "roslynator";
	if (!switches.projectEvaluation) return "projectEvaluation disabled";
	if (!switches[key]) return `${key} disabled in lint.csharp config`;
	if (!installedTools[key]) return `${key} tool missing`;
	return null;
};

export const notSelectedExecution = (
	context: EngineContext,
	tool: CsharpTool,
	reason: string,
	inventory?: CsharpProjectInventory,
): AnalyzerExecution => {
	const projectInventory = inventory ?? createCsharpProjectInventory(context);
	return {
		tool,
		status: "not-selected",
		reason,
		targets: [],
		analyzedProjects: [],
		excludedProjects: projectInventory.excludedProjects,
		elapsed: 0,
	};
};

/** Resolve a report project name to a repository-relative project path. */
export const resolveReportedProject = (
	inventory: CsharpProjectInventory,
	target: string,
	reportedName: string,
): string | null => {
	if (!isSolutionTarget(target)) {
		return toRelative(inventory, target);
	}

	const solutionIndex = getSolutionIndex(inventory, target);
	if (solutionIndex.projects.length === 0) return null;

	const normalized = reportedName.replace(/\\/g, "/");

	// 1. Path match (exact repository-relative path or extensionless alias)
	const byPathCandidates =
		solutionIndex.byPath.get(normalized) ??
		(normalized.toLowerCase().endsWith(".csproj")
			? undefined
			: solutionIndex.byPath.get(`${normalized}.csproj`));
	// Reject non-singleton candidate groups before inspecting elements (O(1))
	if (byPathCandidates && byPathCandidates.length > 1) return null;

	// 2. Exact solution display name match
	const byNameCandidates = solutionIndex.byName.get(reportedName);
	if (byNameCandidates && byNameCandidates.length > 1) return null;

	// 3. Exact project filename basename match (only for unqualified names)
	const basename = !normalized.includes("/") ? path.posix.basename(normalized, ".csproj") : null;
	const byBasenameCandidates =
		basename !== null ? solutionIndex.byBasename.get(basename) : undefined;
	if (byBasenameCandidates && byBasenameCandidates.length > 1) return null;

	// 4. Require a unique owner across all supported name interpretations
	if (
		(!byPathCandidates || byPathCandidates.length === 0) &&
		(!byNameCandidates || byNameCandidates.length === 0) &&
		(!byBasenameCandidates || byBasenameCandidates.length === 0)
	) {
		return null;
	}

	const candidates: SolutionProject[] = [];
	if (byPathCandidates && byPathCandidates.length === 1) {
		candidates.push(byPathCandidates[0]);
	}
	if (byNameCandidates && byNameCandidates.length === 1) {
		candidates.push(byNameCandidates[0]);
	}
	if (byBasenameCandidates && byBasenameCandidates.length === 1) {
		candidates.push(byBasenameCandidates[0]);
	}

	const firstCandidate = candidates[0];
	for (let index = 1; index < candidates.length; index++) {
		if (candidates[index].relativePath !== firstCandidate.relativePath) {
			return null;
		}
	}

	// 5. Reject native project identities
	if (!firstCandidate.isCsharp) {
		return null;
	}

	return firstCandidate.relativePath;
};

export const buildExecution = (
	context: EngineContext,
	input: {
		tool: CsharpTool;
		failureReasons: string[];
		targets: string[];
		analyzedProjects: Iterable<string>;
		elapsed: number;
		inventory?: CsharpProjectInventory;
	},
): AnalyzerExecution => {
	const inventory = input.inventory ?? createCsharpProjectInventory(context);
	const excluded = inventory.excludedProjects;
	const excludedSet = inventory.excludedProjectsSet ?? new Set(excluded);
	const analyzed = [...new Set(input.analyzedProjects)]
		.filter((project) => !excludedSet.has(project))
		.sort();
	const failed = input.failureReasons.length > 0;
	return {
		tool: input.tool,
		status: failed ? "failed" : "ran",
		...(failed ? { reason: input.failureReasons.join("; ") } : {}),
		targets: input.targets,
		analyzedProjects: analyzed,
		excludedProjects: excluded,
		elapsed: input.elapsed,
	};
};
