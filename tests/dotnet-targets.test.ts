import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findDotnetTargets, findJbTargets } from "../src/engines/dotnet-targets.js";
import type { EngineContext } from "../src/engines/types.js";

const context = (rootDirectory: string): EngineContext => ({
	rootDirectory,
	languages: ["csharp"],
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
});

describe("findDotnetTargets", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-targets-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns [] when the directory cannot be read", () => {
		expect(findDotnetTargets(context(path.join(tmpDir, "missing")))).toEqual([]);
	});

	it("prefers a single .sln over project files", () => {
		fs.writeFileSync(path.join(tmpDir, "App.sln"), "");
		fs.writeFileSync(path.join(tmpDir, "App.csproj"), "");
		expect(findDotnetTargets(context(tmpDir))).toEqual([path.join(tmpDir, "App.sln")]);
	});

	it("enumerates every .csproj when only a .slnx is present", () => {
		fs.writeFileSync(path.join(tmpDir, "App.slnx"), "");
		fs.mkdirSync(path.join(tmpDir, "Core"));
		fs.mkdirSync(path.join(tmpDir, "Cli"));
		fs.writeFileSync(path.join(tmpDir, "Core", "Core.csproj"), "");
		fs.writeFileSync(path.join(tmpDir, "Cli", "Cli.csproj"), "");
		const expected = [
			path.join(tmpDir, "Cli", "Cli.csproj"),
			path.join(tmpDir, "Core", "Core.csproj"),
		].sort();
		expect(findDotnetTargets(context(tmpDir)).sort()).toEqual(expected);
	});

	it("finds csproj files in subdirectories when no solution exists", () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "App.csproj"), "");
		expect(findDotnetTargets(context(tmpDir))).toEqual([path.join(tmpDir, "src", "App.csproj")]);
	});

	it("skips bin/obj/node_modules when enumerating", () => {
		fs.mkdirSync(path.join(tmpDir, "obj"));
		fs.writeFileSync(path.join(tmpDir, "obj", "Generated.csproj"), "");
		fs.writeFileSync(path.join(tmpDir, "App.csproj"), "");
		expect(findDotnetTargets(context(tmpDir))).toEqual([path.join(tmpDir, "App.csproj")]);
	});
});

describe("findJbTargets", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-jb-targets-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns [] when the directory cannot be read", () => {
		expect(findJbTargets(context(path.join(tmpDir, "missing")))).toEqual([]);
	});

	it("prefers a single .slnx solution over project files (jb loads .slnx natively)", () => {
		fs.writeFileSync(path.join(tmpDir, "App.slnx"), "");
		fs.mkdirSync(path.join(tmpDir, "Core"));
		fs.writeFileSync(path.join(tmpDir, "Core", "Core.csproj"), "");
		expect(findJbTargets(context(tmpDir))).toEqual([path.join(tmpDir, "App.slnx")]);
	});

	it("prefers a .sln over a .slnx when both are present", () => {
		fs.writeFileSync(path.join(tmpDir, "App.sln"), "");
		fs.writeFileSync(path.join(tmpDir, "App.slnx"), "");
		expect(findJbTargets(context(tmpDir))).toEqual([path.join(tmpDir, "App.sln")]);
	});

	it("falls back to every .csproj when no solution file exists", () => {
		fs.mkdirSync(path.join(tmpDir, "src"));
		fs.writeFileSync(path.join(tmpDir, "src", "App.csproj"), "");
		expect(findJbTargets(context(tmpDir))).toEqual([path.join(tmpDir, "src", "App.csproj")]);
	});
});

describe("dotnet target discovery honors .gitignore", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-gitignore-"));
		execFileSync("git", ["init", "-q"], { cwd: tmpDir, stdio: "ignore" });
		fs.writeFileSync(path.join(tmpDir, ".gitignore"), "ignored/\n");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("skips a .csproj under a gitignored directory", () => {
		fs.writeFileSync(path.join(tmpDir, "App.csproj"), "");
		fs.mkdirSync(path.join(tmpDir, "ignored"));
		fs.writeFileSync(path.join(tmpDir, "ignored", "Spike.csproj"), "");
		expect(findDotnetTargets(context(tmpDir))).toEqual([path.join(tmpDir, "App.csproj")]);
	});
});
