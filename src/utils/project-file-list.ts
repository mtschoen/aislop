import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_BUFFER = 50 * 1024 * 1024;

const normalizePruneDirectories = (directories: Set<string>): Set<string> =>
	new Set([...directories].map((directory) => directory.toLowerCase()));

const isInPrunedDirectory = (filePath: string, pruneDirectories: Set<string>): boolean => {
	const pathSegments = filePath.split("/");
	pathSegments.pop();
	return pathSegments.some((segment) => pruneDirectories.has(segment.toLowerCase()));
};

// Walks the disk directly rather than asking git, so it is the only walker this module
// offers outside a git repository (enumerateProjectFiles falls back to it when git is
// unavailable) and the only one hook-safe callers may use, since hook scans must never
// spawn a subprocess other than git (see tests/hooks/scoped-scan.test.ts). It prunes a
// fixed set of directory names plus any directory holding its own ".git" entry (file or
// directory, any contents), which marks a nested checkout the same way a submodule or a
// linked worktree does; the scan root itself is always entered, since it is expected to
// hold the project's own ".git". It deliberately does not read ".gitignore": git's own
// snapshot (`git ls-files`, in enumerateProjectFiles) is the gitignore implementation, and
// reconstructing gitignore semantics from pure filesystem state without git is an
// open-ended surface rather than a closed one (see AGENTS.md "Rule design: state a closed
// decision surface").
export const enumerateProjectFilesFromDisk = (
	rootDirectory: string,
	pruneDirectories: Set<string>,
): string[] => {
	const files: string[] = [];
	const normalizedPruneDirectories = normalizePruneDirectories(pruneDirectories);
	const walk = (directory: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				let stats: fs.Stats;
				try {
					stats = fs.lstatSync(fullPath);
				} catch {
					continue;
				}
				if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
				if (normalizedPruneDirectories.has(entry.name.toLowerCase())) continue;
				if (fs.existsSync(path.join(fullPath, ".git"))) continue;
				walk(fullPath);
			} else if (entry.isFile()) {
				files.push(path.relative(rootDirectory, fullPath).split(path.sep).join("/"));
			}
		}
	};
	walk(rootDirectory);
	return files;
};

export const enumerateProjectFiles = (
	rootDirectory: string,
	pruneDirectories: Set<string>,
): string[] => {
	const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
		cwd: rootDirectory,
		encoding: "utf-8",
		maxBuffer: MAX_BUFFER,
	});

	if (!result.error && result.status === 0) {
		const normalizedPruneDirectories = normalizePruneDirectories(pruneDirectories);
		return result.stdout
			.split("\n")
			.filter((file) => file.length > 0)
			.filter((file) => !isInPrunedDirectory(file, normalizedPruneDirectories))
			.filter((file) => fs.existsSync(path.resolve(rootDirectory, file)));
	}

	return enumerateProjectFilesFromDisk(rootDirectory, pruneDirectories);
};
