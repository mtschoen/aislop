import { detectInvocation } from "../../ui/invocation.js";
import { runSubprocess } from "../../utils/subprocess.js";
import type { DependencyAdvisory, Diagnostic } from "../types.js";
import {
	type AuditOutcome,
	exitedAsAuditTool,
	incompleteAudit,
	toDependencyAdvisory,
} from "./audit-shared.js";
import { isRecord, readRecordArray, readString } from "./audit-value.js";

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

export const inspectPipAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
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
				Array.isArray(parsed.dependencies) &&
				exitedAsAuditTool(result.exitCode, diagnostics.length > 0),
		};
	} catch {
		return incompleteAudit();
	}
};

export const runPipAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectPipAudit(rootDir, timeout)).diagnostics;

export const inspectCargoAudit = async (
	rootDir: string,
	timeout: number,
): Promise<AuditOutcome> => {
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
		// cargo audit exits 1 when it finds vulnerabilities and 0 when it finds none
		// (https://github.com/rustsec/rustsec/tree/main/cargo-audit); anything else failed.
		return { diagnostics, completed: exitedAsAuditTool(result.exitCode, diagnostics.length > 0) };
	} catch {
		return incompleteAudit();
	}
};

export const runCargoAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> =>
	(await inspectCargoAudit(rootDir, timeout)).diagnostics;
