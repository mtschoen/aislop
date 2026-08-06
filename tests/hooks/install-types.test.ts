import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readIfExistsMock, atomicWriteMock } = vi.hoisted(() => ({
	readIfExistsMock: vi.fn(),
	atomicWriteMock: vi.fn(),
}));

vi.mock("../../src/hooks/io/atomic-write.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/hooks/io/atomic-write.js")>();
	return {
		...original,
		readIfExists: readIfExistsMock,
		atomicWrite: atomicWriteMock,
	};
});

import {
	applyContent,
	applyRemoval,
	emptyResult,
	type HookInstallOpts,
	type HookInstallResult,
	type HookUninstallResult,
} from "../../src/hooks/install/types.js";

beforeEach(() => {
	readIfExistsMock.mockReset();
	atomicWriteMock.mockReset();
	vi.spyOn(fs, "unlinkSync").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("applyContent", () => {
	const opts: HookInstallOpts = { home: "/home/me", cwd: "/tmp/repo", scope: "project" };

	it("records unchanged content as skipped", () => {
		readIfExistsMock.mockReturnValue("current");
		const result = emptyResult();

		applyContent(result, opts, "/tmp/hook", "current", "current");

		expect(result.skipped).toEqual(["/tmp/hook"]);
		expect(result.wrote).toEqual([]);
		expect(atomicWriteMock).not.toHaveBeenCalled();
	});

	it("records a dry-run write as planned", () => {
		readIfExistsMock.mockReturnValue("current");
		const result = emptyResult();

		applyContent(result, { ...opts, dryRun: true }, "/tmp/hook", "next", "next");

		expect(result.planned).toEqual([{ path: "/tmp/hook", summary: "next" }]);
		expect(result.wrote).toEqual([]);
	});

	it("writes new content when not skipped or dry-run", () => {
		readIfExistsMock.mockReturnValue("current");
		const result = emptyResult();

		applyContent(result, opts, "/tmp/hook", "next", "next");

		expect(atomicWriteMock).toHaveBeenCalledWith("/tmp/hook", "next");
		expect(result.wrote).toEqual(["/tmp/hook"]);
	});
});

describe("applyRemoval", () => {
	const makeResult = (): HookUninstallResult => ({ removed: [], skipped: [] });

	it("marks a missing file as skipped", () => {
		readIfExistsMock.mockReturnValue(null);
		const result = makeResult();

		applyRemoval(result, {}, "/tmp/hook", "next");

		expect(result.skipped).toEqual(["/tmp/hook"]);
		expect(result.removed).toEqual([]);
		expect(fs.unlinkSync).not.toHaveBeenCalled();
	});

	it("treats an already-matching file as skipped", () => {
		readIfExistsMock.mockReturnValue("same");
		const result = makeResult();

		applyRemoval(result, {}, "/tmp/hook", "same");

		expect(result.skipped).toEqual(["/tmp/hook"]);
		expect(result.removed).toEqual([]);
	});

	it("records a planned uninstall during dry-run", () => {
		readIfExistsMock.mockReturnValue("old");
		const result = makeResult();

		applyRemoval(result, { dryRun: true }, "/tmp/hook", "next");

		expect(result.removed).toEqual(["/tmp/hook"]);
		expect(result.skipped).toEqual([]);
		expect(fs.unlinkSync).not.toHaveBeenCalled();
	});

	it("unlinks files when no replacement content is provided", () => {
		readIfExistsMock.mockReturnValue("old");
		const result = makeResult();

		applyRemoval(result, {}, "/tmp/hook", null);

		expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/hook");
		expect(result.removed).toEqual(["/tmp/hook"]);
		expect(atomicWriteMock).not.toHaveBeenCalled();
	});

	it("writes replacement content when replacement is provided", () => {
		readIfExistsMock.mockReturnValue("old");
		const result = makeResult();

		applyRemoval(result, {}, "/tmp/hook", "replacement");

		expect(atomicWriteMock).toHaveBeenCalledWith("/tmp/hook", "replacement");
		expect(result.removed).toEqual(["/tmp/hook"]);
	});
});
