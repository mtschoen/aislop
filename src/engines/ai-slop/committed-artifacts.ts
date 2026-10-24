import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isPathExcluded, normalizeExcludePatterns } from "../../utils/exclude.js";
import {
	isSafeRegularProjectFile,
	isWithinProject,
	toProjectPath,
} from "../../utils/source-file-policy.js";
import { isPathIncluded, normalizeIncludePatterns } from "../../utils/source-file-selection.js";
import { truncateFailureDetail } from "../../utils/subprocess.js";
import type { Diagnostic, EngineContext, EngineFailure } from "../types.js";

const TOOL_OUTPUT_RULE = "ai-slop/committed-tool-output";
const LARGE_FILE_RULE = "ai-slop/committed-large-file";
const DEFAULT_MAXIMUM_TRACKED_FILE_BYTES = 524288;
const BYTES_PER_KIBIBYTE = 1024;
const GIT_LISTING_BUFFER_BYTES = 256 * 1024 * 1024;

/** Fixed spellings, matched case-insensitively against the end of the basename. */
const TOOL_OUTPUT_SUFFIXES = [
	".log",
	".trx",
	".sarif",
	".stdout.txt",
	".stderr.txt",
	".tar.gz",
	".tgz",
	".tar",
	".zip",
	".7z",
];

/** Lockfiles are large by nature and are spared by exact basename. */
const LOCKFILE_BASENAMES = new Set([
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"Cargo.lock",
	"go.sum",
	"Gemfile.lock",
	"composer.lock",
	"packages.lock.json",
	"flake.lock",
	"mix.lock",
	"pubspec.lock",
	"Podfile.lock",
]);

const HELP =
	"Put counts and the reproduction command in the PR body or a short doc, or attach a CI artifact; do not commit raw output.";

export interface CommittedArtifactsRunResult {
	diagnostics: Diagnostic[];
	missingTools: string[];
	failures: EngineFailure[];
}

type TrackedFileInventory =
	| { kind: "listed"; files: string[] }
	| { kind: "not-a-repository" }
	| { kind: "missing-git" }
	| { kind: "failed"; reason: string };

const hasRepositoryAncestor = (rootDirectory: string): boolean => {
	let current = path.resolve(rootDirectory);
	for (;;) {
		if (fs.existsSync(path.join(current, ".git"))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
};

const isNonRepositoryStderr = (stderr: string): boolean => /not a git repository/i.test(stderr);

const isMissingExecutableError = (error: Error | undefined): boolean => {
	if (!error) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "EACCES";
};

/**
 * Paths git tracks (index entries) under the root. Distinguishes a directory
 * outside any repository from a missing git binary or an operational failure.
 * Reads no global configuration beyond what `ls-files --cached` itself needs.
 */
const listTrackedFiles = (rootDirectory: string): TrackedFileInventory => {
	const result = spawnSync("git", ["ls-files", "--cached", "-z"], {
		cwd: rootDirectory,
		encoding: "utf-8",
		maxBuffer: GIT_LISTING_BUFFER_BYTES,
		windowsHide: true,
	});
	if (result.error) {
		if (isMissingExecutableError(result.error)) {
			return { kind: "missing-git" };
		}
		return { kind: "failed", reason: truncateFailureDetail(result.error.message) };
	}
	if (result.status !== 0 || typeof result.stdout !== "string") {
		const stderr = typeof result.stderr === "string" ? result.stderr : "";
		if (isNonRepositoryStderr(stderr) && !hasRepositoryAncestor(rootDirectory)) {
			return { kind: "not-a-repository" };
		}
		const detail = truncateFailureDetail(
			stderr ||
				(typeof result.stdout === "string" ? result.stdout : "") ||
				`exit code ${result.status ?? "unknown"}`,
		);
		return { kind: "failed", reason: detail };
	}
	return {
		kind: "listed",
		files: [...new Set(result.stdout.split("\0").filter((entry) => entry.length > 0))],
	};
};

const isToolOutputName = (relativePath: string): boolean => {
	const lowered = path.posix.basename(relativePath).toLowerCase();
	return TOOL_OUTPUT_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
};

const makeDiagnostic = (relativePath: string, rule: string, message: string): Diagnostic => ({
	filePath: relativePath,
	engine: "ai-slop",
	rule,
	severity: "warning",
	message,
	help: HELP,
	line: 1,
	column: 1,
	category: "AI Slop",
	fixable: false,
});

const readByteSize = (absolutePath: string): number | undefined => {
	try {
		const stats = fs.lstatSync(absolutePath);
		return stats.isFile() ? stats.size : undefined;
	} catch {
		return undefined;
	}
};

/** Git's own heuristic: a file is binary when its first 8000 bytes hold a NUL byte. */
const BINARY_PROBE_BYTES = 8000;

const looksBinary = (absolutePath: string): boolean => {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(absolutePath, "r");
		const probe = Buffer.alloc(BINARY_PROBE_BYTES);
		const bytesRead = fs.readSync(descriptor, probe, 0, BINARY_PROBE_BYTES, 0);
		return probe.subarray(0, bytesRead).includes(0);
	} catch {
		return true;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
};

const SCOPE_DISCOVERY_FAILURE = Symbol.for("aislop.scopeDiscoveryFailure");

interface ScopedCandidateArray extends Array<string> {
	[SCOPE_DISCOVERY_FAILURE]?: string;
}

const readScopeDiscoveryFailure = (context: EngineContext): string | undefined => {
	if (context.trackedArtifactFiles === undefined) return undefined;
	const candidates: ScopedCandidateArray = context.trackedArtifactFiles;
	return candidates[SCOPE_DISCOVERY_FAILURE];
};

const resolveScopedCandidateSet = (context: EngineContext): Set<string> | null => {
	if (context.trackedArtifactFiles === undefined) return null;
	const selected = new Set<string>();
	for (const candidate of context.trackedArtifactFiles) {
		const relativePath = toProjectPath(context.rootDirectory, candidate);
		if (isWithinProject(relativePath)) selected.add(relativePath);
	}
	return selected;
};

export const inspectCommittedArtifacts = async (
	context: EngineContext,
): Promise<CommittedArtifactsRunResult> => {
	const scopeFailure = readScopeDiscoveryFailure(context);
	const inventory = listTrackedFiles(context.rootDirectory);
	if (inventory.kind === "not-a-repository") {
		return { diagnostics: [], missingTools: [], failures: [] };
	}
	if (inventory.kind === "missing-git") {
		return { diagnostics: [], missingTools: ["git"], failures: [] };
	}
	if (inventory.kind === "failed" || scopeFailure !== undefined) {
		const reason =
			inventory.kind === "failed" ? inventory.reason : truncateFailureDetail(scopeFailure ?? "");
		return {
			diagnostics: [],
			missingTools: [],
			failures: [{ tool: "git ls-files", target: ".", reason }],
		};
	}

	const scopedCandidates = resolveScopedCandidateSet(context);
	if (scopedCandidates !== null && scopedCandidates.size === 0) {
		return { diagnostics: [], missingTools: [], failures: [] };
	}

	const excludePatterns = normalizeExcludePatterns(context.excludePatterns ?? []);
	const includePatterns = normalizeIncludePatterns(context.includePatterns ?? []);
	const ceiling = context.config.quality.maxTrackedFileBytes ?? DEFAULT_MAXIMUM_TRACKED_FILE_BYTES;
	const diagnostics: Diagnostic[] = [];

	for (const relativePath of inventory.files) {
		if (!isWithinProject(relativePath)) continue;
		if (scopedCandidates !== null && !scopedCandidates.has(relativePath)) continue;
		if (!isPathIncluded(relativePath, includePatterns)) continue;
		if (isPathExcluded(relativePath, excludePatterns)) continue;
		const absolutePath = path.join(context.rootDirectory, relativePath);
		if (!isSafeRegularProjectFile(context.rootDirectory, absolutePath)) continue;
		const basename = path.posix.basename(relativePath);

		if (isToolOutputName(relativePath)) {
			diagnostics.push(
				makeDiagnostic(
					relativePath,
					TOOL_OUTPUT_RULE,
					`Committed tool output: ${basename} is raw tool output checked into the repository`,
				),
			);
			continue;
		}

		if (LOCKFILE_BASENAMES.has(basename)) continue;
		const size = readByteSize(absolutePath);
		if (size === undefined || size <= ceiling) continue;
		if (looksBinary(absolutePath)) continue;
		diagnostics.push(
			makeDiagnostic(
				relativePath,
				LARGE_FILE_RULE,
				`Oversized tracked file: ${basename} is ${Math.round(size / BYTES_PER_KIBIBYTE)} KiB, above the ${Math.round(ceiling / BYTES_PER_KIBIBYTE)} KiB ceiling (quality.maxTrackedFileBytes)`,
			),
		);
	}

	return { diagnostics, missingTools: [], failures: [] };
};

export const detectCommittedArtifacts = async (context: EngineContext): Promise<Diagnostic[]> =>
	(await inspectCommittedArtifacts(context)).diagnostics;
