import type { AislopConfig } from "../config/schema.js";
import type { Framework, Language } from "../utils/discover.js";

export type Severity = "error" | "warning" | "info";

export type EngineName =
	| "format"
	| "lint"
	| "code-quality"
	| "ai-slop"
	| "architecture"
	| "security";

export type ChangeContext = "changed-line" | "existing-file-context" | "unknown";

// One advisory behind a vulnerable-dependency finding, as the audit source names it.
export interface DependencyAdvisory {
	id: string;
	aliases?: string[];
}

export interface Diagnostic {
	filePath: string;
	engine: EngineName;
	rule: string;
	severity: Severity;
	message: string;
	help: string;
	line: number;
	column: number;
	category: string;
	fixable: boolean;
	detail?: string;
	changeContext?: ChangeContext;
	baselined?: boolean;
	packageName?: string;
	advisories?: DependencyAdvisory[];
}

export interface EngineFailure {
	tool: string;
	target: string;
	reason: string;
}

type AnalyzerExecutionStatus = "ran" | "failed" | "not-selected";

/**
 * Machine-readable record of one C# build-backed pass (jb inspectcode or
 * roslynator). Produced for successful runs and for passes that never ran, so a
 * consumer can tell a clean zero from a skipped or failed pass.
 */
export interface AnalyzerExecution {
	tool: "jb inspectcode" | "roslynator";
	status: AnalyzerExecutionStatus;
	/** Why the pass failed or was not selected; absent for status "ran". */
	reason?: string;
	/** Repository-relative targets handed to the tool. */
	targets: string[];
	/** Repository-relative project paths the tool analyzed. */
	analyzedProjects: string[];
	/** Repository-relative project paths dropped by a user exclude; never analyzed. */
	excludedProjects: string[];
	/** Wall-clock milliseconds the pass took (0 when not selected). */
	elapsed: number;
}

export interface AnalyzerRunResult {
	diagnostics: Diagnostic[];
	failures: EngineFailure[];
	executions?: AnalyzerExecution[];
}

export interface EngineResult {
	engine: EngineName;
	diagnostics: Diagnostic[];
	elapsed: number;
	skipped: boolean;
	skipReason?: string;
	missingTools?: string[];
	failed?: boolean;
	failures?: EngineFailure[];
	executions?: AnalyzerExecution[];
}

export interface EngineContext {
	rootDirectory: string;
	languages: Language[];
	frameworks: Framework[];
	readonly dependencyAuditFiles?: string[];
	readonly dependencyAuditLanguages?: Language[];
	readonly dependencyAuditScope?: "full" | "files";
	files?: string[];
	testFiles?: string[];
	projectFiles?: string[];
	// Raw user exclude entries (config `exclude` + `.aislopignore`). The
	// file-scanning engines already start from the excluded file list; this lets
	// the build-backed C# engines - which shell out to tools that scan whole
	// projects - honor the same excludes via a shared diagnostic post-filter.
	excludePatterns?: string[];
	installedTools: Record<string, boolean>;
	config: EngineConfig;
}

export interface EngineConfig {
	readonly overrides?: AislopConfig["overrides"];
	readonly rules?: AislopConfig["rules"];
	readonly imports?: AislopConfig["imports"];
	quality: {
		maxFunctionLoc: number;
		maxFileLoc: number;
		maxNesting: number;
		maxParams: number;
		repeatedLiteralThreshold?: number;
	};
	security: {
		audit: boolean;
		auditTimeout: number;
		acceptedAdvisories?: AislopConfig["security"]["acceptedAdvisories"];
	};
	aiSlop?: {
		hardcodedUserPath?: {
			bannedRoots: string[];
		};
	};
	lint: {
		typecheck: boolean;
		expoDoctor: boolean;
		csharp?: {
			projectEvaluation?: boolean;
			jb: boolean;
			roslynator: boolean;
			jbSeverityFloor: "ERROR" | "WARNING" | "SUGGESTION" | "HINT";
			jbExcludeTypes: string[];
			jbProjects?: string;
		};
		cpp?: {
			cppcheck: boolean;
			clangTidy: boolean;
			cppcheckEnable: string;
			jb: boolean;
			jbProjects?: string;
			jbSeverityFloor: "ERROR" | "WARNING" | "SUGGESTION" | "HINT";
			jbExcludeTypes: string[];
		};
	};
	allowProjectLocalTools?: boolean;
	architectureRulesPath?: string;
}

export interface Engine {
	name: EngineName;
	run(context: EngineContext): Promise<EngineResult>;
}
