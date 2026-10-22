import fs from "node:fs";
import path from "node:path";
import { detectInvocation } from "../../ui/invocation.js";
import { runSubprocess, SubprocessTimeoutError } from "../../utils/subprocess.js";
import type { DependencyAdvisory, Diagnostic } from "../types.js";
import { findUnauditableRequirement } from "./audit-pip-requirements.js";
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
	skippedHelp(
		"pip-audit",
		"Python",
		"pip-audit --format=json --disable-pip --no-deps -r requirements.txt",
	),
);
const CARGO_AUDIT_SKIPPED = skippedAuditDiagnostic(
	"Cargo.toml",
	"cargo audit",
	skippedHelp("cargo audit", "Rust", "cargo audit --json"),
);

const pipDiagnostics = (parsed: Record<string, unknown>): Diagnostic[] =>
	readRecordArray(parsed, "dependencies")
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

const PIP_REQUIREMENTS_FILE = "requirements.txt";

// Bare `pip-audit` audits the Python environment aislop runs under, not the project
// (https://pypi.org/project/pip-audit/: no input arguments means the environment), so the
// project's own requirements file is passed with `-r`. A project without one is not
// audited at all: auditing the wrong environment could report a clean result for a
// vulnerable project. The file is repository-controlled, so pip-audit runs with pip disabled
// (audit-pip-requirements.ts) and a file that needs pip to resolve is not audited.
const PIP_AUDIT_NO_REQUIREMENTS = skippedAuditDiagnostic(
	PIP_REQUIREMENTS_FILE,
	"pip-audit",
	"pip-audit was not run because the project has no requirements.txt to audit, and running it without one would audit aislop's own Python environment. Export one (for example `uv export --no-hashes -o requirements.txt` or `poetry export -o requirements.txt`) to enable the Python dependency audit.",
);

const PIP_AUDIT_ARGUMENTS = [
	"--format=json",
	"--disable-pip",
	"--no-deps",
	"-r",
	PIP_REQUIREMENTS_FILE,
];

const pipAuditNeedsPip = (unauditable: string): Diagnostic =>
	skippedAuditDiagnostic(
		PIP_REQUIREMENTS_FILE,
		"pip-audit",
		`pip-audit was not run because requirements.txt contains \`${unauditable}\`, which is not an exact \`name==version\` pin. Auditing it would make pip resolve or build the requirement, which can run code from the repository. Pin every requirement (for example \`uv export --no-hashes -o requirements.txt\`) to enable the Python dependency audit.`,
	);

const auditPip = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	let result: Awaited<ReturnType<typeof runSubprocess>>;
	try {
		result = await runSubprocess("pip-audit", PIP_AUDIT_ARGUMENTS, {
			cwd: rootDir,
			timeout,
		});
	} catch (error) {
		// Findings printed before a timeout are kept; the audit still did not complete.
		return { diagnostics: timedOutPipFindings(error), completed: false };
	}
	try {
		if (!result.stdout) return incompleteAudit();
		const parsed: unknown = JSON.parse(result.stdout);
		if (!isRecord(parsed)) return incompleteAudit();
		const diagnostics = pipDiagnostics(parsed);
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

const timedOutPipFindings = (error: unknown): Diagnostic[] => {
	if (!(error instanceof SubprocessTimeoutError) || !error.stdout) return [];
	try {
		const parsed: unknown = JSON.parse(error.stdout);
		return isRecord(parsed) ? pipDiagnostics(parsed) : [];
	} catch {
		return [];
	}
};

export const inspectPipAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	const requirementsPath = path.join(rootDir, PIP_REQUIREMENTS_FILE);
	if (!fs.existsSync(requirementsPath)) {
		return { diagnostics: [PIP_AUDIT_NO_REQUIREMENTS], completed: false };
	}
	let unauditable: string | undefined;
	try {
		unauditable = findUnauditableRequirement(fs.readFileSync(requirementsPath, "utf8"));
	} catch {
		unauditable = "(requirements.txt could not be read)";
	}
	if (unauditable !== undefined) {
		return { diagnostics: [pipAuditNeedsPip(unauditable)], completed: false };
	}
	return warnWhenIncomplete(await auditPip(rootDir, timeout), PIP_AUDIT_SKIPPED);
};

export const runPipAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectPipAudit(rootDir, timeout)).diagnostics;

const readCargoReport = (result: Awaited<ReturnType<typeof runSubprocess>>): AuditOutcome => {
	try {
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

const auditCargo = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	try {
		return readCargoReport(
			await runSubprocess("cargo", ["audit", "--json"], { cwd: rootDir, timeout }),
		);
	} catch (error) {
		// Findings printed before a timeout are kept beside the warning.
		if (!(error instanceof SubprocessTimeoutError)) return incompleteAudit();
		const printed = readCargoReport({ stdout: error.stdout, stderr: error.stderr, exitCode: null });
		return { diagnostics: printed.diagnostics, completed: false };
	}
};

export const inspectCargoAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> =>
	warnWhenIncomplete(await auditCargo(rootDir, timeout), CARGO_AUDIT_SKIPPED);

export const runCargoAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectCargoAudit(rootDir, timeout)).diagnostics;
