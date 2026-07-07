// aislop-ignore-file duplicate-block
import fs from "node:fs";
import path from "node:path";
import { runSubprocess } from "../../utils/subprocess.js";
import type { Diagnostic, EngineContext } from "../types.js";
import { runCargoAudit, runGovulncheck, runPipAudit } from "./audit-ecosystem.js";
import { hasBunLockfile, runBunAudit, runNpmAudit, runPnpmAuditWithFallback } from "./audit-js.js";
import { SEVERITY_RANK, toSeverity } from "./audit-shared.js";

export { parseBunAudit, parseJsAudit } from "./audit-js.js";

const AUDIT_INPUT_FILE_RE =
	/(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements(?:\.[\w-]+)?\.txt|pyproject\.toml|Pipfile|Pipfile\.lock|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|[\w.-]+\.csproj|packages\.lock\.json|Directory\.Packages\.props)$/i;

const toRelativePath = (rootDirectory: string, filePath: string): string => {
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(rootDirectory, filePath);
	return path.relative(rootDirectory, absolute).split(path.sep).join("/");
};

export const shouldRunDependencyAudit = (context: EngineContext): boolean => {
	if (!context.files) return true;
	return context.files.some((file) =>
		AUDIT_INPUT_FILE_RE.test(toRelativePath(context.rootDirectory, file)),
	);
};

// Dependency metadata that makes pip-audit meaningful for this project (mirrors the
// PYTHON_SIGNALS used for language detection). A bare `pip-audit` invocation audits the
// ambient Python environment aislop runs under, not the repo, so when none of these is
// present - e.g. a source-only tree now detected as Python, or an unscoped run with no
// `context.files` - the dependency audit must stay off rather than report environment
// vulnerabilities against a requirements.txt that does not exist.
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
	if (!shouldRunDependencyAudit(context)) return [];

	const diagnostics: Diagnostic[] = [];
	const timeout = context.config.security.auditTimeout;

	const promises: Promise<Diagnostic[]>[] = [];

	// npm/pnpm/bun audit
	if (context.languages.includes("typescript") || context.languages.includes("javascript")) {
		if (fs.existsSync(path.join(context.rootDirectory, "pnpm-lock.yaml"))) {
			promises.push(runPnpmAuditWithFallback(context.rootDirectory, timeout));
		} else if (hasBunLockfile(context.rootDirectory)) {
			promises.push(runBunAudit(context.rootDirectory, timeout));
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
