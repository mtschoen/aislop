import { z } from "zod/v4";
import { formatConfigValue } from "./format-value.js";
import { recoverFromIssues, type ValidationIssue, valueAtPath } from "./recovery.js";
import { emitConfigWarning } from "./warnings.js";

const DEFAULT_WEIGHTS: Record<string, number> = {
	format: 0.3,
	lint: 0.6,
	"code-quality": 0.8,
	"ai-slop": 1.0,
	architecture: 1.0,
	security: 1.5,
};
const DEFAULT_JB_SEVERITY_FLOOR = "WARNING" as const;

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
	repeatedLiteralThreshold: z.number().int().positive().default(3),
});

const CsharpLintSchema = z.object({
	projectEvaluation: z.boolean().default(false),
	jb: z.boolean().default(true),
	roslynator: z.boolean().default(true),
	jbSeverityFloor: z
		.enum(["ERROR", "WARNING", "SUGGESTION", "HINT"])
		.default(DEFAULT_JB_SEVERITY_FLOOR),
	jbExcludeTypes: z.array(z.string()).default(() => ["InconsistentNaming"]),
	jbProjects: z.string().optional(),
});

const CppLintSchema = z.object({
	cppcheck: z.boolean().default(true),
	clangTidy: z.boolean().default(true),
	cppcheckEnable: z.string().default("warning,performance,portability"),
	jb: z.boolean().default(false),
	jbProjects: z.string().optional(),
	jbSeverityFloor: z
		.enum(["ERROR", "WARNING", "SUGGESTION", "HINT"])
		.default(DEFAULT_JB_SEVERITY_FLOOR),
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
		jbSeverityFloor: DEFAULT_JB_SEVERITY_FLOOR,
		jbExcludeTypes: ["InconsistentNaming"],
	})),
	cpp: CppLintSchema.default(() => ({
		cppcheck: true,
		clangTidy: true,
		cppcheckEnable: "warning,performance,portability",
		jb: false,
		jbSeverityFloor: DEFAULT_JB_SEVERITY_FLOOR,
		jbExcludeTypes: [],
	})),
});

const isCalendarDate = (value: string): boolean => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
};

const ACCEPTED_ADVISORY_FIELDS = new Set(["id", "reason", "package", "expires"]);

const isFilledText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

// Returns what is wrong with an entry, or undefined when it may apply as written.
// A field that cannot be honored (a non-text `package`, an `expires` that is not a
// date, a misspelled key) fails the whole entry: dropping only that field would make
// the entry apply more broadly than what the user wrote.
const acceptedAdvisoryProblem = (entry: unknown): string | undefined => {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		return "must be a mapping with an id and a reason";
	}
	const fields = entry as Record<string, unknown>;
	const unknownField = Object.keys(fields).find((key) => !ACCEPTED_ADVISORY_FIELDS.has(key));
	if (unknownField !== undefined) return `has an unknown field ${JSON.stringify(unknownField)}`;
	if (!isFilledText(fields.id)) return "needs a non-empty id";
	if (!isFilledText(fields.reason)) return "needs a non-empty reason";
	if ("package" in fields && !isFilledText(fields.package)) {
		return "has a package that is not a non-empty text value";
	}
	if (
		"expires" in fields &&
		!(typeof fields.expires === "string" && isCalendarDate(fields.expires))
	) {
		return "has an expires that is not a calendar date written as a YYYY-MM-DD text value";
	}
	return undefined;
};

// The whole entry is checked in one step, ahead of the field schema, and reports at
// most one issue on the entry itself. An invalid accepted advisory (such as a missing
// required key or an invalid date) is ignored as a unit with a single diagnostic on
// the entry rather than stripping individual fields or leaving a partial entry behind.
const AcceptedAdvisorySchema = z.preprocess(
	(entry, context) => {
		const problem = acceptedAdvisoryProblem(entry);
		if (problem === undefined) return entry;
		context.issues.push({
			code: "custom",
			message: `an accepted advisory ${problem}; the entry is ignored`,
			input: entry,
		});
		return z.NEVER;
	},
	z.object({
		id: z.string(),
		reason: z.string(),
		package: z.string().optional(),
		expires: z.string().optional(),
	}),
);

const SecurityConfigSchema = z.object({
	audit: z.boolean().default(true),
	auditTimeout: z.number().positive().default(25000),
	/**
	 * Dependency-audit advisories the project has reviewed and accepted. A package
	 * finding stops costing score only when every advisory behind it is listed here.
	 */
	acceptedAdvisories: z.array(AcceptedAdvisorySchema).default(() => []),
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

const ImportsSchema = z.object({
	provided: z.array(z.string().min(1)).default(() => []),
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
	smoothing: z.number().nonnegative().default(5),
	maxPerRule: z.number().positive().default(40),
});

const CiSchema = z.object({
	failBelow: z.number().default(70),
	format: z.enum(["json"]).default("json"),
	failOnMissingTools: z.boolean().default(false),
	baseline: z.string().min(1).optional(),
});

const TelemetrySchema = z.object({
	enabled: z.boolean().default(true),
});

const RuleSeverityOverride = z.enum(["error", "warning", "off"]);

const RulesSchema = z.record(z.string(), RuleSeverityOverride).default(() => ({}));

const FileOverrideSchema = z.object({
	files: z.array(z.string().min(1)).min(1),
	quality: z
		.object({
			maxFunctionLoc: QualitySchema.shape.maxFunctionLoc.unwrap().optional(),
			maxFileLoc: QualitySchema.shape.maxFileLoc.unwrap().optional(),
			maxNesting: QualitySchema.shape.maxNesting.unwrap().optional(),
			maxParams: QualitySchema.shape.maxParams.unwrap().optional(),
		})
		.optional(),
	rules: z.record(z.string(), RuleSeverityOverride).optional(),
});

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
		repeatedLiteralThreshold: 3,
	})),
	lint: LintConfigSchema.default(() => ({
		typecheck: false,
		expoDoctor: false,
		csharp: {
			projectEvaluation: false,
			jb: true,
			roslynator: true,
			jbSeverityFloor: DEFAULT_JB_SEVERITY_FLOOR,
			jbExcludeTypes: ["InconsistentNaming"],
		},
		cpp: {
			cppcheck: true,
			clangTidy: true,
			cppcheckEnable: "warning,performance,portability",
			jb: false,
			jbSeverityFloor: DEFAULT_JB_SEVERITY_FLOOR,
			jbExcludeTypes: [],
		},
	})),
	security: SecurityConfigSchema.default(() => ({
		audit: true,
		auditTimeout: 25000,
		acceptedAdvisories: [],
	})),
	aiSlop: AiSlopConfigSchema.default(() => ({
		hardcodedUserPath: { bannedRoots: [] },
	})),
	imports: ImportsSchema.default(() => ({
		provided: [],
	})),
	scoring: ScoringSchema.default(() => ({
		weights: { ...DEFAULT_WEIGHTS },
		thresholds: {
			good: 75,
			ok: 50,
		},
		smoothing: 5,
		maxPerRule: 40,
	})),
	ci: CiSchema.default(() => ({
		failBelow: 70,
		format: "json" as const,
		failOnMissingTools: false,
	})),
	telemetry: TelemetrySchema.default(() => ({
		enabled: true,
	})),
	rules: RulesSchema,
	overrides: z.array(FileOverrideSchema).default(() => []),
	exclude: z.array(z.string()).default(() => ["node_modules", ".git", "dist", "build", "coverage"]),
	include: z.array(z.string()).default(() => []),
});

export type RuleSeverity = z.infer<typeof RuleSeverityOverride>;

export { AislopConfigSchema };

export type AislopConfig = z.infer<typeof AislopConfigSchema>;

const defaults: AislopConfig = AislopConfigSchema.parse({});

const mergeScoringWeightDefaults = (configuration: AislopConfig): AislopConfig => ({
	...configuration,
	scoring: {
		...configuration.scoring,
		weights: { ...DEFAULT_WEIGHTS, ...configuration.scoring.weights },
	},
});

export type RecoveryReporter = (description: string) => void;

const reportValidationIssues = (
	input: unknown,
	issues: readonly ValidationIssue[],
	onRecovery?: RecoveryReporter,
): void => {
	for (const issue of issues) {
		const fieldPath = issue.path.join(".") || "(root)";
		const rejectedValue = formatConfigValue(valueAtPath(input, issue.path));
		onRecovery?.(`invalid field ${fieldPath}: ${issue.message}`);
		emitConfigWarning(
			`  ⚠ Invalid aislop configuration field ${fieldPath} = ${rejectedValue}: ${issue.message}\n`,
		);
	}
};

export const parseConfig = (raw: unknown, onRecovery?: RecoveryReporter): AislopConfig => {
	if (!raw || typeof raw !== "object") return defaults;

	let input: unknown = Array.isArray(raw) ? [...raw] : { ...(raw as Record<string, unknown>) };
	while (true) {
		const result = AislopConfigSchema.safeParse(input);
		if (result.success) return mergeScoringWeightDefaults(result.data);

		reportValidationIssues(input, result.error.issues, onRecovery);
		if (result.error.issues.some((issue) => issue.path.length === 0)) {
			emitConfigWarning("  ⚠ Using default configuration.\n");
			return defaults;
		}

		const recovery = recoverFromIssues(input, result.error.issues);
		input = recovery.input;
		if (!recovery.removedAny) {
			emitConfigWarning("  ⚠ Using default configuration.\n");
			return defaults;
		}
	}
};
