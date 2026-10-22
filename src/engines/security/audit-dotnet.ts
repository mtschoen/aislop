import { projectRelativePosix } from "../../utils/paths.js";
import { runSubprocess, SubprocessTimeoutError } from "../../utils/subprocess.js";
import type { Diagnostic } from "../types.js";
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

// `dotnet list package --vulnerable --include-transitive --format json` emits the
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

const DOTNET_AUDIT_SKIPPED = skippedAuditDiagnostic(
	"*.csproj",
	"dotnet list package",
	"dotnet list package printed no report, failed, timed out or printed something that is not its JSON report, so NuGet vulnerabilities may be missing. Re-run `dotnet list package --vulnerable --include-transitive --format json` and check its output.",
);

const auditDotnet = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	try {
		const result = await runSubprocess(
			"dotnet",
			[
				"list",
				"package",
				"--no-restore",
				"--vulnerable",
				"--include-transitive",
				"--format",
				"json",
			],
			{ cwd: rootDir, timeout },
		);
		return {
			diagnostics: parseDotnetAudit(result.stdout, rootDir),
			completed: result.exitCode === 0 && isDotnetReport(result.stdout),
		};
	} catch (error) {
		// Findings printed before a timeout are kept beside the warning.
		return {
			diagnostics:
				error instanceof SubprocessTimeoutError ? parseDotnetAudit(error.stdout, rootDir) : [],
			completed: false,
		};
	}
};

// The listing exits zero whether or not a package is vulnerable, and with --format json
// it always prints the report (a `projects` array, empty of packages when nothing is
// vulnerable), so a non-zero exit or output that is not that report is a failed run.
export const inspectDotnetAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> =>
	warnWhenIncomplete(await auditDotnet(rootDir, timeout), DOTNET_AUDIT_SKIPPED);
