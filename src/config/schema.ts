import { z } from "zod/v4";
import { formatConfigValue } from "./format-value.js";

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
	smoothing: z.number().nonnegative().default(5),
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
		smoothing: 5,
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

const mergeScoringWeightDefaults = (configuration: AislopConfig): AislopConfig => ({
	...configuration,
	scoring: {
		...configuration.scoring,
		weights: { ...DEFAULT_WEIGHTS, ...configuration.scoring.weights },
	},
});

interface ValidationIssue {
	readonly message: string;
	readonly path: PropertyKey[];
}

const valueAtPath = (input: unknown, issuePath: readonly PropertyKey[]): unknown => {
	let value = input;
	for (const segment of issuePath) {
		if (!value || typeof value !== "object") return undefined;
		value = (value as Record<PropertyKey, unknown>)[segment];
	}
	return value;
};

const reportValidationIssues = (input: unknown, issues: readonly ValidationIssue[]): void => {
	for (const issue of issues) {
		const fieldPath = issue.path.join(".") || "(root)";
		const rejectedValue = formatConfigValue(valueAtPath(input, issue.path));
		process.stderr.write(
			`  ⚠ Invalid aislop configuration field ${fieldPath} = ${rejectedValue}: ${issue.message}\n`,
		);
	}
};

interface RemovalResult {
	readonly input: unknown;
	readonly removed: boolean;
}

const removeValueAtPath = (input: unknown, issuePath: readonly PropertyKey[]): RemovalResult => {
	const [segment, ...remainingPath] = issuePath;
	if (segment === undefined || !input || typeof input !== "object") {
		return { input, removed: false };
	}

	if (Array.isArray(input)) {
		if (typeof segment !== "number" || segment < 0 || segment >= input.length) {
			return { input, removed: false };
		}
		const copy = [...input];
		if (remainingPath.length === 0) {
			copy.splice(segment, 1);
			return { input: copy, removed: true };
		}
		const childResult = removeValueAtPath(copy[segment], remainingPath);
		if (!childResult.removed) return { input, removed: false };
		copy[segment] = childResult.input;
		return { input: copy, removed: true };
	}

	const record = input as Record<PropertyKey, unknown>;
	if (!Object.hasOwn(record, segment)) return { input, removed: false };
	const copy = { ...record };
	if (remainingPath.length === 0) {
		delete copy[segment];
		return { input: copy, removed: true };
	}
	const childResult = removeValueAtPath(copy[segment], remainingPath);
	if (!childResult.removed) return { input, removed: false };
	copy[segment] = childResult.input;
	return { input: copy, removed: true };
};

const orderPathsForRemoval = (left: ValidationIssue, right: ValidationIssue): number => {
	const leftParent = left.path.slice(0, -1);
	const rightParent = right.path.slice(0, -1);
	const sameParent =
		leftParent.length === rightParent.length &&
		leftParent.every((segment, index) => segment === rightParent[index]);
	const leftLast = left.path.at(-1);
	const rightLast = right.path.at(-1);
	if (sameParent && typeof leftLast === "number" && typeof rightLast === "number") {
		return rightLast - leftLast;
	}
	return right.path.length - left.path.length;
};

export const parseConfig = (raw: unknown): AislopConfig => {
	if (!raw || typeof raw !== "object") return defaults;

	let input: unknown = Array.isArray(raw) ? [...raw] : { ...(raw as Record<string, unknown>) };
	while (true) {
		const result = AislopConfigSchema.safeParse(input);
		if (result.success) return mergeScoringWeightDefaults(result.data);

		reportValidationIssues(input, result.error.issues);
		if (result.error.issues.some((issue) => issue.path.length === 0)) {
			process.stderr.write("  ⚠ Using default configuration.\n");
			return defaults;
		}

		let removedAny = false;
		for (const issue of [...result.error.issues].sort(orderPathsForRemoval)) {
			const removal = removeValueAtPath(input, issue.path);
			input = removal.input;
			removedAny ||= removal.removed;
		}
		if (!removedAny) {
			process.stderr.write("  ⚠ Using default configuration.\n");
			return defaults;
		}
	}
};
