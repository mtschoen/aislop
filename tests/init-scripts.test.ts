import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const windowsIt = it.skipIf(process.platform !== "win32");

let temporaryRoot: string;
let binaryDirectory: string;
let callLog: string;

beforeEach(() => {
	temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-init-scripts-"));
	binaryDirectory = path.join(temporaryRoot, "bin");
	callLog = path.join(temporaryRoot, "calls.log");
	fs.mkdirSync(binaryDirectory);
	fs.writeFileSync(callLog, "");
});

afterEach(() => {
	fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

const writeFake = (name: string, contents: string): void => {
	fs.writeFileSync(path.join(binaryDirectory, name), `${contents}\n`, { mode: 0o755 });
};

const installStandardFakes = (options: { aislop?: boolean; provisioner?: boolean } = {}): void => {
	writeFake(
		"node",
		`#!/usr/bin/env bash
if [ "$1" = "--version" ]; then printf 'v22.18.0\\n'; exit 0; fi
if [ "$(basename "\${1:-}" 2>/dev/null)" = "cli.js" ]; then
	shift
	printf 'aislop %s\\n' "$*" >>"$FAKE_LOG"
	if [ "$1" = "--version" ]; then printf '0.16.0\\n'; exit 0; fi
	if [ "$1" = "hook" ]; then
		mkdir -p .claude
		printf 'rules\\n' >.claude/AISLOP.md
		printf '@AISLOP.md\\n' >.claude/CLAUDE.md
		printf '{}\\n' >.claude/settings.json
	fi
	exit 0
fi`,
	);
	writeFake(
		"pnpm",
		`#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >>"$FAKE_LOG"
if [ "$1" = "install" ]; then mkdir -p node_modules; fi
if [ "$1" = "build" ]; then mkdir -p dist; printf 'export {};\\n' >dist/cli.js; fi`,
	);
	writeFake(
		"git",
		`#!/usr/bin/env bash
printf 'git %s\n' "$*" >>"$FAKE_LOG"
if [ "$1" = "diff" ] && [ "$2" = "--quiet" ]; then exit "\${FAKE_GIT_DIFF:-0}"; fi
if [ "$1" = "diff" ] && [ "$2" = "--cached" ]; then exit "\${FAKE_GIT_CACHED_DIFF:-0}"; fi
if [ "$1" = "status" ]; then printf '%s\n' "\${FAKE_GIT_STATUS:-}"; fi`,
	);
	if (options.aislop !== false) {
		writeFake(
			"aislop",
			`#!/usr/bin/env bash
if [ "$1" = "--version" ]; then printf '0.16.0\n'; exit 0; fi
printf 'aislop %s\n' "$*" >>"$FAKE_LOG"
if [ "$1" = "hook" ]; then
	mkdir -p .claude
	printf 'rules\n' >.claude/AISLOP.md
	printf '@AISLOP.md\n' >.claude/CLAUDE.md
	printf '{}\n' >.claude/settings.json
fi`,
		);
	}
	if (options.provisioner !== false) {
		writeFake(
			"schoen-lab-onboard",
			`#!/usr/bin/env bash
printf 'schoen-lab-onboard %s\n' "$*" >>"$FAKE_LOG"`,
		);
	}
};

// The documented fleet install puts the repository wrapper on PATH, so `aislop`
// resolves only once the checkout being restored has a dist/cli.js.
const installCheckoutBackedAislop = (): void => {
	installStandardFakes({ aislop: false });
	const wrapper = path.join(projectRoot, "scripts", "wrappers", "aislop");
	expect(fs.existsSync(wrapper), "scripts/wrappers/aislop must exist").toBe(true);
	fs.copyFileSync(wrapper, path.join(binaryDirectory, "aislop"));
	fs.chmodSync(path.join(binaryDirectory, "aislop"), 0o755);
};

const runBashInit = (arguments_: string[] = [], environment: NodeJS.ProcessEnv = {}) => {
	const source = path.join(projectRoot, "init.sh");
	expect(fs.existsSync(source), "init.sh must exist").toBe(true);
	const script = path.join(temporaryRoot, "init.sh");
	fs.copyFileSync(source, script);
	return spawnSync("bash", [script, ...arguments_], {
		cwd: temporaryRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${binaryDirectory}:/usr/bin:/bin`,
			FAKE_LOG: callLog,
			...environment,
		},
	});
};

const calls = (): string[] => fs.readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean);

describe("post-clean init contracts", () => {
	it("ships all three platform entry points", () => {
		for (const file of ["init.sh", "init.ps1", "init.bat"]) {
			expect(fs.existsSync(path.join(projectRoot, file)), `${file} must exist`).toBe(true);
		}
		const powerShell = fs.readFileSync(path.join(projectRoot, "init.ps1"), "utf8");
		const batch = fs.readFileSync(path.join(projectRoot, "init.bat"), "utf8");
		expect(powerShell).toContain("[switch]$Build");
		expect(powerShell).toContain("diff --cached --quiet");
		expect(powerShell).toContain("apply auto-memory");
		// The checkout-backed wrapper needs dist/cli.js, so the requested build
		// has to run before the hook install step on every platform.
		const powerShellBuild = powerShell.indexOf("Building aislop...");
		const powerShellHook = powerShell.indexOf("Restoring agent instruction files...");
		expect(powerShellBuild).toBeGreaterThan(-1);
		expect(powerShellHook).toBeGreaterThan(-1);
		expect(powerShellBuild).toBeLessThan(powerShellHook);
		expect(batch).toContain("where pwsh");
		expect(batch).toContain("where powershell");
		expect(batch).toContain('-File "%~dp0init.ps1" %*');
	});

	it("pins shell and batch line endings", () => {
		const attributes = fs.readFileSync(path.join(projectRoot, ".gitattributes"), "utf8");
		expect(attributes).toMatch(/^\*\.sh text eol=lf$/m);
		expect(attributes).toMatch(/^\*\.bat text eol=crlf$/m);
	});

	it("keeps the maintenance breadcrumb trackable", () => {
		const ignore = fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
		expect(ignore).not.toMatch(/^\.maintenance\.json$/m);
		expect(ignore).toMatch(/^!\.maintenance\.json$/m);
	});
});

describe.skipIf(process.platform === "win32")("bash post-clean init", () => {
	it("restores dependencies and agent files without building", () => {
		installStandardFakes();
		const result = runBashInit();
		const output = result.stdout + result.stderr;

		expect(result.status, output).toBe(0);
		expect(calls()).toContain("pnpm install --frozen-lockfile --ignore-scripts");
		expect(calls()).toContain("aislop hook install claude --project");
		expect(calls()).toContain("schoen-lab-onboard apply auto-memory");
		expect(calls()).not.toContain("pnpm build");
		expect(fs.existsSync(path.join(temporaryRoot, "node_modules"))).toBe(true);
		expect(fs.existsSync(path.join(temporaryRoot, ".claude", "AISLOP.md"))).toBe(true);
	});

	it("builds only when requested", () => {
		installStandardFakes();
		const result = runBashInit(["--build"]);

		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(calls()).toContain("pnpm build");
	});

	it("continues without optional aislop and provisioning tools", () => {
		installStandardFakes({ aislop: false, provisioner: false });
		const result = runBashInit();
		const output = result.stdout + result.stderr;

		expect(result.status, output).toBe(0);
		expect(output).toContain("Skipping agent instruction files");
		expect(output).toContain("aislop");
		expect(calls()).not.toContain("aislop hook install claude --project");
		expect(calls().some((call) => call.startsWith("schoen-lab"))).toBe(false);
	});

	it.each([
		{
			name: "line-ending-only status",
			ordinary: 0,
			cached: 0,
			status: " M .claude/settings.json",
			restored: true,
		},
		{
			name: "ordinary content change",
			ordinary: 1,
			cached: 0,
			status: " M .claude/settings.json",
			restored: false,
		},
		{
			name: "staged content change",
			ordinary: 0,
			cached: 1,
			status: "M  .claude/settings.json",
			restored: false,
		},
		{ name: "clean settings", ordinary: 0, cached: 0, status: "", restored: false },
	])("guards settings restoration for $name", ({ ordinary, cached, status, restored }) => {
		installStandardFakes();
		const result = runBashInit([], {
			FAKE_GIT_DIFF: String(ordinary),
			FAKE_GIT_CACHED_DIFF: String(cached),
			FAKE_GIT_STATUS: status,
		});

		expect(result.status, result.stdout + result.stderr).toBe(0);
		expect(calls().some((call) => call.startsWith("git restore "))).toBe(restored);
	});
});

describe.skipIf(process.platform === "win32")(
	"bash post-clean init with a checkout-backed aislop",
	() => {
		it("builds before the hook step so --build restores agent files", () => {
			installCheckoutBackedAislop();
			const result = runBashInit(["--build"], { AISLOP_HOME: temporaryRoot });
			const output = result.stdout + result.stderr;
			const logged = calls();

			expect(result.status, output).toBe(0);
			expect(output).not.toContain("has no build");
			expect(logged).toContain("pnpm build");
			expect(logged).toContain("aislop hook install claude --project");
			expect(logged.indexOf("pnpm build")).toBeLessThan(
				logged.indexOf("aislop hook install claude --project"),
			);
			expect(fs.existsSync(path.join(temporaryRoot, ".claude", "AISLOP.md"))).toBe(true);
		});

		it("reports an unbuilt checkout CLI instead of failing the restore", () => {
			installCheckoutBackedAislop();
			const result = runBashInit([], { AISLOP_HOME: temporaryRoot });
			const output = result.stdout + result.stderr;

			expect(result.status, output).toBe(0);
			expect(output).toContain("on PATH, not runnable yet");
			expect(output).toContain(
				"Skipping agent instruction files: aislop is on PATH but not runnable.",
			);
			expect(output).toContain("aislop (agent files only) - on PATH but not runnable");
			expect(output).not.toContain("has no build");
			expect(calls()).not.toContain("pnpm build");
			expect(calls()).not.toContain("aislop hook install claude --project");
			expect(fs.existsSync(path.join(temporaryRoot, ".claude"))).toBe(false);
		});
	},
);

describe("cmd post-clean init forwarder", () => {
	windowsIt("forwards arguments and returns the PowerShell exit status", () => {
		const source = path.join(projectRoot, "init.bat");
		expect(fs.existsSync(source), "init.bat must exist").toBe(true);
		fs.copyFileSync(source, path.join(temporaryRoot, "init.bat"));
		writeFake(
			"pwsh.cmd",
			`@echo off
echo %*>>"%FAKE_LOG%"
exit /b 23`,
		);

		const result = spawnSync("cmd.exe", ["/d", "/c", "init.bat", "-Build"], {
			cwd: temporaryRoot,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${binaryDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
				FAKE_LOG: callLog,
			},
		});

		expect(result.status, result.stdout + result.stderr).toBe(23);
		expect(calls().join("\n")).toContain("-Build");
	});
});
