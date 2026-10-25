import fs from "node:fs";
import path from "node:path";
import { mapWithConcurrencyLimit } from "../../utils/concurrency.js";
import { projectRelativePosix } from "../../utils/paths.js";
import { enumerateProjectFilesFromDisk } from "../../utils/project-file-list.js";
import { WALK_PRUNE_DIRECTORIES } from "../../utils/source-file-policy.js";
import { filterDependencyAuditFiles, listProjectFiles } from "../../utils/source-file-selection.js";
import { runSubprocess, SubprocessTimeoutError } from "../../utils/subprocess.js";
import type { Diagnostic, EngineContext } from "../types.js";
import {
	type AuditOutcome,
	advisoryIdFromUrl,
	SEVERITY_RANK,
	skippedAuditDiagnostic,
	toDependencyAdvisory,
	toSeverity,
	warnWhenIncomplete,
} from "./audit-shared.js";
import { isRecord, isRecordArray, readRecordArray, readString } from "./audit-value.js";

// `dotnet list <project.csproj> package --no-restore --vulnerable --include-transitive
// --format json` runs per scoped C# project: a solution member the CLI cannot
// evaluate (such as a .vcxproj) cannot fail the whole audit. A .csproj whose assets
// are not restored is reported skipped by name. The command emits the
// schema projects -> frameworks -> {topLevelPackages, transitivePackages} -> packages,
// each package carrying id, resolvedVersion and a vulnerabilities list (severity,
// advisoryurl). NuGet severities are Low/Moderate/High/Critical; only vulnerable
// packages appear.

interface DotnetVulnerability {
	severity?: string;
	advisoryurl?: string;
}
interface DotnetFinding {
	projectFile: string;
	packageId: string;
	transitive: boolean;
	resolvedVersion: string;
	worstSeverity: string;
	vulnerabilities: DotnetVulnerability[];
}

const severityRank = (severity: string): number => SEVERITY_RANK[severity] ?? 0;

const worstSeverityOf = (vulnerabilities: DotnetVulnerability[]): string =>
	vulnerabilities.reduce((worst, vulnerability) => {
		const severity = (vulnerability.severity ?? "moderate").toLowerCase();
		return severityRank(severity) > severityRank(worst) ? severity : worst;
	}, "low");

// A multi-targeted project repeats the same advisory once per framework, so collapse
// identical (severity, advisory) pairs before counting them.
const dedupeVulnerabilities = (vulnerabilities: DotnetVulnerability[]): DotnetVulnerability[] => {
	const seen = new Set<string>();
	return vulnerabilities.filter((vulnerability) => {
		const key = `${(vulnerability.severity ?? "").toLowerCase()}|${vulnerability.advisoryurl ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const readVulnerabilities = (pkg: Record<string, unknown>): DotnetVulnerability[] =>
	readRecordArray(pkg, "vulnerabilities").map((vulnerability) => ({
		severity: readString(vulnerability, "severity"),
		advisoryurl: readString(vulnerability, "advisoryurl"),
	}));

const toDotnetFinding = (
	pkg: Record<string, unknown>,
	projectFile: string,
	transitive: boolean,
): DotnetFinding | null => {
	const vulnerabilities = dedupeVulnerabilities(readVulnerabilities(pkg));
	const packageId = readString(pkg, "id");
	if (vulnerabilities.length === 0 || !packageId) return null;
	return {
		projectFile,
		packageId,
		transitive,
		resolvedVersion: readString(pkg, "resolvedVersion") ?? "?",
		worstSeverity: worstSeverityOf(vulnerabilities),
		vulnerabilities,
	};
};

// The same package can resolve to a different version - and so to a different
// advisory set - under each target framework. Report the worst of them, carrying the
// version and advisory that severity came from, rather than whichever framework the
// report happened to list first.
const mergeDotnetFindings = (existing: DotnetFinding, incoming: DotnetFinding): DotnetFinding => {
	const worst =
		severityRank(incoming.worstSeverity) > severityRank(existing.worstSeverity)
			? incoming
			: existing;
	return {
		...worst,
		vulnerabilities: dedupeVulnerabilities([
			...existing.vulnerabilities,
			...incoming.vulnerabilities,
		]),
	};
};

const toDotnetDiagnostic = (finding: DotnetFinding): Diagnostic => {
	const advisory =
		finding.vulnerabilities.find(
			(vulnerability) =>
				vulnerability.advisoryurl &&
				(vulnerability.severity ?? "moderate").toLowerCase() === finding.worstSeverity,
		)?.advisoryurl ??
		finding.vulnerabilities.find((vulnerability) => vulnerability.advisoryurl)?.advisoryurl ??
		"";
	const scopeLabel = finding.transitive ? " transitive" : "";
	const countLabel =
		finding.vulnerabilities.length > 1 ? ` (${finding.vulnerabilities.length} advisories)` : "";

	return {
		filePath: finding.projectFile,
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: toSeverity(finding.worstSeverity),
		message: `${finding.packageId}@${finding.resolvedVersion} (${finding.worstSeverity})${scopeLabel}${countLabel}`,
		help: advisory
			? `See ${advisory}; upgrade ${finding.packageId} to a patched version.`
			: `Upgrade ${finding.packageId} to a patched version.`,
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
		detail: "dotnet",
		packageName: finding.packageId,
		// NuGet names an advisory only by its advisory url.
		advisories: finding.vulnerabilities.map((vulnerability) =>
			toDependencyAdvisory([advisoryIdFromUrl(vulnerability.advisoryurl)]),
		),
	};
};

export const parseDotnetAudit = (output: string, rootDirectory: string): Diagnostic[] => {
	if (!output) return [];
	let report: unknown;
	try {
		report = JSON.parse(output);
	} catch {
		return [];
	}
	if (!isRecord(report)) return [];

	const findings = new Map<string, DotnetFinding>();
	for (const project of readRecordArray(report, "projects")) {
		// Keep the whole root-relative path: reducing "src/App/App.csproj" to its
		// basename points the diagnostic at a file that does not exist, hides the
		// project from the exclude filter, and conflates projects that share a
		// basename.
		const projectPath = readString(project, "path");
		const projectFile = projectPath ? projectRelativePosix(rootDirectory, projectPath) : "*.csproj";
		for (const framework of readRecordArray(project, "frameworks")) {
			const packages = [
				...readRecordArray(framework, "topLevelPackages").map((pkg) => ({
					pkg,
					transitive: false,
				})),
				...readRecordArray(framework, "transitivePackages").map((pkg) => ({
					pkg,
					transitive: true,
				})),
			];
			for (const { pkg, transitive } of packages) {
				const finding = toDotnetFinding(pkg, projectFile, transitive);
				if (!finding) continue;
				const key = `${projectFile}:${finding.packageId}:${transitive}`;
				const existing = findings.get(key);
				findings.set(key, existing ? mergeDotnetFindings(existing, finding) : finding);
			}
		}
	}
	return [...findings.values()].map(toDotnetDiagnostic);
};

// The report always carries a `projects` array, even when nothing is vulnerable.
const isDotnetReport = (text: string): boolean => {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isRecord(parsed) || !isRecordArray(parsed.projects)) return false;
		// NuGet aggregates project problems at the report root. Warning-level
		// problems can mean missing vulnerability data even with exit zero.
		if (
			parsed.problems !== undefined &&
			(!isRecordArray(parsed.problems) || parsed.problems.length > 0)
		)
			return false;
		return parsed.projects.every(
			(project) =>
				Boolean(readString(project, "path")) &&
				(project.frameworks === undefined ||
					(isRecordArray(project.frameworks) &&
						project.frameworks.every(
							(framework) =>
								Boolean(readString(framework, "framework")) &&
								["topLevelPackages", "transitivePackages"].every((key) => {
									const packages = framework[key];
									return (
										packages === undefined ||
										(isRecordArray(packages) &&
											packages.every(
												(pkg) =>
													Boolean(readString(pkg, "id")) &&
													isRecordArray(pkg.vulnerabilities) &&
													pkg.vulnerabilities.every(
														(vulnerability) =>
															Boolean(readString(vulnerability, "advisoryurl")) &&
															Boolean(readString(vulnerability, "severity")),
													),
											))
									);
								}),
						))),
		);
	} catch {
		return false;
	}
};

const dotnetAuditSkipped = (project: string): Diagnostic =>
	skippedAuditDiagnostic(
		project,
		`dotnet list package for ${project}`,
		`The NuGet audit for ${project} printed no report, failed, timed out or printed something that is not its JSON report, so vulnerabilities may be missing. Ensure this project's assets are restored, then re-run \`dotnet list "${project}" package --no-restore --vulnerable --include-transitive --format json\` and check its output.`,
	);

const auditDotnet = async (
	rootDirectory: string,
	project: string,
	timeout: number,
): Promise<AuditOutcome> => {
	try {
		const result = await runSubprocess(
			"dotnet",
			[
				"list",
				project,
				"package",
				"--no-restore",
				"--vulnerable",
				"--include-transitive",
				"--format",
				"json",
			],
			{ cwd: rootDirectory, timeout },
		);
		return {
			diagnostics: parseDotnetAudit(result.stdout, rootDirectory),
			completed: result.exitCode === 0 && isDotnetReport(result.stdout),
		};
	} catch (error) {
		// Findings printed before a timeout are kept beside the warning.
		return {
			diagnostics:
				error instanceof SubprocessTimeoutError
					? parseDotnetAudit(error.stdout, rootDirectory)
					: [],
			completed: false,
		};
	}
};

type DotnetAuditContext = Pick<
	EngineContext,
	| "rootDirectory"
	| "dependencyAuditFiles"
	| "dependencyAuditScope"
	| "files"
	| "projectFiles"
	| "excludePatterns"
	| "includePatterns"
>;

const isCsprojPath = (filePath: string): boolean => filePath.toLowerCase().endsWith(".csproj");

const hasSelectedAncestorDirectory = (
	projectDirectory: string,
	selectedDirectories: ReadonlySet<string>,
): boolean => {
	let current = projectDirectory;
	for (;;) {
		if (selectedDirectories.has(current)) return true;
		if (current === ".") return false;
		current = path.posix.dirname(current);
	}
};

const discoverEligibleProjects = (context: DotnetAuditContext): string[] => {
	const gitEnumerated = listProjectFiles(context.rootDirectory);
	const diskCandidates =
		gitEnumerated.length > 0 || fs.existsSync(path.join(context.rootDirectory, ".git"))
			? gitEnumerated
			: enumerateProjectFilesFromDisk(context.rootDirectory, WALK_PRUNE_DIRECTORIES);
	const fallbackCandidates =
		context.dependencyAuditFiles === undefined ? (context.files ?? []) : [];
	return filterDependencyAuditFiles(
		context.rootDirectory,
		[...diskCandidates, ...(context.projectFiles ?? []), ...fallbackCandidates],
		context.excludePatterns,
		context.includePatterns,
	)
		.filter(isCsprojPath)
		.map((file) => projectRelativePosix(context.rootDirectory, file));
};

const selectDotnetProjects = (context: DotnetAuditContext): string[] => {
	const rawInputs =
		context.dependencyAuditFiles ??
		(context.dependencyAuditScope === "full" ? undefined : context.files);
	if (rawInputs === undefined) {
		return [...new Set(discoverEligibleProjects(context))].sort();
	}
	const selectedInputs = filterDependencyAuditFiles(
		context.rootDirectory,
		rawInputs,
		context.excludePatterns,
	).map((file) => projectRelativePosix(context.rootDirectory, file));
	const selectedProjects = new Set<string>(
		filterDependencyAuditFiles(
			context.rootDirectory,
			rawInputs,
			context.excludePatterns,
			context.includePatterns,
		)
			.filter(isCsprojPath)
			.map((file) => projectRelativePosix(context.rootDirectory, file)),
	);
	const propsDirectories = new Set<string>();
	const lockDirectories = new Set<string>();

	for (const input of selectedInputs) {
		const basename = path.posix.basename(input).toLowerCase();
		if (basename === "directory.packages.props") {
			propsDirectories.add(path.posix.dirname(input));
		} else if (basename === "packages.lock.json") {
			lockDirectories.add(path.posix.dirname(input));
		}
	}

	if (propsDirectories.size > 0 || lockDirectories.size > 0) {
		for (const project of discoverEligibleProjects(context)) {
			const projectDirectory = path.posix.dirname(project);
			if (
				lockDirectories.has(projectDirectory) ||
				hasSelectedAncestorDirectory(projectDirectory, propsDirectories)
			) {
				selectedProjects.add(project);
			}
		}
	}

	return [...selectedProjects].sort();
};

// The listing exits zero whether or not a package is vulnerable, and with --format json
// it always prints the report (a `projects` array, empty of packages when nothing is
// vulnerable), so a non-zero exit or output that is not that report is a failed run.
export const inspectDotnetAudit = async (
	context: DotnetAuditContext,
	timeout: number,
): Promise<AuditOutcome> => {
	// Use the discovered manifest scope, resolving central package and lockfile inputs
	// to their affected eligible projects. No audit means no substantiated completion.
	const projects = selectDotnetProjects(context);
	const outcomes = await mapWithConcurrencyLimit(projects, 4, async (project) =>
		warnWhenIncomplete(
			await auditDotnet(context.rootDirectory, project, timeout),
			dotnetAuditSkipped(project),
		),
	);
	return {
		diagnostics: outcomes.flatMap((outcome) => outcome.diagnostics),
		completed: outcomes.length > 0 && outcomes.every((outcome) => outcome.completed),
	};
};
