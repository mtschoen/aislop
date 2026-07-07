import { describe, expect, it, vi } from "vitest";
import { chunkFilePaths, isMissingToolError, warnSubprocessFailure } from "../src/utils/subprocess.js";

describe("chunkFilePaths", () => {
	it("puts everything in one chunk when well under both limits", () => {
		const files = ["a.cpp", "b.cpp", "c.cpp"];
		expect(chunkFilePaths(files, 200, 25000)).toEqual([files]);
	});

	it("splits once the file-count cap is hit", () => {
		const files = Array.from({ length: 5 }, (_, i) => `f${i}.cpp`);
		const chunks = chunkFilePaths(files, 2, 25000);
		expect(chunks).toEqual([["f0.cpp", "f1.cpp"], ["f2.cpp", "f3.cpp"], ["f4.cpp"]]);
	});

	it("splits once the character budget is hit", () => {
		// Each path is 10 chars + 1 separator = 11; a budget of 25 fits two per chunk.
		const files = ["aaaaaaaa.c", "bbbbbbbb.c", "cccccccc.c", "dddddddd.c"];
		const chunks = chunkFilePaths(files, 200, 25);
		expect(chunks).toEqual([
			["aaaaaaaa.c", "bbbbbbbb.c"],
			["cccccccc.c", "dddddddd.c"],
		]);
	});

	it("gives an over-budget lone file its own chunk instead of dropping it", () => {
		const hugePath = "x".repeat(100);
		const files = [hugePath, "short.cpp"];
		const chunks = chunkFilePaths(files, 200, 25);
		expect(chunks).toEqual([[hugePath], ["short.cpp"]]);
	});

	it("returns [] for an empty file list", () => {
		expect(chunkFilePaths([])).toEqual([]);
	});

	it("defaults to a 200-file / 25000-char budget", () => {
		const files = Array.from({ length: 201 }, (_, i) => `f${i}.cpp`);
		const chunks = chunkFilePaths(files);
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(200);
		expect(chunks[1]).toHaveLength(1);
	});
});

describe("isMissingToolError", () => {
	it("is true for an ENOENT spawn error", () => {
		const error = Object.assign(new Error("spawn foo ENOENT"), { code: "ENOENT" });
		expect(isMissingToolError(error)).toBe(true);
	});

	it("is false for a non-ENOENT error (e.g. a timeout)", () => {
		expect(isMissingToolError(new Error("Command timed out after 1000ms: foo"))).toBe(false);
	});

	it("is false for a non-Error rejection", () => {
		expect(isMissingToolError("some string")).toBe(false);
		expect(isMissingToolError(undefined)).toBe(false);
	});
});

describe("warnSubprocessFailure", () => {
	it("writes a message to console.error naming the tool and the failure", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		warnSubprocessFailure("cppcheck", new Error("boom"));
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][0]).toContain("cppcheck");
		expect(spy.mock.calls[0][0]).toContain("boom");
		spy.mockRestore();
	});
});
