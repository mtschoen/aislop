import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config/index.js";
import { runEngines } from "../../engines/orchestrator.js";
import type { Diagnostic, EngineContext, EngineName } from "../../engines/types.js";
import { calculateScore } from "../../scoring/index.js";
import { discoverProject } from "../../utils/discover.js";
import { toPosix } from "../../utils/paths.js";
import { atomicWrite, readIfExists } from "../io/atomic-write.js";
import { hookStateDir } from "../io/state-dir.js";

interface Baseline {
	schema: "aislop.baseline.v2";
	pathFormat?: "posix";
	updatedAt: string;
	score: number;
	byEngine: Record<string, number>;
	fileCount: number;
	commit?: string;
	findingFingerprints: string[];
}

const fingerprintDiagnostic = (d: Diagnostic, rootDirectory: string): string => {
	const rel = toPosix(
		path.isAbsolute(d.filePath) ? path.relative(rootDirectory, d.filePath) : d.filePath,
	);
	return `${rel}:${d.line}:${d.rule}`;
};

// Markerless baselines captured on Windows may contain native separators. On POSIX,
// preserve a backslash only when the fingerprint resolves to an existing literal filename.
// This lets copied Windows baselines migrate without corrupting real POSIX paths.
const normalizeLegacyFingerprint = (fingerprint: string): string => fingerprint.replace(/\\/g, "/");

const hasExistingLiteralBackslashPath = (cwd: string, fingerprint: string): boolean => {
	if (process.platform === "win32") return false;
	const match = fingerprint.match(/^(.*):\d+:[^:]+$/);
	const fingerprintPath = match?.[1];
	if (!fingerprintPath?.includes("\\")) return false;
	try {
		const absolutePath = path.resolve(cwd, fingerprintPath);
		const stats = fs.lstatSync(absolutePath);
		if (!stats.isFile() || stats.isSymbolicLink()) return false;
		const realRoot = fs.realpathSync(cwd);
		const realPath = fs.realpathSync(absolutePath);
		const relativePath = path.relative(realRoot, realPath);
		return (
			!path.isAbsolute(relativePath) &&
			relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`)
		);
	} catch {
		return false;
	}
};

const migrateMarkerlessFingerprint = (cwd: string, fingerprint: string): string =>
	hasExistingLiteralBackslashPath(cwd, fingerprint)
		? fingerprint
		: normalizeLegacyFingerprint(fingerprint);

export const baselinePath = (cwd: string): string => path.join(hookStateDir(cwd), "baseline.json");

// Baselines captured before hook state moved out of the repo live at
// <repo>/.aislop/baseline.json. Read them as a fallback so the upgrade does
// not make every existing finding look new; never write there again.
const legacyBaselinePath = (cwd: string): string => path.join(cwd, ".aislop", "baseline.json");

export const readBaseline = (cwd: string): Baseline | null => {
	const raw = readIfExists(baselinePath(cwd)) ?? readIfExists(legacyBaselinePath(cwd));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Baseline> & { schema?: string };
		// Accept both schemas. v1 lacks findingFingerprints - return [] so callers
		// can still compute newSinceBaseline (it'll be empty until the next capture).
		if (parsed.schema !== "aislop.baseline.v2" && parsed.schema !== "aislop.baseline.v1") {
			return null;
		}
		const findingFingerprints = parsed.findingFingerprints ?? [];
		const needsWindowsMigration = parsed.pathFormat !== "posix";
		return {
			schema: "aislop.baseline.v2",
			pathFormat: "posix",
			updatedAt: parsed.updatedAt ?? "",
			score: parsed.score ?? 0,
			byEngine: parsed.byEngine ?? {},
			fileCount: parsed.fileCount ?? 0,
			commit: parsed.commit,
			findingFingerprints: needsWindowsMigration
				? findingFingerprints.map((fingerprint) => migrateMarkerlessFingerprint(cwd, fingerprint))
				: findingFingerprints,
		};
	} catch {
		return null;
	}
};

export const writeBaseline = (cwd: string, baseline: Baseline): string => {
	const target = baselinePath(cwd);
	atomicWrite(target, `${JSON.stringify({ ...baseline, pathFormat: "posix" }, null, 2)}\n`);
	return target;
};

export const captureBaseline = async (
	cwd: string,
): Promise<{ score: number; fileCount: number; path: string }> => {
	const project = await discoverProject(cwd);
	const config = loadConfig(cwd);
	const context: EngineContext = {
		rootDirectory: project.rootDirectory,
		languages: project.languages,
		frameworks: project.frameworks,
		files: [],
		installedTools: project.installedTools,
		config: {
			quality: config.quality,
			security: { audit: false, auditTimeout: 0 },
			lint: { typecheck: false, expoDoctor: false },
			aiSlop: config.aiSlop,
			allowProjectLocalTools: false,
		},
	};
	const enabled: Record<EngineName, boolean> = {
		format: false,
		lint: false,
		"code-quality": config.engines["code-quality"],
		"ai-slop": config.engines["ai-slop"],
		architecture: config.engines.architecture,
		security: false,
	};
	const results = await runEngines(context, enabled);
	const diagnostics = results.flatMap((r) => r.diagnostics);
	const { score } = calculateScore(
		diagnostics,
		config.scoring.weights,
		config.scoring.thresholds,
		project.sourceFileCount,
		config.scoring.smoothing,
		config.scoring.maxPerRule,
	);
	const byEngine: Record<string, number> = {};
	for (const r of results) {
		const engineDiags = diagnostics.filter((d) => r.diagnostics.includes(d));
		const { score: engineScore } = calculateScore(
			engineDiags,
			config.scoring.weights,
			config.scoring.thresholds,
			project.sourceFileCount,
			config.scoring.smoothing,
			config.scoring.maxPerRule,
		);
		byEngine[r.engine] = engineScore;
	}
	const findingFingerprints = diagnostics
		.filter((d) => d.severity === "error" || d.severity === "warning")
		.map((d) => fingerprintDiagnostic(d, project.rootDirectory));
	const baseline: Baseline = {
		schema: "aislop.baseline.v2",
		pathFormat: "posix",
		updatedAt: new Date().toISOString(),
		score,
		byEngine,
		fileCount: project.sourceFileCount,
		findingFingerprints,
	};
	const target = writeBaseline(cwd, baseline);
	return { score, fileCount: project.sourceFileCount, path: target };
};

const sessionPath = (cwd: string): string => path.join(hookStateDir(cwd), "session.jsonl");

// Session logs written before hook state moved out of the repo.
const legacySessionPath = (cwd: string): string => path.join(cwd, ".aislop", "session.jsonl");

export const appendSessionFiles = (cwd: string, files: string[]): void => {
	if (files.length === 0) return;
	const target = sessionPath(cwd);
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const line = `${JSON.stringify({ ts: Date.now(), files })}\n`;
		fs.appendFileSync(target, line);
	} catch {
		// best-effort; quality gate is non-critical
	}
};

export const readSessionFiles = (cwd: string): string[] => {
	const files = new Set<string>();
	for (const contents of [readIfExists(sessionPath(cwd)), readIfExists(legacySessionPath(cwd))]) {
		if (!contents) continue;
		for (const line of contents.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { files?: string[] };
				for (const f of entry.files ?? []) files.add(f);
			} catch {
				// skip malformed line
			}
		}
	}
	return Array.from(files);
};

export const clearSessionFiles = (cwd: string): void => {
	// Clears the legacy in-repo log too: it is this tool's own artifact, and
	// leaving it behind would feed stale entries to the fallback read forever.
	for (const target of [sessionPath(cwd), legacySessionPath(cwd)]) {
		try {
			fs.unlinkSync(target);
		} catch {
			// already gone
		}
	}
};
