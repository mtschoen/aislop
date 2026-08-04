import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "../../src/version.js";
import { appendHistory, readHistory } from "../../src/utils/history.js";

let tmpDir: string;
let historyPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-history-"));
	historyPath = path.join(tmpDir, ".aislop", "history.jsonl");
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-06-07T10:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendHistory", () => {
	it("skips history writes when disabled", () => {
		const previousValue = process.env.AISLOP_NO_HISTORY;
		process.env.AISLOP_NO_HISTORY = "1";
		fs.mkdirSync(path.join(tmpDir, ".aislop"), { recursive: true });

		appendHistory({ directory: tmpDir, score: 92, errors: 1, warnings: 2, files: 12 });

		expect(fs.existsSync(historyPath)).toBe(false);
		if (previousValue === undefined) {
			delete process.env.AISLOP_NO_HISTORY;
		} else {
			process.env.AISLOP_NO_HISTORY = previousValue;
		}
	});

	it("writes only when the config directory exists", () => {
		appendHistory({ directory: tmpDir, score: 92, errors: 1, warnings: 2, files: 12 });

		expect(fs.existsSync(historyPath)).toBe(false);

		fs.mkdirSync(path.join(tmpDir, ".aislop"), { recursive: true });
		appendHistory({ directory: tmpDir, score: 80, errors: 3, warnings: 5, files: 24 });
		const lines = fs.readFileSync(historyPath, "utf-8").trim().split("\n");

		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
		expect(record).toMatchObject({
			score: 80,
			errors: 3,
			warnings: 5,
			files: 24,
			timestamp: "2026-06-07T10:00:00.000Z",
			cliVersion: APP_VERSION,
		});
	});
});

describe("readHistory", () => {
	it("reads valid records and skips malformed lines", () => {
		fs.mkdirSync(path.join(tmpDir, ".aislop"), { recursive: true });
		fs.writeFileSync(
			historyPath,
			`${JSON.stringify({
				timestamp: "2026-06-01T00:00:00.000Z",
				score: 85,
				errors: 0,
				warnings: 0,
				files: 11,
				cliVersion: "0.0.0",
			})}\nnot-json\n`,
		);

		const records = readHistory(tmpDir);
		expect(records).toHaveLength(1);
		expect(records[0]!.score).toBe(85);
	});

	it("returns [] when history file is missing", () => {
		expect(readHistory(tmpDir)).toEqual([]);
	});
});
