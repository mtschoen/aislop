import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkForkPin, readForkPin, readRunningBuildInfo } from "../src/utils/fork-pin.js";

const PINNED = "ad036928176523101132e39b11b8fd9e108db601";
const OTHER = "9de29395a1b2c3d4e5f60718293a4b5c6d7e8f90";

let rootDirectory: string;
let distDirectory: string;

const write = (relative: string, content: string): void => {
	const absolute = path.join(rootDirectory, relative);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, content);
};

const writeBuildInfo = (commit: string | null): void => {
	fs.writeFileSync(
		path.join(distDirectory, "build-info.json"),
		JSON.stringify({ version: "0.16.0", commit, builtAt: new Date(0).toISOString() }),
	);
};

beforeEach(() => {
	rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-fork-pin-"));
	distDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-fork-dist-"));
});

afterEach(() => {
	fs.rmSync(rootDirectory, { recursive: true, force: true });
	fs.rmSync(distDirectory, { recursive: true, force: true });
});

describe("readForkPin", () => {
	it("reads the pin from .aislop/fork-commit", () => {
		write(".aislop/fork-commit", `${PINNED}\n`);
		expect(readForkPin(rootDirectory)).toBe(PINNED);
	});

	it("returns null when the repository carries no .aislop directory", () => {
		expect(readForkPin(rootDirectory)).toBeNull();
	});

	it("returns null when .aislop exists without a fork-commit file", () => {
		write(".aislop/config.yml", "version: 1\n");
		expect(readForkPin(rootDirectory)).toBeNull();
	});

	it("finds the pin from a nested working directory, where config lookup finds it", () => {
		write(".aislop/fork-commit", PINNED);
		const nested = path.join(rootDirectory, "packages", "app", "src");
		fs.mkdirSync(nested, { recursive: true });
		expect(readForkPin(nested)).toBe(PINNED);
	});

	it("rejects a fork-commit file that is not a 40 character sha", () => {
		write(".aislop/fork-commit", "not-a-sha\n");
		expect(readForkPin(rootDirectory)).toBeNull();
	});

	it("stops at the boundary when one is given", () => {
		write(".aislop/fork-commit", PINNED);
		const nested = path.join(rootDirectory, "nested");
		fs.mkdirSync(nested, { recursive: true });
		expect(readForkPin(nested, nested)).toBeNull();
	});
});

describe("readRunningBuildInfo", () => {
	it("reads the commit a build was stamped with", () => {
		writeBuildInfo(PINNED);
		expect(readRunningBuildInfo(distDirectory)?.commit).toBe(PINNED);
	});

	it("returns null when the directory carries no stamp, as in a source run", () => {
		expect(readRunningBuildInfo(distDirectory)).toBeNull();
	});

	it("reports a null commit when the stamp records one, as in a tarball build", () => {
		writeBuildInfo(null);
		expect(readRunningBuildInfo(distDirectory)?.commit).toBeNull();
	});

	it("returns null for a malformed stamp rather than throwing", () => {
		fs.writeFileSync(path.join(distDirectory, "build-info.json"), "{ not json");
		expect(readRunningBuildInfo(distDirectory)).toBeNull();
	});
});

describe("checkForkPin", () => {
	it("reports no-pin for a repository that does not pin a fork commit", () => {
		writeBuildInfo(PINNED);
		expect(checkForkPin({ directory: rootDirectory, distDirectory })).toEqual({
			state: "no-pin",
			pinnedCommit: null,
			runningCommit: null,
		});
	});

	it("reports aligned when the running build matches the pin", () => {
		write(".aislop/fork-commit", PINNED);
		writeBuildInfo(PINNED);
		expect(checkForkPin({ directory: rootDirectory, distDirectory })).toEqual({
			state: "aligned",
			pinnedCommit: PINNED,
			runningCommit: PINNED,
		});
	});

	it("reports drift when the running build is a different commit", () => {
		write(".aislop/fork-commit", PINNED);
		writeBuildInfo(OTHER);
		expect(checkForkPin({ directory: rootDirectory, distDirectory })).toEqual({
			state: "drift",
			pinnedCommit: PINNED,
			runningCommit: OTHER,
		});
	});

	it("compares shas without regard to case", () => {
		write(".aislop/fork-commit", PINNED.toUpperCase());
		writeBuildInfo(PINNED);
		expect(checkForkPin({ directory: rootDirectory, distDirectory }).state).toBe("aligned");
	});

	it("reports unknown-build when a pin exists but the build carries no commit", () => {
		write(".aislop/fork-commit", PINNED);
		writeBuildInfo(null);
		expect(checkForkPin({ directory: rootDirectory, distDirectory })).toEqual({
			state: "unknown-build",
			pinnedCommit: PINNED,
			runningCommit: null,
		});
	});
});
