import path from "node:path";
import picomatch from "picomatch";
import type { Diagnostic } from "../engines/types.js";
import { createGlobMatcher } from "./globs.js";
import { projectRelativePosix } from "./paths.js";

// picomatch compiles every pattern it is handed, so an unbounded user entry is
// wasted work; oversized entries are dropped instead of expanded.
export const MAX_GLOB_PATTERN_LENGTH = 256;

export const supportedGlobPatterns = (patterns: string[]): string[] =>
	patterns.filter((pattern) => pattern.length <= MAX_GLOB_PATTERN_LENGTH);

// Expand user-facing exclude entries into picomatch globs. A bare path
// ("external/VendorLib", ".claude") matches both the entry itself and everything
// under it; anything already glob-shaped ("**/*.generated.cs") is kept verbatim.
// A leading "./" and trailing slashes are cosmetic and stripped first.
// This is the single normalization the file-scanning path and the diagnostic
// post-filter share, so both honor the exclude list identically.
export const normalizeExcludePatterns = (patterns: string[]): string[] =>
	patterns.flatMap((pattern) => {
		const trimmed = pattern.trim();
		const withoutProjectPrefix = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
		let end = withoutProjectPrefix.length;
		while (end > 0 && withoutProjectPrefix[end - 1] === "/") end -= 1;
		const normalized = withoutProjectPrefix.slice(0, end);
		if (normalized.length === 0) return [];
		if (normalized.length > MAX_GLOB_PATTERN_LENGTH) return [];
		if (picomatch.scan(normalized).isGlob) return [normalized];
		// A bare dot-prefixed name (".claude") is a dotfile or dot-directory
		// anywhere in the tree, not an extension. Excluding by extension needs an
		// unambiguous glob ("**/*.cs"), which the branch above passes through.
		if (normalized.startsWith(".") && !normalized.includes("/")) {
			return supportedGlobPatterns([`**/${normalized}`, `**/${normalized}/**`]);
		}
		return supportedGlobPatterns([normalized, `${normalized}/**`]);
	});

export const isPathExcluded = (relativePath: string, normalizedPatterns: string[]): boolean => {
	if (normalizedPatterns.length === 0) return false;
	return createGlobMatcher(normalizedPatterns, { dot: true })(relativePath);
};

// Drop diagnostics whose file lies under a user-excluded path. The build-backed
// C# engines (dotnet format, roslynator, jb inspectcode) shell out to tools that
// scan whole projects or solutions and cannot honor aislop's exclude list
// themselves; a root .sln pulls in every member project regardless. Filtering
// their output here - the single place
// every engine's diagnostics pass through - keeps them consistent with the
// file-scanning engines, which already start from the excluded file list.
export const filterExcludedDiagnostics = (
	diagnostics: Diagnostic[],
	rootDirectory: string,
	excludePatterns: string[] | undefined,
): Diagnostic[] => {
	if (!excludePatterns || excludePatterns.length === 0) return diagnostics;
	const normalized = normalizeExcludePatterns(excludePatterns);
	if (normalized.length === 0) return diagnostics;
	return diagnostics.filter((diagnostic) => {
		// Build-backed reports can retain ./ or parent segments in relative paths.
		// Match their lexical destination, not the analyzer's spelling of that path.
		const relativePath = path.posix.normalize(
			projectRelativePosix(rootDirectory, diagnostic.filePath.replace(/\\/g, "/")),
		);
		return !isPathExcluded(relativePath, normalized);
	});
};
