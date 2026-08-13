import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAntigravity, uninstallAntigravity } from "../../src/hooks/install/antigravity.js";
import { installCline, uninstallCline } from "../../src/hooks/install/cline.js";
import { installCodex, resolveCodexPaths, uninstallCodex } from "../../src/hooks/install/codex.js";
import {
	installCopilot,
	resolveCopilotPaths,
	uninstallCopilot,
} from "../../src/hooks/install/copilot.js";
import { installKilocode, uninstallKilocode } from "../../src/hooks/install/kilocode.js";
import { installWindsurf, uninstallWindsurf } from "../../src/hooks/install/windsurf.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
	vi.stubEnv("CODEX_HOME", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

describe("installCodex", () => {
	it("writes ~/.codex/hooks.json and AGENTS.md globally", () => {
		const opts = { home, cwd, scope: "global" as const };
		const result = installCodex(opts);
		const paths = resolveCodexPaths(opts);
		expect(result.wrote).toContain(paths.hooks);
		expect(fs.readFileSync(paths.rules, "utf-8")).toContain("<!-- aislop:begin");

		const hooks = JSON.parse(fs.readFileSync(paths.hooks, "utf-8"));
		expect(hooks.hooks.PostToolUse).toHaveLength(1);
		expect(hooks.hooks.PostToolUse[0].matcher).toBe("apply_patch");
		expect(hooks.hooks.PostToolUse[0].hooks[0]).toEqual({
			type: "command",
			command: "aislop hook codex",
			timeout: 15,
			statusMessage: "Running aislop [managed:v1]",
		});
	});

	it("writes cwd/AGENTS.md when project scope", () => {
		const opts = { home, cwd, scope: "project" as const };
		installCodex(opts);
		const paths = resolveCodexPaths(opts);
		expect(paths.rules).toBe(path.join(cwd, "AGENTS.md"));
		expect(paths.hooks).toBe(path.join(cwd, ".codex", "hooks.json"));
		expect(fs.existsSync(paths.rules)).toBe(true);
		expect(fs.existsSync(paths.hooks)).toBe(true);
	});

	it("uses CODEX_HOME for global hooks and rules", () => {
		const codexHome = path.join(home, "custom-codex-home");
		vi.stubEnv("CODEX_HOME", codexHome);
		const opts = { home, cwd, scope: "global" as const };

		installCodex(opts);

		const paths = resolveCodexPaths(opts);
		expect(paths.hooks).toBe(path.join(codexHome, "hooks.json"));
		expect(paths.rules).toBe(path.join(codexHome, "AGENTS.md"));
		expect(fs.existsSync(paths.hooks)).toBe(true);
		expect(fs.existsSync(paths.rules)).toBe(true);
	});

	it("preserves unrelated PostToolUse hooks", () => {
		const opts = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(opts).hooks;
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(
			hooksPath,
			JSON.stringify({
				hooks: {
					PostToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "other-hook" }] }],
				},
			}),
		);

		installCodex(opts);
		uninstallCodex(opts);
		const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
		expect(hooks.hooks.PostToolUse).toEqual([
			{ matcher: "shell", hooks: [{ type: "command", command: "other-hook" }] },
		]);
	});

	it("preserves a user-authored group that invokes the same callback with different settings", () => {
		const opts = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(opts).hooks;
		const userGroup = {
			matcher: "shell",
			hooks: [{ type: "command", command: "aislop hook codex", timeout: 60 }],
		};
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(hooksPath, JSON.stringify({ hooks: { PostToolUse: [userGroup] } }));

		installCodex(opts);
		uninstallCodex(opts);

		const hooks = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
		expect(hooks.hooks.PostToolUse).toEqual([userGroup]);
	});

	it("refuses to overwrite malformed hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(opts).hooks;
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(hooksPath, "{ malformed");

		expect(() => installCodex(opts)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(hooksPath, "utf-8")).toBe("{ malformed");
	});

	it("refuses to overwrite an empty hooks.json", () => {
		const options = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(options).hooks;
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(hooksPath, "");

		expect(() => installCodex(options)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(hooksPath, "utf-8")).toBe("");
		expect(fs.existsSync(resolveCodexPaths(options).rules)).toBe(false);
	});

	it.each([
		["an array-valued hooks property", { hooks: [] }],
		["a non-array PostToolUse property", { hooks: { PostToolUse: { matcher: "apply_patch" } } }],
	])("refuses to overwrite %s", (_label, configuration) => {
		const options = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(options).hooks;
		const original = `${JSON.stringify(configuration, null, 2)}\n`;
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(hooksPath, original);

		expect(() => installCodex(options)).toThrow(/Cannot update/);
		expect(fs.readFileSync(hooksPath, "utf-8")).toBe(original);
	});
});

describe("P3 project-only installers", () => {
	it("Windsurf writes .windsurfrules in project scope", () => {
		installWindsurf({ home, cwd, scope: "project" });
		expect(fs.existsSync(path.join(cwd, ".windsurfrules"))).toBe(true);
	});

	it("Windsurf refuses global scope", () => {
		const result = installWindsurf({ home, cwd, scope: "global" });
		expect(result.wrote).toHaveLength(0);
		expect(result.planned[0].summary).toContain("--project");
	});

	it("Cline writes .clinerules and .roo/rules/aislop.md", () => {
		const result = installCline({ home, cwd, scope: "project" });
		expect(fs.existsSync(path.join(cwd, ".clinerules"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".roo", "rules", "aislop.md"))).toBe(true);
		expect(result.wrote).toHaveLength(2);
	});

	it("Kilocode writes .kilocode/rules/aislop-rules.md", () => {
		installKilocode({ home, cwd, scope: "project" });
		expect(fs.existsSync(path.join(cwd, ".kilocode", "rules", "aislop-rules.md"))).toBe(true);
	});

	it("Antigravity writes .agents/rules/antigravity-aislop-rules.md", () => {
		installAntigravity({ home, cwd, scope: "project" });
		expect(fs.existsSync(path.join(cwd, ".agents", "rules", "antigravity-aislop-rules.md"))).toBe(
			true,
		);
	});

	it("Copilot writes .github/copilot-instructions.md", () => {
		const result = installCopilot({ home, cwd, scope: "project" });
		const p = resolveCopilotPaths({ home, cwd, scope: "project" }).rules;
		expect(fs.existsSync(p)).toBe(true);
		expect(result.wrote).toContain(p);
	});
});

describe("rules-only uninstall reversibility", () => {
	it("uninstallCodex removes the runtime hook and AGENTS.md it wrote", () => {
		const opts = { home, cwd, scope: "global" as const };
		installCodex(opts);
		uninstallCodex(opts);
		const paths = resolveCodexPaths(opts);
		expect(fs.existsSync(paths.rules)).toBe(false);
		expect(fs.existsSync(paths.hooks)).toBe(false);
	});

	it("refuses to remove malformed hooks.json", () => {
		const opts = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(opts).hooks;
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(hooksPath, "{ malformed");

		expect(() => uninstallCodex(opts)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(hooksPath, "utf-8")).toBe("{ malformed");
	});

	it("refuses to uninstall through an empty hooks.json", () => {
		const options = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(options).hooks;
		installCodex(options);
		fs.writeFileSync(hooksPath, "");

		expect(() => uninstallCodex(options)).toThrow(/invalid JSON/);
		expect(fs.readFileSync(hooksPath, "utf-8")).toBe("");
		expect(fs.existsSync(resolveCodexPaths(options).rules)).toBe(true);
	});

	it.each([
		["an array-valued hooks property", { hooks: [] }],
		["a non-array PostToolUse property", { hooks: { PostToolUse: { matcher: "apply_patch" } } }],
	])("refuses to remove from %s", (_label, configuration) => {
		const options = { home, cwd, scope: "global" as const };
		const hooksPath = resolveCodexPaths(options).hooks;
		const original = `${JSON.stringify(configuration, null, 2)}\n`;
		fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
		fs.writeFileSync(hooksPath, original);

		expect(() => uninstallCodex(options)).toThrow(/Cannot update/);
		expect(fs.readFileSync(hooksPath, "utf-8")).toBe(original);
	});

	it("uninstallWindsurf removes .windsurfrules", () => {
		const opts = { home, cwd, scope: "project" as const };
		installWindsurf(opts);
		uninstallWindsurf(opts);
		expect(fs.existsSync(path.join(cwd, ".windsurfrules"))).toBe(false);
	});

	it("uninstallCline removes both .clinerules and .roo rules", () => {
		const opts = { home, cwd, scope: "project" as const };
		installCline(opts);
		uninstallCline(opts);
		expect(fs.existsSync(path.join(cwd, ".clinerules"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".roo", "rules", "aislop.md"))).toBe(false);
	});

	it("uninstallKilocode removes the rules file", () => {
		const opts = { home, cwd, scope: "project" as const };
		installKilocode(opts);
		uninstallKilocode(opts);
		expect(fs.existsSync(path.join(cwd, ".kilocode", "rules", "aislop-rules.md"))).toBe(false);
	});

	it("uninstallAntigravity removes the rules file", () => {
		const opts = { home, cwd, scope: "project" as const };
		installAntigravity(opts);
		uninstallAntigravity(opts);
		expect(fs.existsSync(path.join(cwd, ".agents", "rules", "antigravity-aislop-rules.md"))).toBe(
			false,
		);
	});

	it("uninstallCopilot removes .github/copilot-instructions.md", () => {
		const opts = { home, cwd, scope: "project" as const };
		installCopilot(opts);
		uninstallCopilot(opts);
		expect(fs.existsSync(resolveCopilotPaths(opts).rules)).toBe(false);
	});

	it("installers are idempotent — second run writes nothing", () => {
		const opts = { home, cwd, scope: "project" as const };
		installWindsurf(opts);
		const second = installWindsurf(opts);
		expect(second.wrote).toHaveLength(0);
	});
});
