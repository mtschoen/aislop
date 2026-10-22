import fs from "node:fs";
import path from "node:path";
import { isPathExcluded, normalizeExcludePatterns } from "../../utils/exclude.js";
import { dropGitIgnoredPaths } from "../../utils/git-ignore.js";
import { projectRelativePosix } from "../../utils/paths.js";
import { collectCsprojFiles } from "../dotnet-targets.js";
import type { AnalyzerExecution, EngineContext } from "../types.js";
import { decodeEntities, xmlAttribute } from "./xml-entities.js";

export type CsharpTool = AnalyzerExecution["tool"];

interface SolutionProject {
	name: string;
	relativePath: string;
	basename: string;
	isCsharp: boolean;
}

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
	hasGitIgnoredProjects: boolean;
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
	const nonIgnored = dropGitIgnoredPaths(root, rawProjects);
	const hasGitIgnoredProjects = nonIgnored.length !== rawProjects.length;
	const allProjects = nonIgnored.map((project) => projectRelativePosix(root, project)).sort();

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
		hasGitIgnoredProjects,
		solutionCache: new Map(),
	};
};

const attribute = (tag: string, name: string): string | null => {
	const value = xmlAttribute(tag, name);
	return value !== null ? decodeEntities(value) : null;
};

const stripXmlComments = (xml: string): string => xml.replace(/<!--[\s\S]*?-->/g, "");

// Solution folder type GUID used in .sln files to declare virtual groupings.
const SOLUTION_FOLDER_GUID = "2150e333-8fdc-42a3-9474-1a3956d46de8";

const parseSolutionProjects = (solutionPath: string, rootDirectory: string): SolutionProject[] => {
	let content: string;
	try {
		content = fs.readFileSync(solutionPath, "utf-8");
	} catch {
		return [];
	}
	const projects: SolutionProject[] = [];
	const solutionDirectory = path.dirname(solutionPath);

	if (solutionPath.toLowerCase().endsWith(".slnx")) {
		const cleanContent = stripXmlComments(content);
		const projectTagPattern = /<Project\b([^>]*)\/?>/g;
		let match = projectTagPattern.exec(cleanContent);
		while (match !== null) {
			const tag = match[1];
			const rawPath = attribute(tag, "Path");
			if (rawPath) {
				const normalizedPath = rawPath.replace(/\\/g, "/");
				const absoluteProject = path.resolve(solutionDirectory, normalizedPath);
				const relative = projectRelativePosix(rootDirectory, absoluteProject);
				const isCsharp = relative.toLowerCase().endsWith(".csproj");
				const extension = path.posix.extname(relative);
				const basename = path.posix.basename(relative, extension);
				const rawName = attribute(tag, "DisplayName") ?? attribute(tag, "Name");
				const name = rawName !== null ? rawName : basename;
				projects.push({ name, relativePath: relative, basename, isCsharp });
			}
			match = projectTagPattern.exec(cleanContent);
		}
		return projects;
	}

	const lines = content.split(/\r?\n/);
	const slnLinePattern =
		/^[ \t]*Project\s*\(\s*"\{?([0-9a-fA-F-]+)\}?"\s*\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"/;
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("#")) continue;
		const match = slnLinePattern.exec(line);
		if (!match) continue;
		const typeGuid = match[1].toLowerCase();
		if (typeGuid === SOLUTION_FOLDER_GUID) continue;
		const name = match[2];
		const rawPath = match[3].replace(/\\/g, "/");
		const absoluteProject = path.resolve(solutionDirectory, rawPath);
		const relative = projectRelativePosix(rootDirectory, absoluteProject);
		const isCsharp = relative.toLowerCase().endsWith(".csproj");
		const extension = path.posix.extname(relative);
		const basename = path.posix.basename(relative, extension);
		projects.push({ name, relativePath: relative, basename, isCsharp });
	}
	return projects;
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
