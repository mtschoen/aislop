import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBuildInfo, gitRevParseHead, resolveCommitSha } from "../src/utils/build-info.js";

const VALID_SHA_A = "0123456789abcdef0123456789abcdef01234567";
const VALID_SHA_B = "abcdef0123456789abcdef0123456789abcdef01";

describe("resolveCommitSha", () => {
	it("prefers an explicit valid COMMIT override over the git fallback", () => {
		const gitRevParseHead = () => {
			throw new Error("must not be called when a valid override is present");
		};

		expect(resolveCommitSha(VALID_SHA_A, gitRevParseHead)).toBe(VALID_SHA_A);
	});

	it("trims whitespace around the override", () => {
		expect(resolveCommitSha(`  ${VALID_SHA_A}  \n`, () => null)).toBe(VALID_SHA_A);
	});

	it("falls back to the git resolver when COMMIT is unset", () => {
		expect(resolveCommitSha(undefined, () => VALID_SHA_B)).toBe(VALID_SHA_B);
	});

	it("falls back to the git resolver when COMMIT is an empty string", () => {
		expect(resolveCommitSha("", () => VALID_SHA_B)).toBe(VALID_SHA_B);
	});

	it("falls back to the git resolver when COMMIT is only whitespace", () => {
		expect(resolveCommitSha("   ", () => VALID_SHA_B)).toBe(VALID_SHA_B);
	});

	it("falls back to the git resolver when COMMIT is not a 40-character hex sha", () => {
		expect(resolveCommitSha("override-commit", () => VALID_SHA_B)).toBe(VALID_SHA_B);
		expect(resolveCommitSha("abc123", () => VALID_SHA_B)).toBe(VALID_SHA_B);
		expect(resolveCommitSha("g".repeat(40), () => VALID_SHA_B)).toBe(VALID_SHA_B);
		expect(resolveCommitSha("a".repeat(39), () => VALID_SHA_B)).toBe(VALID_SHA_B);
		expect(resolveCommitSha("a".repeat(41), () => VALID_SHA_B)).toBe(VALID_SHA_B);
	});

	it("returns null when both the override and the git resolver are absent", () => {
		expect(resolveCommitSha(undefined, () => null)).toBeNull();
	});

	it("returns null when the override is invalid and the git resolver returns null", () => {
		expect(resolveCommitSha("override-commit", () => null)).toBeNull();
	});

	it("returns null when the git resolver returns an invalid non-sha string", () => {
		expect(resolveCommitSha(undefined, () => "not-a-valid-sha")).toBeNull();
	});
});

describe("gitRevParseHead", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-build-info-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns the checked-out commit sha in a real git repository", () => {
		execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], {
			cwd: tmpDir,
			stdio: "ignore",
		});
		execFileSync("git", ["config", "user.name", "test"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmpDir, stdio: "ignore" });
		fs.writeFileSync(path.join(tmpDir, "file.txt"), "content\n");
		execFileSync("git", ["add", "file.txt"], { cwd: tmpDir, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "init", "--no-verify"], { cwd: tmpDir, stdio: "ignore" });

		const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpDir, encoding: "utf-8" })
			.trim();

		expect(gitRevParseHead(tmpDir)).toBe(expected);
		expect(gitRevParseHead(tmpDir)).toHaveLength(40);
	});

	it("returns null outside a git repository", () => {
		expect(gitRevParseHead(tmpDir)).toBeNull();
	});
});

describe("buildBuildInfo", () => {
	it("shapes the version, commit, and ISO-8601 build timestamp", () => {
		const builtAt = new Date("2026-01-01T00:00:00.000Z");

		expect(buildBuildInfo({ version: "1.2.3", commit: VALID_SHA_A, builtAt })).toEqual({
			version: "1.2.3",
			commit: VALID_SHA_A,
			builtAt: "2026-01-01T00:00:00.000Z",
		});
	});

	it("passes through a null commit without substituting a placeholder", () => {
		const builtAt = new Date("2026-01-01T00:00:00.000Z");

		expect(buildBuildInfo({ version: "1.2.3", commit: null, builtAt }).commit).toBeNull();
	});
});
