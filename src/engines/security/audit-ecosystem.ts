import { detectInvocation } from "../../ui/invocation.js";
import { runSubprocess } from "../../utils/subprocess.js";
import type { DependencyAdvisory, Diagnostic } from "../types.js";
import {
	type AuditOutcome,
	exitedAsAuditTool,
	incompleteAudit,
	skippedAuditDiagnostic,
	toDependencyAdvisory,
	warnWhenIncomplete,
} from "./audit-shared.js";
import { isRecord, isRecordArray, readRecordArray, readString } from "./audit-value.js";

export { inspectDotnetAudit, parseDotnetAudit } from "./audit-dotnet.js";
export { inspectGovulncheck, runGovulncheck } from "./audit-govulncheck.js";

const withFixHint = (rest: string): string => {
	const invocation = detectInvocation();
	const suffix = rest ? ` - ${rest}` : "";
	return `Run \`${invocation} fix -f\` to apply this fix${suffix}`;
};

interface DependencyIdentity {
	packageName?: string;
	advisories: DependencyAdvisory[];
}

const dependencyDiagnostic = (
	filePath: string,
	message: string,
	help: string,
	identity: DependencyIdentity,
): Diagnostic => ({
	...identity,
	filePath,
	engine: "security",
	rule: "security/vulnerable-dependency",
	severity: "error",
	message,
	help,
	line: 0,
	column: 0,
	category: "Security",
	fixable: false,
});

const skippedHelp = (tool: string, ecosystem: string, command: string): string =>
	`${tool} printed no report, failed, timed out or printed something that is not its report, so ${ecosystem} vulnerabilities may be missing. Re-run \`${command}\` and check its output.`;

// Neither pip-audit nor cargo audit prints nothing on a clean project: both always
// print their JSON report, so empty output is a failed run.
const PIP_AUDIT_SKIPPED = skippedAuditDiagnostic(
	"requirements.txt",
	"pip-audit",
	skippedHelp("pip-audit", "Python", "pip-audit --format=json"),
);
const CARGO_AUDIT_SKIPPED = skippedAuditDiagnostic(
	"Cargo.toml",
	"cargo audit",
	skippedHelp("cargo audit", "Rust", "cargo audit --json"),
);

const auditPip = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	try {
		const result = await runSubprocess("pip-audit", ["--format=json"], {
			cwd: rootDir,
			timeout,
		});
		if (!result.stdout) return incompleteAudit();
		const parsed: unknown = JSON.parse(result.stdout);
		if (!isRecord(parsed)) return incompleteAudit();
		const diagnostics = readRecordArray(parsed, "dependencies")
			.filter((dependency) => readRecordArray(dependency, "vulns").length > 0)
			.flatMap((dependency): Diagnostic[] => {
				const name = readString(dependency, "name");
				if (!name) return [];
				return [
					dependencyDiagnostic(
						"requirements.txt",
						`Vulnerable Python dependency: ${name}`,
						withFixHint(`Upgrade ${name} to fix known vulnerabilities`),
						{
							packageName: name,
							advisories: readRecordArray(dependency, "vulns").map((vulnerability) =>
								toDependencyAdvisory([readString(vulnerability, "id")], vulnerability.aliases),
							),
						},
					),
				];
			});
		// pip-audit exits 1 when it finds vulnerabilities and 0 when it finds none
		// (https://pypi.org/project/pip-audit/, "Exit codes"); anything else failed.
		return {
			diagnostics,
			completed:
				isRecordArray(parsed.dependencies) &&
				parsed.dependencies.every(
					(dependency) =>
						Boolean(readString(dependency, "name")) &&
						Boolean(readString(dependency, "version")) &&
						!("skip_reason" in dependency) &&
						isRecordArray(dependency.vulns) &&
						dependency.vulns.every((vulnerability) => Boolean(readString(vulnerability, "id"))),
				) &&
				exitedAsAuditTool(result.exitCode, diagnostics.length > 0),
		};
	} catch {
		return incompleteAudit();
	}
};

export const inspectPipAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> =>
	warnWhenIncomplete(await auditPip(rootDir, timeout), PIP_AUDIT_SKIPPED);

export const runPipAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectPipAudit(rootDir, timeout)).diagnostics;

const auditCargo = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	try {
		const result = await runSubprocess("cargo", ["audit", "--json"], {
			cwd: rootDir,
			timeout,
		});
		if (!result.stdout) return incompleteAudit();
		const parsed: unknown = JSON.parse(result.stdout);
		if (!isRecord(parsed) || !isRecord(parsed.vulnerabilities)) return incompleteAudit();
		const diagnostics = readRecordArray(parsed.vulnerabilities, "list").flatMap(
			(vulnerability): Diagnostic[] => {
				const advisory = vulnerability.advisory;
				if (!isRecord(advisory)) return [];
				const id = readString(advisory, "id");
				if (!id) return [];
				return [
					dependencyDiagnostic(
						"Cargo.toml",
						`Rust vulnerability: ${id}`,
						withFixHint(readString(advisory, "title") ?? ""),
						{
							packageName: isRecord(vulnerability.package)
								? readString(vulnerability.package, "name")
								: undefined,
							advisories: [toDependencyAdvisory([id], advisory.aliases)],
						},
					),
				];
			},
		);
		const vulnerabilities = parsed.vulnerabilities;
		const validVulnerabilities =
			isRecordArray(vulnerabilities.list) &&
			vulnerabilities.list.every(
				(vulnerability) =>
					isRecord(vulnerability.advisory) &&
					Boolean(readString(vulnerability.advisory, "id")) &&
					isRecord(vulnerability.package) &&
					Boolean(readString(vulnerability.package, "name")) &&
					Boolean(readString(vulnerability.package, "version")),
			) &&
			vulnerabilities.count === vulnerabilities.list.length &&
			vulnerabilities.found === vulnerabilities.list.length > 0;
		const reportedWarnings = parsed.warnings;
		const validWarnings =
			reportedWarnings === undefined ||
			(isRecord(reportedWarnings) &&
				Object.entries(reportedWarnings).every(
					([kind, warnings]) =>
						isRecordArray(warnings) &&
						warnings.every(
							(warning) =>
								warning.kind === kind &&
								isRecord(warning.package) &&
								Boolean(readString(warning.package, "name")) &&
								Boolean(readString(warning.package, "version")),
						),
				));
		const warnings = isRecord(reportedWarnings)
			? Object.keys(reportedWarnings).flatMap((kind) => readRecordArray(reportedWarnings, kind))
			: [];
		const completed =
			validVulnerabilities &&
			validWarnings &&
			exitedAsAuditTool(result.exitCode, diagnostics.length > 0 || warnings.length > 0);
		// Exit 1 also means a completed audit denied policy warnings. The JSON does
		// not identify which warnings were denied, so report the set without guessing.
		if (completed && result.exitCode === 1 && diagnostics.length === 0) {
			diagnostics.push({
				...dependencyDiagnostic("Cargo.toml", "", "", { advisories: [] }),
				rule: "security/dependency-audit-policy",
				message: `cargo audit denied dependency policy warnings: ${warnings.map((warning) => `${warning.kind} (${isRecord(warning.package) ? readString(warning.package, "name") : "?"})`).join(", ")}`,
				help: "Review the reported packages and the deny settings in .cargo/audit.toml; re-run `cargo audit --json`.",
			});
		}
		return { diagnostics, completed };
	} catch {
		return incompleteAudit();
	}
};

export const inspectCargoAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> =>
	warnWhenIncomplete(await auditCargo(rootDir, timeout), CARGO_AUDIT_SKIPPED);

export const runCargoAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectCargoAudit(rootDir, timeout)).diagnostics;
