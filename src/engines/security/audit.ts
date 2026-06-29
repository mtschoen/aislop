// aislop-ignore-file duplicate-block
import fs from "node:fs";
import path from "node:path";
import { runSubprocess } from "../../utils/subprocess.js";
import type { Diagnostic, EngineContext } from "../types.js";
import { runNpmAudit, runPnpmAuditWithFallback } from "./audit-js.js";
import { SEVERITY_RANK, toSeverity, withFixHint } from "./audit-shared.js";

export { parseJsAudit } from "./audit-js.js";

// Dependency metadata that makes pip-audit meaningful for this project (mirrors the
// PYTHON_SIGNALS used for language detection). A bare `pip-audit` invocation audits the
// ambient Python environment aislop runs under, not the repo, so when none of these is
// present - e.g. a source-only tree detected as Python - the dependency audit must stay
// off rather than report environment vulnerabilities against a requirements.txt that does
// not exist.
const PYTHON_DEPENDENCY_MANIFESTS = [
	"requirements.txt",
	"pyproject.toml",
	"setup.py",
	"setup.cfg",
	"Pipfile",
	"poetry.lock",
];

const hasPythonDependencyManifest = (rootDir: string): boolean =>
	PYTHON_DEPENDENCY_MANIFESTS.some((file) => fs.existsSync(path.join(rootDir, file)));

export const runDependencyAudit = async (context: EngineContext): Promise<Diagnostic[]> => {
	const diagnostics: Diagnostic[] = [];
	const timeout = context.config.security.auditTimeout;

	const promises: Promise<Diagnostic[]>[] = [];

	// npm/pnpm audit
	if (context.languages.includes("typescript") || context.languages.includes("javascript")) {
		if (fs.existsSync(path.join(context.rootDirectory, "pnpm-lock.yaml"))) {
			promises.push(runPnpmAuditWithFallback(context.rootDirectory, timeout));
		} else if (
			fs.existsSync(path.join(context.rootDirectory, "package-lock.json")) ||
			fs.existsSync(path.join(context.rootDirectory, "package.json"))
		) {
			promises.push(runNpmAudit(context.rootDirectory, timeout));
		}
	}

	// pip-audit. Requires a Python dependency manifest: bare pip-audit audits the ambient
	// environment, so without metadata to scope it the result describes aislop's own
	// interpreter, not the scanned project.
	if (
		context.languages.includes("python") &&
		context.installedTools["pip-audit"] &&
		hasPythonDependencyManifest(context.rootDirectory)
	) {
		promises.push(runPipAudit(context.rootDirectory, timeout));
	}

	// govulncheck
	if (context.languages.includes("go") && context.installedTools.govulncheck) {
		promises.push(runGovulncheck(context.rootDirectory, timeout));
	}

	// cargo audit
	if (context.languages.includes("rust")) {
		promises.push(runCargoAudit(context.rootDirectory, timeout));
	}

	// dotnet list package --vulnerable (NuGet)
	if (context.languages.includes("csharp") && context.installedTools.dotnet) {
		promises.push(runDotnetAudit(context.rootDirectory, timeout));
	}

	const results = await Promise.allSettled(promises);
	for (const result of results) {
		if (result.status === "fulfilled") {
			diagnostics.push(...result.value);
		}
	}

	return diagnostics;
};

const runPipAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runSubprocess("pip-audit", ["--format=json"], {
			cwd: rootDir,
			timeout,
		});
		if (!result.stdout) return [];
		const parsed = JSON.parse(result.stdout);
		return (parsed.dependencies ?? [])
			.filter(
				(d: Record<string, unknown>) => Array.isArray(d.vulns) && (d.vulns as unknown[]).length > 0,
			)
			.map((d: Record<string, unknown>) => ({
				filePath: "requirements.txt",
				engine: "security" as const,
				rule: "security/vulnerable-dependency",
				severity: "error" as const,
				message: `Vulnerable Python dependency: ${d.name}`,
				help: withFixHint(`Upgrade ${d.name} to fix known vulnerabilities`),
				line: 0,
				column: 0,
				category: "Security",
				fixable: false,
			}));
	} catch {
		return [];
	}
};

const runGovulncheck = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runSubprocess("govulncheck", ["-json", "./..."], {
			cwd: rootDir,
			timeout,
		});
		if (!result.stdout) return [];
		return parseGovulncheckOutput(result.stdout);
	} catch {
		return [];
	}
};

interface GovulncheckEntry {
	vulnerability?: {
		id?: string;
		details?: string;
	};
}

const toGovulnDiagnostic = (entry: GovulncheckEntry): Diagnostic | null => {
	if (!entry.vulnerability) return null;
	return {
		filePath: "go.mod",
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: "error",
		message: `Go vulnerability: ${entry.vulnerability.id ?? "unknown"}`,
		help: withFixHint(entry.vulnerability.details ?? ""),
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
	};
};

const parseGovulncheckOutput = (output: string): Diagnostic[] => {
	const diagnostics: Diagnostic[] = [];
	// govulncheck emits NDJSON: one JSON object per line. Parse each non-empty line
	// and skip anything that is not a JSON object (banner lines, blank lines).
	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		let parsed: GovulncheckEntry | null = null;
		try {
			parsed = JSON.parse(trimmed) as GovulncheckEntry;
		} catch {
			parsed = null;
		}
		if (!parsed || typeof parsed !== "object") continue;

		const diagnostic = toGovulnDiagnostic(parsed);
		if (diagnostic) diagnostics.push(diagnostic);
	}
	return diagnostics;
};

// dotnet / NuGet audit.
// `dotnet list package --vulnerable --include-transitive --format json` emits the
// schema projects -> frameworks -> {topLevelPackages, transitivePackages} -> packages,
// each package carrying id, resolvedVersion and a vulnerabilities list (severity,
// advisoryurl). NuGet severities are Low/Moderate/High/Critical; only vulnerable
// packages appear.

interface DotnetVulnerability {
	severity?: string;
	advisoryurl?: string;
}
interface DotnetPackage {
	id?: string;
	resolvedVersion?: string;
	vulnerabilities?: DotnetVulnerability[];
}
interface DotnetFramework {
	topLevelPackages?: DotnetPackage[];
	transitivePackages?: DotnetPackage[];
}
interface DotnetProject {
	path?: string;
	frameworks?: DotnetFramework[];
}
interface DotnetAuditReport {
	projects?: DotnetProject[];
}

const toDotnetDiagnostic = (
	pkg: DotnetPackage,
	projectFile: string,
	transitive: boolean,
): Diagnostic | null => {
	const vulns = pkg.vulnerabilities ?? [];
	if (vulns.length === 0 || !pkg.id) return null;

	const worstSeverity = vulns.reduce((worst, vuln) => {
		const severity = (vuln.severity ?? "moderate").toLowerCase();
		return (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[worst] ?? 0) ? severity : worst;
	}, "low");
	const advisory = vulns.find((vuln) => vuln.advisoryurl)?.advisoryurl ?? "";
	const scopeLabel = transitive ? " transitive" : "";
	const countLabel = vulns.length > 1 ? ` (${vulns.length} advisories)` : "";

	return {
		filePath: projectFile,
		engine: "security",
		rule: "security/vulnerable-dependency",
		severity: toSeverity(worstSeverity),
		message: `${pkg.id}@${pkg.resolvedVersion ?? "?"} (${worstSeverity})${scopeLabel}${countLabel}`,
		help: advisory
			? `See ${advisory}; upgrade ${pkg.id} to a patched version.`
			: `Upgrade ${pkg.id} to a patched version.`,
		line: 0,
		column: 0,
		category: "Security",
		fixable: false,
		detail: "dotnet",
	};
};

export const parseDotnetAudit = (output: string): Diagnostic[] => {
	if (!output) return [];
	let report: DotnetAuditReport;
	try {
		report = JSON.parse(output) as DotnetAuditReport;
	} catch {
		return [];
	}

	const diagnostics: Diagnostic[] = [];
	// A multi-targeted project lists the same vulnerable package once per framework;
	// dedupe so a net8/net10 project doesn't report each finding twice.
	const seen = new Set<string>();
	for (const project of report.projects ?? []) {
		const projectFile = project.path ? path.basename(project.path) : "*.csproj";
		for (const framework of project.frameworks ?? []) {
			const packages = [
				...(framework.topLevelPackages ?? []).map((pkg) => ({ pkg, transitive: false })),
				...(framework.transitivePackages ?? []).map((pkg) => ({ pkg, transitive: true })),
			];
			for (const { pkg, transitive } of packages) {
				const key = `${projectFile}:${pkg.id}:${transitive}`;
				if (seen.has(key)) continue;
				const diagnostic = toDotnetDiagnostic(pkg, projectFile, transitive);
				if (!diagnostic) continue;
				seen.add(key);
				diagnostics.push(diagnostic);
			}
		}
	}
	return diagnostics;
};

const runDotnetAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runSubprocess(
			"dotnet",
			["list", "package", "--vulnerable", "--include-transitive", "--format", "json"],
			{ cwd: rootDir, timeout },
		);
		return parseDotnetAudit(result.stdout);
	} catch {
		return [];
	}
};

const runCargoAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runSubprocess("cargo", ["audit", "--json"], {
			cwd: rootDir,
			timeout,
		});
		if (!result.stdout) return [];
		const parsed = JSON.parse(result.stdout);
		return (parsed.vulnerabilities?.list ?? []).map((v: Record<string, unknown>) => ({
			filePath: "Cargo.toml",
			engine: "security" as const,
			rule: "security/vulnerable-dependency",
			severity: "error" as const,
			message: `Rust vulnerability: ${(v.advisory as Record<string, unknown>)?.id ?? "unknown"}`,
			help: withFixHint(
				((v.advisory as Record<string, unknown>)?.title as string | undefined) ?? "",
			),
			line: 0,
			column: 0,
			category: "Security",
			fixable: false,
		}));
	} catch {
		return [];
	}
};
