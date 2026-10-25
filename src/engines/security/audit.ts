// aislop-ignore-file duplicate-block -- runNpmAudit, runBunAudit, and runPnpmAuditWithFallback are per-package-manager audit runners; bun emits a different JSON shape than npm/pnpm (hence its own parser) and pnpm has an npm fallback path the others do not, so the similar try/catch wrapping reflects three distinct external tools rather than one tool called three times
import fs from "node:fs";
import path from "node:path";
import { isDependencyAuditInputFile } from "../../utils/source-file-selection.js";
import { runSubprocess, SubprocessTimeoutError } from "../../utils/subprocess.js";
import type { Diagnostic, EngineContext } from "../types.js";
import { applyAcceptedAdvisories, dateStamp } from "./accepted-advisories.js";
import {
	inspectCargoAudit,
	inspectDotnetAudit,
	inspectGovulncheck,
	inspectPipAudit,
} from "./audit-ecosystem.js";
import { mergeFallbackOutcome } from "./audit-fallback-merge.js";
import {
	dropsMalformedRecords,
	isBunReport,
	type JsAuditManifest,
	type JsAuditSource,
	parseBunAudit,
	parseJsAudit,
} from "./audit-js-parser.js";
import { type AuditOutcome, exitedAsAuditTool, skippedAuditDiagnostic } from "./audit-shared.js";
import { readRuntimeDependencies } from "./runtime-dependencies.js";

export { parseDotnetAudit } from "./audit-ecosystem.js";
export { parseBunAudit, parseJsAudit } from "./audit-js-parser.js";

const toRelativePath = (rootDirectory: string, filePath: string): string => {
	const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(rootDirectory, filePath);
	return path.relative(rootDirectory, absolute).split(path.sep).join("/");
};

export const shouldRunDependencyAudit = (
	context: Pick<
		EngineContext,
		"rootDirectory" | "dependencyAuditScope" | "dependencyAuditFiles" | "files"
	>,
): boolean => {
	if (context.dependencyAuditScope === "full") return true;
	const scopedFiles = context.dependencyAuditFiles ?? context.files;
	if (!scopedFiles) return true;
	return scopedFiles.some((file) =>
		isDependencyAuditInputFile(toRelativePath(context.rootDirectory, file)),
	);
};

// Dependency metadata that makes pip-audit meaningful for this project (mirrors the
// PYTHON_SIGNALS used for language detection). With none of these present - e.g. a
// source-only tree now detected as Python, or an unscoped run with no `context.files` -
// the dependency audit stays off. With one present, pip-audit audits requirements.txt
// only; a project without that file gets a skipped-audit warning (see audit-ecosystem.ts).
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

const countRelevantEcosystems = (auditLanguages: readonly string[]): number =>
	[
		auditLanguages.includes("typescript") || auditLanguages.includes("javascript"),
		auditLanguages.includes("python"),
		auditLanguages.includes("go"),
		auditLanguages.includes("rust"),
		auditLanguages.includes("csharp"),
	].filter(Boolean).length;

const CARGO_DISCOVERY_SKIPPED = skippedAuditDiagnostic(
	"Cargo.toml",
	"cargo audit",
	"Cargo subcommand discovery failed, timed out or printed no listing, so Rust vulnerabilities may be missing. Re-run `cargo --color never --list` and check its output.",
);

export const runDependencyAudit = async (context: EngineContext): Promise<Diagnostic[]> => {
	if (!shouldRunDependencyAudit(context)) return [];

	const diagnostics: Diagnostic[] = [];
	const timeout = context.config.security.auditTimeout;
	const auditLanguages = context.dependencyAuditLanguages ?? context.languages;

	const promises: Promise<AuditOutcome>[] = [];

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
		promises.push(inspectPipAudit(context.rootDirectory, timeout));
	}

	// govulncheck
	if (auditLanguages.includes("go") && context.installedTools.govulncheck) {
		promises.push(inspectGovulncheck(context.rootDirectory, timeout));
	}

	// cargo audit. A machine without the cargo-audit subcommand has nothing to run, like
	// the tools above, so that is not reported as an audit that failed.
	if (auditLanguages.includes("rust") && context.installedTools["cargo-audit"]) {
		promises.push(inspectCargoAudit(context.rootDirectory, timeout));
	} else if (
		auditLanguages.includes("rust") &&
		context.installedTools["cargo-audit-discovery-failed"]
	) {
		diagnostics.push(CARGO_DISCOVERY_SKIPPED);
	}

	// dotnet list package --vulnerable (NuGet). Keyed to the manifest-aware
	// audit languages like the other ecosystems: a .csproj is what the audit
	// needs, even when no .cs file is in the scan scope.
	if (
		auditLanguages.includes("csharp") &&
		context.installedTools.dotnet &&
		context.config.lint.csharp?.projectEvaluation === true
	) {
		promises.push(inspectDotnetAudit(context, timeout));
	}

	const results = await Promise.allSettled(promises);
	for (const result of results) {
		if (result.status === "fulfilled") {
			diagnostics.push(...result.value.diagnostics);
		}
	}

	// An acceptance entry names an advisory id, which does not say which ecosystem it
	// belongs to. So an entry is judged stale only when EVERY audit ecosystem the
	// project uses was audited in this run and vouched for its own result: a tool that
	// failed, was offline, was not installed or printed something other than its report
	// proves nothing about what is absent. Missing a stale notice is preferred to a
	// false one.
	const auditedEcosystems = promises.length;
	const auditCompleted =
		auditedEcosystems === countRelevantEcosystems(auditLanguages) &&
		auditedEcosystems > 0 &&
		results.every((result) => result.status === "fulfilled" && result.value.completed);
	return applyAcceptedAdvisories(diagnostics, context.config.security.acceptedAdvisories ?? [], {
		today: dateStamp(new Date()),
		auditCompleted,
	});
};

const AUDIT_SKIPPED_RULE = "security/dependency-audit-skipped";

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

const failedAudit = (
	source: JsAuditSource,
	reason: string,
	findings: Diagnostic[] = [],
): AuditOutcome => ({
	diagnostics: [auditSkippedDiagnostic(source, `Failed to run ${source}: ${reason}`), ...findings],
	completed: false,
});

// Findings a command printed before it timed out are kept next to the skipped warning.
const timedOutAudit = (
	error: unknown,
	source: JsAuditSource,
	parse: (stdout: string) => Diagnostic[],
): AuditOutcome => {
	const findings =
		error instanceof SubprocessTimeoutError && error.stdout
			? parse(error.stdout).filter((diagnostic) => diagnostic.rule !== AUDIT_SKIPPED_RULE)
			: [];
	return failedAudit(source, errorMessageOf(error), findings);
};

// npm audit and pnpm audit exit 1 when they find vulnerabilities (npm-audit docs: "exit
// with a non-zero code if any vulnerability is found"). Any other exit, an `error` payload
// or a dropped malformed record means the report is not the whole picture: the readable
// findings stay, beside the skipped-audit warning.
const parsePackageManagerAuditResult = (
	result: Awaited<ReturnType<typeof runSubprocess>>,
	source: JsAuditSource,
	manifest?: JsAuditManifest,
): AuditOutcome => {
	const payloadState = inspectPackageManagerAuditPayload(result.stdout);
	if (!payloadState.recognized) {
		return failedAudit(
			source,
			result.stderr || (result.stdout ? "invalid JSON output" : "no JSON output"),
		);
	}

	const diagnostics = parseJsAudit(result.stdout, source, manifest);
	const alreadyReported = diagnostics.some((d) => d.rule === AUDIT_SKIPPED_RULE);
	const malformed = dropsMalformedRecords(result.stdout);
	const completed =
		!alreadyReported &&
		!payloadState.reportsError &&
		!malformed &&
		exitedAsAuditTool(result.exitCode, diagnostics.length > 0);
	if (completed || alreadyReported) return { diagnostics, completed };
	const reason =
		result.stderr ||
		(malformed
			? "the report held a malformed record"
			: payloadState.reportsError
				? "the report carried an error"
				: `exit code ${result.exitCode ?? "unknown"}`);
	return failedAudit(source, reason, diagnostics);
};

export const runNpmAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	const manifest = readRuntimeDependencies(rootDir);
	try {
		const result = await runPackageManagerAudit("npm", rootDir, timeout);
		return parsePackageManagerAuditResult(result, "npm audit", manifest);
	} catch (error) {
		return timedOutAudit(error, "npm audit", (stdout) =>
			parseJsAudit(stdout, "npm audit", manifest),
		);
	}
};

export const runBunAudit = async (rootDir: string, timeout: number): Promise<AuditOutcome> => {
	try {
		const result = await runSubprocess("bun", ["audit", "--json"], {
			cwd: rootDir,
			timeout,
		});
		// bun audit exits 1 when it finds vulnerabilities and when it cannot read the
		// registry response, and 0 when none remain (https://bun.sh/docs/pm/cli/audit), so
		// only a package map of advisory arrays with an agreeing exit code is an audit.
		const diagnostics = parseBunAudit(result.stdout);
		if (isBunReport(result.stdout) && exitedAsAuditTool(result.exitCode, diagnostics.length > 0)) {
			return { diagnostics, completed: true };
		}
		return failedAudit(
			"bun audit",
			result.stderr || result.stdout || `exit code ${result.exitCode ?? "unknown"}`,
			diagnostics,
		);
	} catch (error) {
		return timedOutAudit(error, "bun audit", parseBunAudit);
	}
};

export const runPnpmAuditWithFallback = async (
	rootDir: string,
	timeout: number,
): Promise<AuditOutcome> => {
	const canFallbackToNpm = fs.existsSync(path.join(rootDir, "package-lock.json"));
	const manifest = readRuntimeDependencies(rootDir);
	let outcome: AuditOutcome;
	try {
		const result = await runPackageManagerAudit("pnpm", rootDir, timeout);
		outcome = parsePackageManagerAuditResult(result, "pnpm audit", manifest);
	} catch (error) {
		outcome = timedOutAudit(error, "pnpm audit", (stdout) =>
			parseJsAudit(stdout, "pnpm audit", manifest),
		);
	}
	if (outcome.completed || !canFallbackToNpm) return outcome;
	return mergeFallbackOutcome(outcome, await runNpmAudit(rootDir, timeout));
};
