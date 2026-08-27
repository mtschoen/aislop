import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHookFiles, runScopedScan } from "../../src/hooks/io/scoped-scan.js";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", async () => {
	const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
	spawnSync.mockImplementation((command: string, ...rest: unknown[]) => {
		if (command === "git") return actual.spawnSync(command, ...(rest as []));
		throw new Error("automatic hook scans must not spawn subprocesses other than git");
	});
	return { ...actual, spawnSync };
});

const isGitAvailable = (): boolean => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const gitAvailable = isGitAvailable();
const EM_DASH = String.fromCodePoint(0x2014);

const tempDirs: string[] = [];

const makeTempProject = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-hook-safe-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	spawnSync.mockClear();
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("runScopedScan", () => {
	it("does not fall back to Git when the hook payload has no usable files", () => {
		const root = makeTempProject();
		const missing = path.join(root, "missing.ts");

		expect(resolveHookFiles(root, [missing])).toEqual([]);
		expect(resolveHookFiles(root, [])).toEqual([]);
		expect(spawnSync).not.toHaveBeenCalled();
	});

	it("rejects an existing absolute file outside the hook cwd", () => {
		const root = makeTempProject();
		const outsideRoot = makeTempProject();
		const outsideFile = path.join(outsideRoot, "outside.ts");
		fs.writeFileSync(outsideFile, "export const outside = true;\n");

		expect(resolveHookFiles(root, [outsideFile])).toEqual([]);
	});

	it("rejects an in-root symlink whose real file is outside the hook cwd", () => {
		const root = makeTempProject();
		const outsideRoot = makeTempProject();
		const outsideFile = path.join(outsideRoot, "outside.ts");
		const symlinkPath = path.join(root, "escaped.ts");
		fs.writeFileSync(outsideFile, "export const outside = true;\n");
		fs.symlinkSync(outsideFile, symlinkPath);

		expect(resolveHookFiles(root, [symlinkPath])).toEqual([]);
	});

	it("preserves valid relative and absolute files inside the hook cwd", () => {
		const root = makeTempProject();
		const relativePath = path.join("src", "inside.ts");
		const absolutePath = path.join(root, relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, "export const inside = true;\n");

		expect(resolveHookFiles(root, [relativePath])).toEqual([absolutePath]);
		expect(resolveHookFiles(root, [absolutePath])).toEqual([absolutePath]);
	});

	it("spawns nothing but git while collecting scan evidence", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		const sourcePath = path.join(root, "src/app.ts");
		fs.writeFileSync(sourcePath, "export const value = true;\n");

		await runScopedScan(root, [sourcePath]);

		for (const call of spawnSync.mock.calls) {
			expect(call[0]).toBe("git");
		}
	});

	it("does not execute project-local Knip from automatic hook scans", async () => {
		const root = makeTempProject();
		const marker = path.join(root, "knip-executed.txt");
		const knipBin = path.join(root, "node_modules", "knip", "bin", "knip.js");

		fs.mkdirSync(path.dirname(knipBin), { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "malicious" }));
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src", "touched.js"), "export const value = 1;\n");
		fs.writeFileSync(
			knipBin,
			`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "executed");\nconsole.log("[]");\n`,
		);

		await runScopedScan(root, [path.join(root, "src", "touched.js")]);

		expect(fs.existsSync(marker)).toBe(false);
	});

	it("checks a changed test file for tautological assertions", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src", "app.ts"), "export const value = true;\n");
		const testPath = path.join(root, "src", "app.test.ts");
		fs.writeFileSync(testPath, "it('passes', () => expect(true).toBe(true));\n");

		const result = await runScopedScan(root, [testPath]);

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				filePath: "src/app.test.ts",
				rule: "ai-slop/tautological-test",
			}),
		]);
	});

	it("uses unchanged ambient declarations during a scoped hook scan", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src/virtual.d.ts"), 'declare module "likec4:rpc";\n');
		const importer = path.join(root, "src/app.ts");
		fs.writeFileSync(importer, 'import { rpc } from "likec4:rpc";\nrpc();\n');

		const result = await runScopedScan(root, [importer]);

		expect(result.diagnostics).toEqual([]);
	});

	it("does not use excluded ambient declarations during a scoped hook scan", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, ".aislop"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".aislop/config.yml"),
			["version: 1", "exclude:", "  - src/ignored.d.ts"].join("\n"),
		);
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		fs.writeFileSync(path.join(root, "src/ignored.d.ts"), 'declare module "ghost:ignored";\n');
		const importer = path.join(root, "src/app.ts");
		fs.writeFileSync(importer, 'import value from "ghost:ignored";\nvalue();\n');

		const result = await runScopedScan(root, [importer]);

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				filePath: "src/app.ts",
				rule: "ai-slop/hallucinated-import",
			}),
		]);
	});

	it("respects configured include and exclude patterns for changed tests", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, ".aislop"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".aislop/config.yml"),
			["version: 1", "include:", "  - src", "exclude:", "  - src/ignored.test.ts"].join("\n"),
		);
		fs.writeFileSync(path.join(root, ".aislopignore"), "src/also-ignored.test.ts\n");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		const ignoredTest = path.join(root, "src/ignored.test.ts");
		const alsoIgnoredTest = path.join(root, "src/also-ignored.test.ts");
		const outsideInclude = path.join(root, "tests/outside.test.ts");
		fs.writeFileSync(ignoredTest, "expect(true).toBe(true);\n");
		fs.writeFileSync(alsoIgnoredTest, "expect(true).toBe(true);\n");
		fs.mkdirSync(path.dirname(outsideInclude), { recursive: true });
		fs.writeFileSync(outsideInclude, "expect(true).toBe(true);\n");

		const result = await runScopedScan(root, [ignoredTest, alsoIgnoredTest, outsideInclude]);

		expect(result.diagnostics).toEqual([]);
	});

	it("flags a hardcoded path under a configured banned root that is not the runtime home", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, ".aislop"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".aislop/config.yml"),
			[
				"version: 1",
				"aiSlop:",
				"  hardcodedUserPath:",
				"    bannedRoots:",
				"      - /home/hook-review-target",
			].join("\n"),
		);
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		const changedFile = path.join(root, "src/launch.ts");
		fs.writeFileSync(changedFile, 'const tool = "/home/hook-review-target/project/tool";\n');

		const result = await runScopedScan(root, [changedFile]);

		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				filePath: "src/launch.ts",
				rule: "ai-slop/hardcoded-user-path",
			}),
		]);
	});

	it("respects disabled rule overrides", async () => {
		const root = makeTempProject();
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
		fs.mkdirSync(path.join(root, ".aislop"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".aislop/config.yml"),
			["version: 1", "rules:", "  ai-slop/tautological-test: off"].join("\n"),
		);
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		const testPath = path.join(root, "src/app.test.ts");
		fs.writeFileSync(testPath, "expect(true).toBe(true);\n");

		const result = await runScopedScan(root, [testPath]);

		expect(result.diagnostics).toEqual([]);
	});

	it.skipIf(!gitAvailable)(
		"reads the git snapshot to exclude gitignored and nested-worktree files",
		async () => {
			const root = makeTempProject();
			const runGit = (...args: string[]): void => {
				execFileSync("git", args, { cwd: root, stdio: "ignore" });
			};

			runGit("init", "-q");
			runGit("config", "user.name", "aislop-test");
			runGit("config", "user.email", "aislop-test@example.com");

			fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "project" }));
			fs.writeFileSync(path.join(root, ".gitignore"), ".venv/\nignored.ts\n");
			fs.mkdirSync(path.join(root, "src"), { recursive: true });
			const trackedSource = path.join(root, "src/app.ts");
			fs.writeFileSync(
				trackedSource,
				`// keep this ${EM_DASH} it matters\nexport const value = true;\n`,
			);
			runGit("add", "package.json", ".gitignore", "src/app.ts");
			runGit("commit", "-q", "-m", "seed fixture");

			runGit("branch", "other");
			runGit("worktree", "add", "worktree", "other", "-q");
			const nestedWorktreeFile = path.join(root, "worktree", "leak.ts");
			fs.writeFileSync(
				nestedWorktreeFile,
				`// keep this ${EM_DASH} it matters\nexport const leak = true;\n`,
			);

			fs.mkdirSync(path.join(root, ".venv", "pkg"), { recursive: true });
			const ignoredByGitignore = path.join(root, ".venv/pkg/module.py");
			fs.writeFileSync(ignoredByGitignore, `# keep this ${EM_DASH} it matters\n`);

			const forceTrackedIgnored = path.join(root, "ignored.ts");
			fs.writeFileSync(
				forceTrackedIgnored,
				`// keep this ${EM_DASH} it matters\nexport const ignored = true;\n`,
			);
			runGit("add", "-f", "ignored.ts");
			runGit("commit", "-q", "-m", "force track an ignored file");

			const result = await runScopedScan(root, [
				trackedSource,
				ignoredByGitignore,
				nestedWorktreeFile,
				forceTrackedIgnored,
			]);

			const emDashFindings = result.diagnostics.filter(
				(diagnostic) => diagnostic.rule === "ai-slop/em-dash",
			);
			expect(new Set(emDashFindings.map((diagnostic) => diagnostic.filePath))).toEqual(
				new Set(["src/app.ts", "ignored.ts"]),
			);

			for (const call of spawnSync.mock.calls) {
				expect(call[0]).toBe("git");
			}
		},
	);
});
