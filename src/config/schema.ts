import { z } from "zod/v4";

const DEFAULT_WEIGHTS: Record<string, number> = {
	format: 0.3,
	lint: 0.6,
	"code-quality": 0.8,
	"ai-slop": 1.0,
	architecture: 1.0,
	security: 1.5,
};

const EnginesSchema = z.object({
	format: z.boolean().default(true),
	lint: z.boolean().default(true),
	"code-quality": z.boolean().default(true),
	"ai-slop": z.boolean().default(true),
	architecture: z.boolean().default(false),
	security: z.boolean().default(true),
});

const QualitySchema = z.object({
	maxFunctionLoc: z.number().positive().default(80),
	maxFileLoc: z.number().positive().default(400),
	maxNesting: z.number().positive().default(5),
	maxParams: z.number().positive().default(6),
});

const CsharpLintSchema = z.object({
	projectEvaluation: z.boolean().default(false),
	jb: z.boolean().default(true),
	roslynator: z.boolean().default(true),
	jbSeverityFloor: z.enum(["ERROR", "WARNING", "SUGGESTION", "HINT"]).default("WARNING"),
	jbExcludeTypes: z.array(z.string()).default(() => ["InconsistentNaming"]),
	jbProjects: z.string().optional(),
});

const CppLintSchema = z.object({
	cppcheck: z.boolean().default(true),
	clangTidy: z.boolean().default(true),
	cppcheckEnable: z.string().default("warning,performance,portability"),
	jb: z.boolean().default(false),
	jbProjects: z.string().optional(),
	jbSeverityFloor: z.enum(["ERROR", "WARNING", "SUGGESTION", "HINT"]).default("WARNING"),
	jbExcludeTypes: z.array(z.string()).default(() => []),
});

const LintConfigSchema = z.object({
	typecheck: z.boolean().default(false),
	/**
	 * Expo Doctor can evaluate Expo project configuration files. Keep it
	 * disabled by default so scans do not execute code from untrusted repos.
	 */
	expoDoctor: z.boolean().default(false),
	csharp: CsharpLintSchema.default(() => ({
		projectEvaluation: false,
		jb: true,
		roslynator: true,
		jbSeverityFloor: "WARNING" as const,
		jbExcludeTypes: ["InconsistentNaming"],
	})),
	cpp: CppLintSchema.default(() => ({
		cppcheck: true,
		clangTidy: true,
		cppcheckEnable: "warning,performance,portability",
		jb: false,
		jbSeverityFloor: "WARNING" as const,
		jbExcludeTypes: [],
	})),
});

const SecurityConfigSchema = z.object({
	audit: z.boolean().default(true),
	auditTimeout: z.number().positive().default(25000),
});

// Mirrors the drive-root and UNC-root detection in
// src/engines/ai-slop/hardcoded-user-path.ts. A root that is not absolute
// (a bare word, a relative path) builds a matcher with no path-boundary
// requirement, so it would flag ordinary identifiers instead of hardcoded
// machine paths.
const isAbsoluteBannedRoot = (value: string): boolean =>
	value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);

const BannedRootSchema = z.string().refine(isAbsoluteBannedRoot, {
	error: (issue) =>
		`must be an absolute path (POSIX "/...", a Windows drive root "C:\\..." or "C:/...", ` +
		`or a UNC root "\\\\server\\share..."), got ${JSON.stringify(issue.input)}`,
});

const HardcodedUserPathSchema = z.object({
	/**
	 * Extra home roots to treat as machine-bound, in addition to the runtime
	 * `os.homedir()` seed. Lets CI and teams flag paths bound to accounts other
	 * than the one running the scan (see docs/rules.md for the seeding rules).
	 * Must be absolute: a relative or bare entry would match ordinary
	 * identifiers, not just hardcoded paths.
	 */
	bannedRoots: z.array(BannedRootSchema).default(() => []),
});

const AiSlopConfigSchema = z.object({
	hardcodedUserPath: HardcodedUserPathSchema.default(() => ({ bannedRoots: [] })),
});

const ThresholdsSchema = z.object({
	good: z.number().default(75),
	ok: z.number().default(50),
});

const ScoringSchema = z.object({
	weights: z.record(z.string(), z.number()).default(DEFAULT_WEIGHTS),
	thresholds: ThresholdsSchema.default(() => ({
		good: 75,
		ok: 50,
	})),
	smoothing: z.number().nonnegative().default(20),
	maxPerRule: z.number().positive().default(40),
});

const CiSchema = z.object({
	failBelow: z.number().default(70),
	format: z.enum(["json"]).default("json"),
});

const TelemetrySchema = z.object({
	enabled: z.boolean().default(true),
});

const RuleSeverityOverride = z.enum(["error", "warning", "off"]);

const RulesSchema = z.record(z.string(), RuleSeverityOverride).default(() => ({}));

const AislopConfigSchema = z.object({
	version: z.number().default(1),
	engines: EnginesSchema.default(() => ({
		format: true,
		lint: true,
		"code-quality": true,
		"ai-slop": true,
		architecture: false,
		security: true,
	})),
	quality: QualitySchema.default(() => ({
		maxFunctionLoc: 80,
		maxFileLoc: 400,
		maxNesting: 5,
		maxParams: 6,
	})),
	lint: LintConfigSchema.default(() => ({
		typecheck: false,
		expoDoctor: false,
		csharp: {
			projectEvaluation: false,
			jb: true,
			roslynator: true,
			jbSeverityFloor: "WARNING" as const,
			jbExcludeTypes: ["InconsistentNaming"],
		},
		cpp: {
			cppcheck: true,
			clangTidy: true,
			cppcheckEnable: "warning,performance,portability",
			jb: false,
			jbSeverityFloor: "WARNING" as const,
			jbExcludeTypes: [],
		},
	})),
	security: SecurityConfigSchema.default(() => ({
		audit: true,
		auditTimeout: 25000,
	})),
	aiSlop: AiSlopConfigSchema.default(() => ({
		hardcodedUserPath: { bannedRoots: [] },
	})),
	scoring: ScoringSchema.default(() => ({
		weights: { ...DEFAULT_WEIGHTS },
		thresholds: {
			good: 75,
			ok: 50,
		},
		smoothing: 20,
		maxPerRule: 40,
	})),
	ci: CiSchema.default(() => ({
		failBelow: 70,
		format: "json" as const,
	})),
	telemetry: TelemetrySchema.default(() => ({
		enabled: true,
	})),
	rules: RulesSchema,
	exclude: z.array(z.string()).default(() => ["node_modules", ".git", "dist", "build", "coverage"]),
	include: z.array(z.string()).default(() => []),
});

export type RuleSeverity = z.infer<typeof RuleSeverityOverride>;

export { AislopConfigSchema };

export type AislopConfig = z.infer<typeof AislopConfigSchema>;

const defaults: AislopConfig = AislopConfigSchema.parse({});

/**
 * Pre-merge scoring weights so partial overrides extend the defaults
 * rather than replacing them entirely (z.record replaces by default).
 */
const preMergeWeights = (raw: Record<string, unknown>): void => {
	const scoring = raw.scoring as Record<string, unknown> | undefined;
	if (!scoring) return;

	const userWeights = scoring.weights as Record<string, number> | undefined;
	if (!userWeights || typeof userWeights !== "object") return;

	scoring.weights = { ...DEFAULT_WEIGHTS, ...userWeights };
};

/**
 * Renders a thrown validation error as a one-line, per-issue summary naming
 * the offending field and why it was rejected, rather than the raw
 * JSON-stringified issue array `ZodError#message` produces by default.
 */
const describeValidationError = (error: unknown): string => {
	if (error instanceof z.ZodError) {
		return error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
	}
	return error instanceof Error ? error.message : String(error);
};

export const parseConfig = (raw: unknown): AislopConfig => {
	if (!raw || typeof raw !== "object") return defaults;

	try {
		const input = raw as Record<string, unknown>;
		preMergeWeights(input);
		return AislopConfigSchema.parse(input);
	} catch (error) {
		// Validation failures fall back to defaults rather than crashing, but
		// the fallback must be visible: a silently discarded config (or, worse,
		// a silently discarded single field) reads as "it's configured" when it
		// is not. See docs/rules.md for the bannedRoots case this guards.
		process.stderr.write(
			`  ⚠ Invalid aislop configuration: ${describeValidationError(error)}\n` +
				`  ⚠ Using default configuration.\n`,
		);
		return defaults;
	}
};
