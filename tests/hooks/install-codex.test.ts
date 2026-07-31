import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCodex, resolveCodexPaths, uninstallCodex } from "../../src/hooks/install/codex.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-codex-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-codex-cwd-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

const globalOptions = () => ({ home, cwd, scope: "global" as const });
const projectOptions = () => ({ home, cwd, scope: "project" as const });

interface HookEntry {
	type: string;
	command: string;
}

interface HookGroup {
	matcher?: string;
	hooks: HookEntry[];
}

interface HookFile {
	hooks: Record<string, HookGroup[]>;
	topLevel?: boolean;
}

const readHooks = (options = globalOptions()): HookFile => {
	const hooksPath = resolveCodexPaths(options).hooks;
	return JSON.parse(fs.readFileSync(hooksPath, "utf-8")) as HookFile;
};

describe("installCodex", () => {
	it("writes the documented global PostToolUse hook shape", () => {
		const result = installCodex(globalOptions());
		const paths = resolveCodexPaths(globalOptions());

		expect(paths.hooks).toBe(path.join(home, ".codex", "hooks.json"));
		expect(result.wrote).toContain(paths.hooks);
		expect(readHooks().hooks.PostToolUse).toEqual([
			{
				matcher: "Edit|Write",
				hooks: [{ type: "command", command: "aislop hook codex" }],
			},
		]);
		expect(readHooks().hooks.Stop).toBeUndefined();
		expect(fs.readFileSync(paths.hooks, "utf-8")).not.toContain("__aislop");
	});

	it("writes project hooks under cwd/.codex", () => {
		installCodex(projectOptions());
		const paths = resolveCodexPaths(projectOptions());

		expect(paths.hooks).toBe(path.join(cwd, ".codex", "hooks.json"));
		expect(fs.existsSync(paths.hooks)).toBe(true);
		expect(paths.rules).toBe(path.join(cwd, "AGENTS.md"));
	});

	it("adds Stop only when the quality gate is enabled", () => {
		installCodex({ ...globalOptions(), qualityGate: true });

		expect(readHooks().hooks.Stop).toEqual([
			{ hooks: [{ type: "command", command: "aislop hook codex --stop" }] },
		]);
	});

	it("removes only the managed Stop group when reinstalled without the quality gate", () => {
		installCodex({ ...globalOptions(), qualityGate: true });
		const paths = resolveCodexPaths(globalOptions());
		const current = readHooks();
		current.hooks.Stop.push({ hooks: [{ type: "command", command: "keep-stop" }] });
		fs.writeFileSync(paths.hooks, `${JSON.stringify(current, null, 2)}\n`);

		installCodex(globalOptions());

		expect(readHooks().hooks.Stop).toEqual([
			{ hooks: [{ type: "command", command: "keep-stop" }] },
		]);
	});

	it("preserves unrelated hooks and is idempotent", () => {
		const paths = resolveCodexPaths(globalOptions());
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		fs.writeFileSync(
			paths.hooks,
			`${JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-post" }] }] }, topLevel: true }, null, 2)}\n`,
		);

		installCodex(globalOptions());
		const second = installCodex(globalOptions());

		expect(readHooks().topLevel).toBe(true);
		expect(readHooks().hooks.PostToolUse).toHaveLength(2);
		expect(readHooks().hooks.PostToolUse[0].hooks[0].command).toBe("keep-post");
		expect(second.wrote).toHaveLength(0);
	});

	it("plans both files without writing during a dry run", () => {
		const result = installCodex({ ...globalOptions(), dryRun: true });
		const paths = resolveCodexPaths(globalOptions());

		expect(result.planned.map((operation) => operation.path)).toEqual([paths.hooks, paths.rules]);
		expect(fs.existsSync(paths.hooks)).toBe(false);
		expect(fs.existsSync(paths.rules)).toBe(false);
	});

	it("recovers malformed hook JSON", () => {
		const paths = resolveCodexPaths(globalOptions());
		fs.mkdirSync(path.dirname(paths.hooks), { recursive: true });
		fs.writeFileSync(paths.hooks, "not json\n");

		installCodex(globalOptions());

		expect(readHooks().hooks.PostToolUse[0].hooks[0].command).toBe("aislop hook codex");
	});

	it("preserves a global AGENTS.md symlink and updates its target", () => {
		const paths = resolveCodexPaths(globalOptions());
		const target = path.join(home, "AGENTS.md");
		fs.mkdirSync(path.dirname(paths.rules), { recursive: true });
		fs.writeFileSync(target, "# User rules\n");
		fs.symlinkSync(target, paths.rules);

		installCodex(globalOptions());

		expect(fs.lstatSync(paths.rules).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf-8")).toContain("# User rules");
		expect(fs.readFileSync(target, "utf-8")).toContain("<!-- aislop:begin");
	});
});

describe("uninstallCodex", () => {
	it("removes managed hooks and rules while preserving unrelated content", () => {
		const paths = resolveCodexPaths(globalOptions());
		fs.mkdirSync(path.dirname(paths.rules), { recursive: true });
		fs.writeFileSync(paths.rules, "# User rules\n");
		installCodex({ ...globalOptions(), qualityGate: true });
		const current = readHooks();
		current.hooks.PostToolUse.unshift({
			matcher: "Bash",
			hooks: [{ type: "command", command: "keep-post" }],
		});
		fs.writeFileSync(paths.hooks, `${JSON.stringify(current, null, 2)}\n`);

		uninstallCodex(globalOptions());

		expect(readHooks().hooks.PostToolUse).toEqual([
			{ matcher: "Bash", hooks: [{ type: "command", command: "keep-post" }] },
		]);
		expect(readHooks().hooks.Stop).toBeUndefined();
		expect(fs.readFileSync(paths.rules, "utf-8")).toBe("# User rules\n");
	});

	it("keeps a global rules symlink and removes only the fenced target content", () => {
		const paths = resolveCodexPaths(globalOptions());
		const target = path.join(home, "AGENTS.md");
		fs.mkdirSync(path.dirname(paths.rules), { recursive: true });
		fs.writeFileSync(target, "# User rules\n");
		fs.symlinkSync(target, paths.rules);
		installCodex(globalOptions());

		uninstallCodex(globalOptions());

		expect(fs.lstatSync(paths.rules).isSymbolicLink()).toBe(true);
		expect(fs.readFileSync(target, "utf-8")).toBe("# User rules\n");
	});

	it("deletes files created solely by aislop", () => {
		const paths = resolveCodexPaths(globalOptions());
		installCodex(globalOptions());

		uninstallCodex(globalOptions());

		expect(fs.existsSync(paths.hooks)).toBe(false);
		expect(fs.existsSync(paths.rules)).toBe(false);
	});
});
