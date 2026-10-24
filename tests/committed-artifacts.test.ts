import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareScan, runScanEngines } from "../src/commands/scan-pipeline.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { AislopConfig } from "../src/config/index.js";
import { parseConfig } from "../src/config/schema.js";
import { detectCommittedArtifacts } from "../src/engines/ai-slop/committed-artifacts.js";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import type { EngineContext } from "../src/engines/types.js";

const isGitAvailable = (): boolean => {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const gitAvailable = isGitAvailable();
const TOOL_OUTPUT = "ai-slop/committed-tool-output";
const LARGE_FILE = "ai-slop/committed-large-file";
const KIBIBYTE = 1024;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const makeDirectory = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-committed-"));
	tempDirs.push(dir);
	return dir;
};

const git = (cwd: string, ...args: string[]): void => {
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
		cwd,
		stdio: "ignore",
	});
};

const write = (root: string, relativePath: string, content: string | Buffer): void => {
	const target = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
};

/** Creates a repository where `tracked` is committed and `untracked` is only on disk. */
const makeRepository = (
	tracked: Record<string, string | Buffer>,
	untracked: Record<string, string | Buffer> = {},
): string => {
	const root = makeDirectory();
	git(root, "init", "-q");
	for (const [name, content] of Object.entries(tracked)) write(root, name, content);
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "init", "--allow-empty");
	for (const [name, content] of Object.entries(untracked)) write(root, name, content);
	return root;
};

const makeContext = (
	rootDirectory: string,
	options: { excludePatterns?: string[]; maxTrackedFileBytes?: number } = {},
): EngineContext => ({
	rootDirectory,
	languages: ["typescript"],
	frameworks: ["none"],
	installedTools: {},
	excludePatterns: options.excludePatterns,
	config: {
		quality: {
			maxFunctionLoc: 80,
			maxFileLoc: 400,
			maxNesting: 5,
			maxParams: 6,
			...(options.maxTrackedFileBytes === undefined
				? {}
				: { maxTrackedFileBytes: options.maxTrackedFileBytes }),
		},
		security: { audit: true, auditTimeout: 25000 },
	} as EngineContext["config"],
});

const sized = (kibibytes: number): string => "x".repeat(kibibytes * KIBIBYTE);

const isolatedAiSlopConfig: AislopConfig = {
	...DEFAULT_CONFIG,
	engines: {
		format: false,
		lint: false,
		"code-quality": false,
		"ai-slop": true,
		architecture: false,
		security: false,
	},
	security: { ...DEFAULT_CONFIG.security, audit: false },
	telemetry: { enabled: false },
};

describe.skipIf(!gitAvailable)("detectCommittedArtifacts", () => {
	it.each([
		"after.sarif",
		"run.log",
		"results.trx",
		"before.stderr.txt",
		"before.stdout.txt",
		"evidence.tar.gz",
		"bundle.zip",
		"bundle.tgz",
		"bundle.tar",
		"bundle.7z",
		"OUTPUT.LOG",
		"docs/verification/Before.SARIF",
	])("flags tracked %s as committed tool output", async (name) => {
		const root = makeRepository({ [name]: "data" });
		const diagnostics = await detectCommittedArtifacts(makeContext(root));
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].rule).toBe(TOOL_OUTPUT);
		expect(diagnostics[0].filePath).toBe(name);
		expect(diagnostics[0].message).toContain(path.posix.basename(name));
	});

	it("produces nothing for the same names when untracked", async () => {
		const root = makeRepository(
			{ "readme.md": "hi" },
			{ "after.sarif": "x", "run.log": "x", "evidence.tar.gz": "x", "a.stderr.txt": "x" },
		);
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it("ignores an untracked log covered by a tracked .gitignore", async () => {
		const root = makeRepository({ ".gitignore": "*.log\n" }, { "debug.log": "noise" });
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it("produces nothing for ordinary tracked files", async () => {
		const root = makeRepository({ "notes.txt": "n", "report.md": "r" });
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it.each(["dump.json", "novel.md"])(
		"flags a tracked file above the ceiling with its size and the ceiling (%s)",
		async (name) => {
			const root = makeRepository({ [name]: sized(600) });
			const diagnostics = await detectCommittedArtifacts(makeContext(root));
			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0].rule).toBe(LARGE_FILE);
			expect(diagnostics[0].filePath).toBe(name);
			expect(diagnostics[0].message).toContain("600 KiB");
			expect(diagnostics[0].message).toContain("512 KiB");
		},
	);

	it("does not flag a file at exactly the ceiling", async () => {
		const root = makeRepository({ "edge.json": sized(512) });
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it("never considers a binary file, detected by a NUL in the first 8000 bytes", async () => {
		const content = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(sized(600))]);
		const root = makeRepository({ "asset.gif": content });
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it("treats a file with a NUL only after byte 8000 as text", async () => {
		const content = Buffer.concat([
			Buffer.from("x".repeat(8000)),
			Buffer.from([0]),
			Buffer.from(sized(600)),
		]);
		const root = makeRepository({ "late-nul.dat": content });
		const diagnostics = await detectCommittedArtifacts(makeContext(root));
		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([LARGE_FILE]);
	});

	it("spares a lockfile over the ceiling", async () => {
		const root = makeRepository({ "pnpm-lock.yaml": sized(600), "sub/Cargo.lock": sized(600) });
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it("reports an oversized tool-output file once, by the tool-output rule", async () => {
		const root = makeRepository({ "huge.sarif": sized(600) });
		const diagnostics = await detectCommittedArtifacts(makeContext(root));
		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([TOOL_OUTPUT]);
	});

	it("honors a lowered maxTrackedFileBytes", async () => {
		const root = makeRepository({ "small.json": sized(2) });
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
		const diagnostics = await detectCommittedArtifacts(
			makeContext(root, { maxTrackedFileBytes: 1000 }),
		);
		expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([LARGE_FILE]);
	});

	it("skips a tracked file that is missing on disk", async () => {
		const root = makeRepository({ "dump.json": sized(600) });
		fs.rmSync(path.join(root, "dump.json"));
		expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
	});

	it("honors the exclude list for both rules", async () => {
		const root = makeRepository({
			"tests/fixtures/sample.log": "x",
			"tests/fixtures/big.json": sized(600),
		});
		const context = makeContext(root, { excludePatterns: ["tests/fixtures"] });
		expect(await detectCommittedArtifacts(context)).toEqual([]);
	});

	it("emits the documented diagnostic shape", async () => {
		const root = makeRepository({ "a.log": "x" });
		const [diagnostic] = await detectCommittedArtifacts(makeContext(root));
		expect(diagnostic).toMatchObject({
			engine: "ai-slop",
			category: "AI Slop",
			severity: "warning",
			line: 1,
			column: 1,
			fixable: false,
		});
		expect(diagnostic.help).toContain("PR body");
	});

	it.each([
		"leaf-symlink",
		"leaf-symlink-tool-output",
		"parent-symlink",
		"parent-symlink-tool-output",
	] as const)(
		"skips tracked paths that resolve outside the project root (%s)",
		async (scenario) => {
			const fileName = scenario.endsWith("tool-output") ? "outside.log" : "outside.txt";
			const external = makeDirectory();
			const externalTarget = path.join(external, fileName);
			fs.writeFileSync(externalTarget, sized(600));

			const root = makeDirectory();
			git(root, "init", "-q");
			try {
				if (scenario.startsWith("leaf-symlink")) {
					fs.symlinkSync(externalTarget, path.join(root, fileName), "file");
					git(root, "add", "-A");
					git(root, "commit", "-q", "-m", "init");
				} else {
					write(root, `sub/${fileName}`, "seed");
					git(root, "add", "-A");
					git(root, "commit", "-q", "-m", "init");
					fs.rmSync(path.join(root, "sub"), { recursive: true, force: true });
					fs.symlinkSync(external, path.join(root, "sub"), "dir");
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EPERM") return;
				throw error;
			}

			expect(await detectCommittedArtifacts(makeContext(root))).toEqual([]);
			const prepared = await prepareScan(root, isolatedAiSlopConfig, { kind: "full" });
			const initialRun = await runScanEngines(prepared, isolatedAiSlopConfig, true);
			expect(initialRun.results.flatMap((entry) => entry.diagnostics)).toEqual([]);
			expect(initialRun.suppressedCount).toBe(0);

			fs.writeFileSync(externalTarget, `// aislop-ignore-file\n${sized(600)}`);
			const directiveRun = await runScanEngines(prepared, isolatedAiSlopConfig, true);
			expect(directiveRun.results.flatMap((entry) => entry.diagnostics)).toEqual([]);
			expect(directiveRun.suppressedCount).toBe(0);
		},
	);

	it.each([
		"missing-git-full",
		"missing-git-staged",
		"missing-git-changes",
		"corrupt-index-full",
		"corrupt-index-staged",
		"corrupt-index-changes",
	] as const)("surfaces %s in aiSlopEngine status", async (scenario) => {
		const root = makeRepository({ "run.log": "x" });
		const mode = scenario.endsWith("-staged")
			? ({ kind: "staged" } as const)
			: scenario.endsWith("-changes")
				? ({ kind: "changes", base: "HEAD" } as const)
				: ({ kind: "full" } as const);
		const previousPath = process.env.PATH;
		const previousWindowsPath = process.env.Path;
		if (scenario.startsWith("missing-git")) {
			const emptyBin = makeDirectory();
			process.env.PATH = emptyBin;
			if (previousWindowsPath !== undefined) process.env.Path = emptyBin;
		} else {
			fs.writeFileSync(path.join(root, ".git", "index"), "corrupt");
		}
		try {
			const directResult = await aiSlopEngine.run(makeContext(root));
			const prepared = await prepareScan(root, isolatedAiSlopConfig, mode);
			const { results } = await runScanEngines(prepared, isolatedAiSlopConfig, true);
			const pipelineResult = results.find((entry) => entry.engine === "ai-slop");
			for (const result of [directResult, pipelineResult]) {
				expect(result?.diagnostics).toEqual([]);
				if (scenario.startsWith("missing-git")) {
					expect(result?.missingTools).toEqual(["git"]);
					expect(result?.failed).toBeUndefined();
				} else {
					expect(result?.failed).toBe(true);
					expect(result?.failures).toEqual([
						expect.objectContaining({
							tool: "git ls-files",
							reason: expect.stringContaining("index"),
						}),
					]);
				}
			}
		} finally {
			process.env.PATH = previousPath;
			if (previousWindowsPath !== undefined) process.env.Path = previousWindowsPath;
		}
	});

	it.each([
		"staged-populated",
		"staged-empty",
		"staged-nested-root-detected",
		"staged-nested-root-shadow",
		"changes-populated",
		"changes-empty",
		"changes-nested-root-detected",
		"changes-nested-root-shadow",
	] as const)(
		"restricts committed-artifact detection to the selected scan scope (%s)",
		async (scenario) => {
			const root = makeRepository({
				"run.log": "unchanged root log",
				"docs/old.log": "unchanged log",
				"docs/dump.json": sized(600),
				"package/run.log": "unchanged nested log",
				"package/src/a.ts": "export const nested = 1;\n",
				"src/a.ts": "export const value = 1;\n",
			});
			if (scenario === "staged-populated") {
				write(root, "src/a.ts", "export const value = 2;\n");
				git(root, "add", "src/a.ts");
			} else if (scenario === "staged-nested-root-detected") {
				write(root, "package/run.log", "staged nested log\n");
				git(root, "add", "package/run.log");
			} else if (scenario === "staged-nested-root-shadow") {
				write(root, "run.log", "staged root log\n");
				git(root, "add", "run.log");
			} else if (scenario === "changes-populated") {
				write(root, "src/a.ts", "export const value = 2;\n");
			} else if (scenario === "changes-nested-root-detected") {
				write(root, "package/run.log", "changed nested log\n");
			} else if (scenario === "changes-nested-root-shadow") {
				write(root, "run.log", "changed root log\n");
			}

			const scanRoot = scenario.includes("nested-root") ? path.join(root, "package") : root;
			const mode = scenario.startsWith("staged")
				? ({ kind: "staged" } as const)
				: ({ kind: "changes", base: "HEAD" } as const);
			const prepared = await prepareScan(scanRoot, isolatedAiSlopConfig, mode);
			const { results } = await runScanEngines(prepared, isolatedAiSlopConfig, true);
			const diagnostics = results.flatMap((entry) => entry.diagnostics);
			if (scenario.endsWith("-detected")) {
				expect(diagnostics).toEqual([
					expect.objectContaining({
						filePath: "run.log",
						rule: TOOL_OUTPUT,
					}),
				]);
			} else {
				expect(diagnostics).toEqual([]);
			}
		},
	);
});

describe("detectCommittedArtifacts outside a repository", () => {
	it("yields no findings and does not throw", async () => {
		const root = makeDirectory();
		write(root, "run.log", "x");
		write(root, "dump.json", sized(600));
		await expect(detectCommittedArtifacts(makeContext(root))).resolves.toEqual([]);
	});
});

describe("quality.maxTrackedFileBytes configuration", () => {
	it("defaults to 524288", () => {
		expect(parseConfig({}).quality.maxTrackedFileBytes).toBe(524288);
	});

	it("round-trips a configured value", () => {
		expect(
			parseConfig({ quality: { maxTrackedFileBytes: 1000 } }).quality.maxTrackedFileBytes,
		).toBe(1000);
	});
});
