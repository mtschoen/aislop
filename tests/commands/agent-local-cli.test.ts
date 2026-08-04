import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { log } from "../../src/ui/logger.js";
import { applyDiff, runSafeFix, scanJson } from "../../src/commands/agent-local-cli.js";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

beforeEach(() => {
	spawnSyncMock.mockReset();
	vi.spyOn(log, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("scanJson", () => {
	it("parses aislop json output", () => {
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: '{"score":95,"files":42}',
			stderr: "",
			signal: null,
			timeout: false,
		});

		const payload = scanJson("/tmp/project");
		expect(payload).toMatchObject({ score: 95, files: 42 });
	});

	it("throws when aislop emits no stdout", () => {
		spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "no output", signal: null });

		expect(() => scanJson("/tmp/project")).toThrow("no output");
	});

	it("throws when stdout is malformed json", () => {
		spawnSyncMock.mockReturnValue({ status: 0, stdout: "not-json", stderr: "", signal: null });

		expect(() => scanJson("/tmp/project")).toThrow("Failed to parse aislop scan output");
	});

	it("falls back to dist/cli.js when argv[1] does not point to a file", () => {
		const existsSyncMock = vi.spyOn(fs, "existsSync").mockReturnValue(false);
		const argv = process.argv;
		process.argv = ["node"];

		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: '{"score":95,"files":42}',
			stderr: "",
			signal: null,
		});

		scanJson("/tmp/project");
		expect(spawnSyncMock).toHaveBeenCalledWith(
			process.execPath,
			[path.resolve("dist/cli.js"), "scan", ".", "--json"],
			expect.objectContaining({ cwd: "/tmp/project" }),
		);

		process.argv = argv;
		existsSyncMock.mockRestore();
	});
});

describe("runSafeFix", () => {
	it("warns when fix exits with an error and stderr", () => {
		spawnSyncMock.mockReturnValue({
			status: 2,
			stdout: "",
			stderr: "fix failed due to perms\nline2",
			signal: null,
		});

		runSafeFix("/tmp/project");

		expect(log.warn).toHaveBeenCalledWith("fix failed due to perms");
	});
});

describe("applyDiff", () => {
	it("throws when git apply fails", async () => {
		spawnSyncMock.mockReturnValue({
			status: 1,
			stdout: "",
			stderr: "nothing to apply",
			signal: null,
		});

		await expect(applyDiff("/tmp/project", "diff")).rejects.toThrow("nothing to apply");
	});

	it("resolves when git apply succeeds", async () => {
		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: "",
			stderr: "",
			signal: null,
		});

		await expect(applyDiff("/tmp/project", "diff")).resolves.toBeUndefined();
	});
});
