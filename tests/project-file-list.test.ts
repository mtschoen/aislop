import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	enumerateProjectFiles,
	enumerateProjectFilesFromDisk,
} from "../src/utils/project-file-list.js";

const writeFile = (rootDirectory: string, relativePath: string): void => {
	const filePath = path.join(rootDirectory, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, "export {};\n", "utf-8");
};

const writeContent = (rootDirectory: string, relativePath: string, contents: string): void => {
	const filePath = path.join(rootDirectory, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, contents, "utf-8");
};

const isGitAvailable = (): boolean => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const gitAvailable = isGitAvailable();

describe("project file enumeration", () => {
	let rootDirectory: string;

	beforeEach(() => {
		rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-project-files-"));
	});

	afterEach(() => {
		fs.rmSync(rootDirectory, { recursive: true, force: true });
	});

	it("prunes tracked and untracked directories from git enumeration", () => {
		execFileSync("git", ["init"], { cwd: rootDirectory, stdio: "ignore" });
		writeFile(rootDirectory, "src/app.ts");
		writeFile(rootDirectory, "vendor/tracked.ts");
		writeFile(rootDirectory, "dist/untracked.js");
		execFileSync("git", ["add", "-f", "src/app.ts", "vendor/tracked.ts"], {
			cwd: rootDirectory,
			stdio: "ignore",
		});

		expect(enumerateProjectFiles(rootDirectory, new Set(["dist", "vendor"]))).toEqual([
			"src/app.ts",
		]);
	});

	it.skipIf(!gitAvailable)(
		"omits gitignored files and includes a force-tracked ignored file from git enumeration",
		() => {
			execFileSync("git", ["init"], { cwd: rootDirectory, stdio: "ignore" });
			writeContent(rootDirectory, ".gitignore", "*.ignored.ts\n");
			writeFile(rootDirectory, "src/app.ts");
			writeFile(rootDirectory, "plain.ignored.ts");
			writeFile(rootDirectory, "forced.ignored.ts");
			execFileSync("git", ["add", "src/app.ts", ".gitignore"], {
				cwd: rootDirectory,
				stdio: "ignore",
			});
			execFileSync("git", ["add", "-f", "forced.ignored.ts"], {
				cwd: rootDirectory,
				stdio: "ignore",
			});

			const files = enumerateProjectFiles(rootDirectory, new Set());
			expect(files).toEqual(expect.arrayContaining(["src/app.ts", "forced.ignored.ts"]));
			expect(files).not.toContain("plain.ignored.ts");
		},
	);

	it("does not follow directory symlinks or junctions during disk enumeration", () => {
		const outsideDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-project-outside-"));
		try {
			writeFile(rootDirectory, "src/app.ts");
			writeFile(outsideDirectory, "escaped.ts");
			fs.symlinkSync(
				outsideDirectory,
				path.join(rootDirectory, "linked"),
				process.platform === "win32" ? "junction" : "dir",
			);

			expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
		} finally {
			fs.rmSync(outsideDirectory, { recursive: true, force: true });
		}
	});

	// Contract: a plain directory tree with no embedded repository below the root walks
	// exactly as it would without any of the boundary scoping.
	it("still walks an ordinary directory with no embedded repository", () => {
		writeFile(rootDirectory, "src/app.ts");
		writeFile(rootDirectory, "src/lib/helper.ts");
		writeFile(rootDirectory, "README.md");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(
			expect.arrayContaining(["src/app.ts", "src/lib/helper.ts", "README.md"]),
		);
	});

	it("prunes a fixed set of directory names during disk enumeration", () => {
		writeFile(rootDirectory, "src/app.ts");
		writeFile(rootDirectory, "dist/bundle.js");
		writeFile(rootDirectory, "node_modules/pkg/index.js");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set(["dist", "node_modules"]))).toEqual(
			["src/app.ts"],
		);
	});

	// A tracked submodule's checkout carries a .git FILE (not a directory) pointing back at
	// the superproject's .git/modules/<name> admin dir. The disk walker has no git index to
	// consult, so it can only recognize the boundary the same way for a submodule as for any
	// other embedded repository: a .git entry present in the directory.
	it("skips a directory holding a submodule-shaped .git file", () => {
		writeContent(rootDirectory, "vendor-lib/.git", "gitdir: ../.git/modules/vendor-lib\n");
		writeFile(rootDirectory, "vendor-lib/index.ts");
		writeFile(rootDirectory, "src/app.ts");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
	});

	// A linked worktree also carries a .git FILE (pointing at .git/worktrees/<name>), and an
	// ordinary untracked nested clone carries a .git DIRECTORY. Both are embedded repository
	// boundaries the walker must not recurse past.
	it("skips a nested worktree directory (a .git file)", () => {
		writeContent(rootDirectory, "worktrees/feature/.git", "gitdir: ../../.git/worktrees/feature\n");
		writeFile(rootDirectory, "worktrees/feature/src/app.ts");
		writeFile(rootDirectory, "src/app.ts");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
	});

	it("skips an untracked nested repository (a .git directory)", () => {
		fs.mkdirSync(path.join(rootDirectory, "nested-repo"), { recursive: true });
		execFileSync("git", ["init"], {
			cwd: path.join(rootDirectory, "nested-repo"),
			stdio: "ignore",
		});
		writeFile(rootDirectory, "nested-repo/nested-file.ts");
		writeFile(rootDirectory, "src/app.ts");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
	});

	// The contract validates only that a ".git" entry exists, never what it contains, so an
	// empty ".git" directory (a half-initialized nested repository) is still a boundary.
	// Documented non-detection: the subtree is hidden rather than walked.
	it("skips a directory holding an empty nested .git directory", () => {
		fs.mkdirSync(path.join(rootDirectory, "half-init", ".git"), { recursive: true });
		writeFile(rootDirectory, "half-init/app.ts");
		writeFile(rootDirectory, "src/app.ts");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
	});

	// The contract never reads a ".git" entry's contents, so a plain or malformed .git file
	// (not a valid "gitdir:" pointer) is still a boundary. Documented non-detection.
	it("treats a plain or malformed .git file as a repository boundary", () => {
		fs.mkdirSync(path.join(rootDirectory, "nested"), { recursive: true });
		fs.writeFileSync(path.join(rootDirectory, "nested", ".git"), "not a gitdir pointer\n");
		writeFile(rootDirectory, "nested/app.ts");
		writeFile(rootDirectory, "src/app.ts");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
	});

	// The contract never resolves or validates a "gitdir:" pointer's target, so a stale
	// pointer whose target no longer exists is still a boundary. Documented non-detection.
	it("treats a stale .git pointer file as a repository boundary", () => {
		fs.mkdirSync(path.join(rootDirectory, "stale"), { recursive: true });
		fs.writeFileSync(
			path.join(rootDirectory, "stale", ".git"),
			"gitdir: /nonexistent/target/path\n",
		);
		writeFile(rootDirectory, "stale/app.ts");
		writeFile(rootDirectory, "src/app.ts");

		expect(enumerateProjectFilesFromDisk(rootDirectory, new Set())).toEqual(["src/app.ts"]);
	});
});
