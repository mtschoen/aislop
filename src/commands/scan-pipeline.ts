import path from "node:path";
import { type AislopConfig, findConfigDir, RULES_FILE } from "../config/index.js";
import { shouldRunDependencyAudit } from "../engines/security/audit.js";
import type { EngineConfig, EngineResult } from "../engines/types.js";
import { applyRuleSeverities } from "../scoring/rule-severity.js";
import {
	detectManifestLanguages,
	detectSourceLanguages,
	discoverProject,
	type Language,
} from "../utils/discover.js";
import { resetGitIgnoreSnapshots } from "../utils/git-ignore.js";
import { readAislopIgnorePatterns } from "../utils/source-files.js";
import { applySuppressions } from "../utils/suppress.js";
import { runEnginesWithProgress } from "./scan-engine-runner.js";
import { collectScanFileScope, type ScanFileScope, type ScanScopeMode } from "./scan-file-scope.js";

export interface PreparedScan {
	resolvedDir: string;
	excludePatterns: string[];
	scanScope: ScanFileScope;
	projectInfo: Awaited<ReturnType<typeof discoverProject>>;
	dependencyAuditLanguages: Language[];
}

export const prepareScan = async (
	resolvedDir: string,
	config: AislopConfig,
	mode: ScanScopeMode,
): Promise<PreparedScan> => {
	const excludePatterns = [...config.exclude, ...readAislopIgnorePatterns(resolvedDir)];
	// Scope collection reads gitignore state before discoverProject refreshes it, and the
	// interactive loop keeps one process alive across scans - reset so this pass cannot
	// reuse a snapshot an earlier command left behind.
	resetGitIgnoreSnapshots();
	const scanScope = collectScanFileScope({
		excludePatterns,
		includePatterns: config.include,
		mode,
		rootDirectory: resolvedDir,
	});
	const discoveredProject = await discoverProject(resolvedDir, excludePatterns, {
		audit:
			config.security.audit &&
			config.engines.security !== false &&
			shouldRunDependencyAudit({ rootDirectory: resolvedDir, ...scanScope }),
		includePatterns: config.include,
		sourceFiles: scanScope.files,
	});
	const sourceLanguages = detectSourceLanguages([...scanScope.files, ...scanScope.testFiles]);
	return {
		resolvedDir,
		excludePatterns,
		scanScope,
		projectInfo: {
			...discoveredProject,
			languages: sourceLanguages.length > 0 ? sourceLanguages : discoveredProject.languages,
		},
		dependencyAuditLanguages: detectManifestLanguages(resolvedDir),
	};
};

export const runScanEngines = async (
	prepared: PreparedScan,
	config: AislopConfig,
	machineOutput: boolean,
): Promise<{ results: EngineResult[]; suppressedCount: number }> => {
	const { resolvedDir, scanScope, projectInfo } = prepared;
	const configDir = findConfigDir(resolvedDir);
	const rulesPath = configDir ? path.join(configDir, RULES_FILE) : undefined;
	const engineConfig: EngineConfig = {
		overrides: config.overrides,
		rules: config.rules,
		imports: config.imports,
		quality: config.quality,
		security: config.security,
		lint: config.lint,
		aiSlop: config.aiSlop,
		architectureRulesPath: config.engines.architecture ? rulesPath : undefined,
	};

	const rawResults = await runEnginesWithProgress(
		{
			rootDirectory: resolvedDir,
			languages: projectInfo.languages,
			frameworks: projectInfo.frameworks,
			dependencyAuditFiles: scanScope.dependencyAuditFiles,
			dependencyAuditLanguages: prepared.dependencyAuditLanguages,
			dependencyAuditScope: scanScope.dependencyAuditScope,
			files: scanScope.files,
			excludePatterns: prepared.excludePatterns,
			testFiles: scanScope.testFiles,
			projectFiles: scanScope.projectFiles,
			installedTools: projectInfo.installedTools,
			config: engineConfig,
		},
		config.engines,
		machineOutput,
	);

	const severityAdjusted = rawResults.map((result) => ({
		...result,
		diagnostics: config.overrides.length
			? result.diagnostics
			: applyRuleSeverities(result.diagnostics, config.rules),
	}));
	return applySuppressions(severityAdjusted, resolvedDir);
};
