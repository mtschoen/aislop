// aislop-ignore-file duplicate-block
import fs from "node:fs";
import path from "node:path";
import { isDependencyAuditInputFile } from "../../utils/source-file-selection.js";
import { runSubprocess } from "../../utils/subprocess.js";
import type { Diagnostic, EngineContext } from "../types.js";
import { runCargoAudit, runDotnetAudit, runGovulncheck, runPipAudit } from "./audit-ecosystem.js";
import { type JsAuditSource, parseBunAudit, parseJsAudit } from "./audit-js-parser.js";

export { parseDotnetAudit } from "./audit-ecosystem.js";
export { parseBunAudit, parseJsAudit } from "./audit-js-parser.js";

const toRelativePath = (rootDirectory: string, filePath: string): string => {
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(rootDirectory, filePath);
	return path.relative(rootDirectory, absolute).split(path.sep).join("/");
};

export const shouldRunDependencyAudit = (context: EngineContext): boolean => {
	if (context.dependencyAuditScope === "full") return true;
	const scopedFiles = context.dependencyAuditFiles ?? context.files;
	if (!scopedFiles) return true;
	return scopedFiles.some((file) =>
		isDependencyAuditInputFile(toRelativePath(context.rootDirectory, file)),
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
	const auditLanguages = context.dependencyAuditLanguages ?? context.languages;

	const promises: Promise<Diagnostic[]>[] = [];

	// npm/pnpm/bun audit
	if (auditLanguages.includes("typescript") || auditLanguages.includes("javascript")) {
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
		auditLanguages.includes("python") &&
		context.installedTools["pip-audit"] &&
		hasPythonDependencyManifest(context.rootDirectory)
	) {
		promises.push(runPipAudit(context.rootDirectory, timeout));
	}

	// govulncheck
	if (auditLanguages.includes("go") && context.installedTools.govulncheck) {
		promises.push(runGovulncheck(context.rootDirectory, timeout));
	}

	// cargo audit
	if (auditLanguages.includes("rust")) {
		promises.push(runCargoAudit(context.rootDirectory, timeout));
	}

	// dotnet list package --vulnerable (NuGet). Keyed to the manifest-aware
	// audit languages like the other ecosystems: a .csproj is what the audit
	// needs, even when no .cs file is in the scan scope.
	if (
		auditLanguages.includes("csharp") &&
		context.installedTools.dotnet &&
		context.config.lint.csharp?.projectEvaluation === true
	) {
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

const hasBunLockfile = (rootDir: string): boolean =>
	fs.existsSync(path.join(rootDir, "bun.lock")) || fs.existsSync(path.join(rootDir, "bun.lockb"));

const errorMessageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const auditSkippedDiagnostic = (source: JsAuditSource, help: string): Diagnostic => ({
	filePath: "package.json",
	engine: "security",
	rule: "security/dependency-audit-skipped",
	severity: "warning",
	message: `Dependency audit did not complete (${source})`,
	help,
	line: 0,
	column: 0,
	category: "Security",
	fixable: false,
});

export const isPathWithin = (parentDirectory: string, candidatePath: string): boolean => {
	const pathOperations =
		path.win32.isAbsolute(parentDirectory) || path.win32.isAbsolute(candidatePath)
			? path.win32
			: path;
	const relativePath = pathOperations.relative(parentDirectory, candidatePath);
	return (
		relativePath === "" ||
		(!pathOperations.isAbsolute(relativePath) &&
			!relativePath.startsWith(`..${pathOperations.sep}`) &&
			relativePath !== "..")
	);
};

const resolveWindowsPackageManager = (
	packageManager: "npm" | "pnpm",
	rootDirectory: string,
): string | undefined => {
	const pathValue = process.env.PATH;
	if (!pathValue) return undefined;

	const executableExtensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.map((extension) => extension.trim().toLowerCase())
		.filter((extension) => /^\.[a-z0-9]+$/.test(extension));
	const absoluteRoot = path.resolve(rootDirectory);
	const canonicalRoot = fs.realpathSync(rootDirectory);

	for (const rawDirectory of pathValue.split(path.delimiter)) {
		const directory = rawDirectory.trim().replace(/^"(.*)"$/, "$1");
		if (!directory || !path.isAbsolute(directory)) continue;

		for (const extension of executableExtensions) {
			const candidatePath = path.join(directory, `${packageManager}${extension}`);
			if (isPathWithin(absoluteRoot, path.resolve(candidatePath))) continue;
			if (!fs.existsSync(candidatePath)) continue;
			try {
				const canonicalCandidate = fs.realpathSync(candidatePath);
				if (isPathWithin(canonicalRoot, canonicalCandidate)) continue;
				if (!fs.statSync(canonicalCandidate).isFile()) continue;
				return canonicalCandidate;
			} catch {
				// A PATH entry may disappear between discovery and inspection.
			}
		}
	}

	return undefined;
};

const runPackageManagerAudit = (
	packageManager: "npm" | "pnpm",
	rootDirectory: string,
	timeout: number,
) => {
	const auditArguments = ["audit", "--json"];
	if (process.platform !== "win32") {
		return runSubprocess(packageManager, auditArguments, { cwd: rootDirectory, timeout });
	}

	const executablePath = resolveWindowsPackageManager(packageManager, rootDirectory);
	if (!executablePath) {
		throw new Error(`${packageManager} was not found in a safe absolute PATH entry`);
	}
	const executableExtension = path.extname(executablePath).toLowerCase();
	if (executableExtension === ".exe" || executableExtension === ".com") {
		return runSubprocess(executablePath, auditArguments, { cwd: rootDirectory, timeout });
	}

	const commandInterpreter =
		process.env.ComSpec ??
		(process.env.SystemRoot
			? path.win32.join(process.env.SystemRoot, "System32", "cmd.exe")
			: undefined);
	if (!commandInterpreter || !path.win32.isAbsolute(commandInterpreter)) {
		throw new Error("Windows command interpreter path is unavailable");
	}
	return runSubprocess(commandInterpreter, ["/d", "/c", executablePath, ...auditArguments], {
		cwd: rootDirectory,
		timeout,
	});
};

interface PackageManagerAuditPayloadState {
	recognized: boolean;
	reportsError: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isAuditCollection = (value: unknown): boolean =>
	isRecord(value) &&
	(Object.keys(value).length === 0 || Object.values(value).some((entry) => isRecord(entry)));

const inspectPackageManagerAuditPayload = (output: string): PackageManagerAuditPayloadState => {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!isRecord(parsed)) return { recognized: false, reportsError: false };
		const reportsError = isRecord(parsed.error);
		return {
			recognized:
				reportsError ||
				isAuditCollection(parsed.vulnerabilities) ||
				isAuditCollection(parsed.advisories),
			reportsError,
		};
	} catch {
		return { recognized: false, reportsError: false };
	}
};

const parsePackageManagerAuditResult = (
	result: Awaited<ReturnType<typeof runSubprocess>>,
	source: JsAuditSource,
): Diagnostic[] => {
	const payloadState = inspectPackageManagerAuditPayload(result.stdout);
	if (!payloadState.recognized) {
		const detail = result.stderr || (result.stdout ? "invalid JSON output" : "no JSON output");
		return [auditSkippedDiagnostic(source, `Failed to run ${source}: ${detail}`)];
	}

	const diagnostics = parseJsAudit(result.stdout, source);
	if ((payloadState.reportsError || result.exitCode !== 0) && diagnostics.length === 0) {
		return [
			auditSkippedDiagnostic(
				source,
				`Failed to run ${source}: ${result.stderr || `exit code ${result.exitCode ?? "unknown"}`}`,
			),
		];
	}
	return diagnostics;
};

const runNpmAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runPackageManagerAudit("npm", rootDir, timeout);
		return parsePackageManagerAuditResult(result, "npm audit");
	} catch (error) {
		return [
			auditSkippedDiagnostic("npm audit", `Failed to run npm audit: ${errorMessageOf(error)}`),
		];
	}
};

const runBunAudit = async (rootDir: string, timeout: number): Promise<Diagnostic[]> => {
	try {
		const result = await runSubprocess("bun", ["audit", "--json"], {
			cwd: rootDir,
			timeout,
		});
		if (result.stdout) {
			return parseBunAudit(result.stdout);
		}
		if (result.exitCode === 0) return [];
		return [
			auditSkippedDiagnostic(
				"bun audit",
				`Failed to run bun audit: ${result.stderr || "unknown error"}`,
			),
		];
	} catch (error) {
		return [
			auditSkippedDiagnostic("bun audit", `Failed to run bun audit: ${errorMessageOf(error)}`),
		];
	}
};

const runPnpmAuditWithFallback = async (
	rootDir: string,
	timeout: number,
): Promise<Diagnostic[]> => {
	const canFallbackToNpm = fs.existsSync(path.join(rootDir, "package-lock.json"));

	try {
		const result = await runPackageManagerAudit("pnpm", rootDir, timeout);
		const diagnostics = parsePackageManagerAuditResult(result, "pnpm audit");
		const hasAuditFailure = diagnostics.some((d) => d.rule === "security/dependency-audit-skipped");
		if (hasAuditFailure) {
			if (canFallbackToNpm) {
				return runNpmAudit(rootDir, timeout);
			}
			return diagnostics;
		}
		return diagnostics;
	} catch (error) {
		if (canFallbackToNpm) {
			return runNpmAudit(rootDir, timeout);
		}
		return [
			auditSkippedDiagnostic("pnpm audit", `Failed to run pnpm audit: ${errorMessageOf(error)}`),
		];
	}
};
