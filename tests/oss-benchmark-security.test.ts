import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as repositories from "../tools/oss-benchmark/repo-sync.mjs";
import * as commands from "../tools/oss-benchmark/run-command.mjs";
import { sandboxArguments } from "../tools/oss-benchmark/sandbox.mjs";
import { scanRepo } from "../tools/oss-benchmark/scan-runner.mjs";

const { root } = await vi.hoisted(async () => {
	const filesystem = await import("node:fs");
	const paths = await import("node:path");
	filesystem.mkdirSync(".pr-crew-scratch", { recursive: true });
	return { root: filesystem.mkdtempSync(paths.resolve(".pr-crew-scratch/benchmark-security-")) };
});

vi.mock("../tools/oss-benchmark/fs-utils.mjs", async (importOriginal) => ({
	...(await importOriginal()),
	REPOS_DIR: `${root}/cache`,
}));

const repo = {
	language: "typescript",
	owner: "example",
	name: "probe",
	cloneUrl: "https://github.com/example/probe.git",
};
const failure = { code: 1, stdout: "", stderr: "fixture clone failure" };
beforeEach(() => fs.mkdirSync(root, { recursive: true }));
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const bubblewrapAvailable =
	process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

describe("benchmark containment", () => {
	it.each([
		{ language: "../outside" },
		{ owner: "../outside" },
		{ name: "../../outside" },
		{ name: "..\\outside" },
		{ name: "." },
		{ name: "probe." },
	])("rejects manifest traversal before cloning or reporting %j", async (invalid) => {
		const command = vi.spyOn(commands, "runCommand").mockResolvedValue(failure);
		const runRoot = path.join(root, "reports");
		fs.mkdirSync(path.join(root, "outside", ".git"), { recursive: true });
		const invalidRepo = { ...repo, ...invalid };
		await expect(repositories.syncRepo(invalidRepo)).rejects.toThrow(/Invalid repository/);
		await expect(scanRepo({ repo: invalidRepo, runRoot })).rejects.toThrow(/Invalid repository/);
		expect(command).not.toHaveBeenCalled();
		expect(fs.existsSync(runRoot)).toBe(false);
		expect(fs.existsSync(path.join(root, "outside", ".git"))).toBe(true);
	});

	it("does not delete an existing directory after a failed update or clone", async () => {
		vi.spyOn(commands, "runCommand").mockResolvedValue(failure);
		const existing = repositories.repoDirectoryFor(repo.language, repo.owner, repo.name);
		fs.mkdirSync(path.join(existing, ".git"), { recursive: true });
		fs.writeFileSync(path.join(existing, "keep.txt"), "unowned directory");
		await expect(repositories.syncRepo(repo)).rejects.toThrow();
		expect(fs.readFileSync(path.join(existing, "keep.txt"), "utf8")).toBe("unowned directory");
	});

	it.skipIf(process.platform === "win32").each(["cache", "reports"])(
		"rejects a symlinked %s ancestor",
		async (kind) => {
			const command = vi.spyOn(commands, "runCommand").mockResolvedValue(failure);
			const outside = path.join(root, "outside");
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, path.join(root, kind), "dir");
			const action =
				kind === "cache"
					? repositories.syncRepo(repo)
					: scanRepo({ repo, runRoot: path.join(root, "reports") });
			await expect(action).rejects.toThrow(/symlink/i);
			expect(command).not.toHaveBeenCalled();
			expect(fs.readdirSync(outside)).toEqual([]);
		},
	);

	it("writes clone and worker failures only within the report root without a host fallback", async () => {
		const command = vi.spyOn(commands, "runCommand").mockResolvedValue(failure);
		const runRoot = path.join(root, "reports");
		const result = await scanRepo({ repo, runRoot });
		expect(result.status).toBe("clone_failed");
		const metadata = JSON.parse(
			fs.readFileSync(path.join(runRoot, "repos/typescript/example__probe/metadata.json"), "utf8"),
		);
		expect(metadata.message).toBe("fixture clone failure");
		vi.spyOn(repositories, "syncRepo").mockResolvedValue(root);
		command.mockClear().mockRejectedValue(new Error("worker unavailable"));
		const failedScan = await scanRepo({ repo, runRoot });
		expect(failedScan.status).toBe("scan_failed");
		if (process.platform === "linux") {
			expect(failedScan.message).toBe("worker unavailable");
			expect(command.mock.calls.map(([binary]) => binary)).toEqual(["bwrap"]);
		} else {
			expect(failedScan.message).toContain("require Linux");
			expect(command).not.toHaveBeenCalled();
		}
	});

	it.skipIf(!bubblewrapAvailable)(
		"contains executable Knip configuration with the scan worker policy",
		() => {
			const checkout = path.join(root, "checkout");
			fs.mkdirSync(checkout);
			fs.writeFileSync(path.join(checkout, "package.json"), '{"name":"probe","version":"1.0.0"}');
			fs.writeFileSync(path.join(checkout, "index.js"), "module.exports = 1;\n");
			const secret = path.join(root, "host-secret.txt");
			const marker = path.join(root, "host-write.txt");
			fs.writeFileSync(secret, "fixture-secret");
			fs.writeFileSync(
				path.join(checkout, "knip.cjs"),
				`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const writable = (file) => { try { fs.writeFileSync(file, "probe"); return true; } catch { return false; } };
console.error("BENCHMARK_PROBE " + JSON.stringify({
  executed: true,
  secret: process.env.BENCHMARK_TEST_SECRET ?? null,
  hostReadable: fs.existsSync(${JSON.stringify(secret)}),
  hostWritable: writable(${JSON.stringify(marker)}),
  repoWritable: writable(path.join(process.cwd(), "repo-write.txt")),
  interfaces: Object.keys(os.networkInterfaces())
}));
module.exports = { entry: ["index.js"], project: ["index.js"] };
`,
			);
			const knip = "node_modules/knip/bin/knip.js";
			const arguments_ = [
				"--config",
				"knip.cjs",
				"--reporter",
				"json",
				"--no-progress",
				"--no-exit-code",
			];
			const environment = { PATH: process.env.PATH, BENCHMARK_TEST_SECRET: "fixture-secret" };
			const direct = spawnSync(process.execPath, [path.resolve(knip), ...arguments_], {
				cwd: checkout,
				env: environment,
				encoding: "utf8",
			});
			const probe = (result: typeof direct) => {
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				const line = result.stderr.split("\n").find((text) => text.startsWith("BENCHMARK_PROBE "));
				expect(line, result.stderr).toBeDefined();
				return JSON.parse(line!.slice("BENCHMARK_PROBE ".length));
			};
			expect(probe(direct)).toMatchObject({
				executed: true,
				secret: "fixture-secret",
				hostReadable: true,
				hostWritable: true,
				repoWritable: true,
			});
			fs.unlinkSync(marker);
			fs.unlinkSync(path.join(checkout, "repo-write.txt"));
			const isolated = spawnSync(
				"bwrap",
				[...sandboxArguments(checkout), "/scanner/node", `/scanner/${knip}`, ...arguments_],
				{ cwd: checkout, env: environment, encoding: "utf8" },
			);
			const observed = probe(isolated);
			expect(observed).toMatchObject({
				executed: true,
				secret: null,
				hostReadable: false,
				hostWritable: false,
				repoWritable: false,
			});
			expect(observed.interfaces.every((name: string) => name === "lo")).toBe(true);
			expect(fs.existsSync(marker)).toBe(false);
		},
	);
});
