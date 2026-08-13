import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	hasManagedKimiRules,
	installKimi,
	resolveKimiPaths,
	uninstallKimi,
} from "../../src/hooks/install/kimi.js";
import { sentinelHash } from "../../src/hooks/io/sentinel.js";

let home: string;
let cwd: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cwd-"));
	vi.stubEnv("KIMI_CODE_HOME", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(cwd, { recursive: true, force: true });
});

const options = () => ({ home, cwd, scope: "global" as const });

const legacyHook = [
	"# aislop:begin kimi-hook v1",
	"[[hooks]]",
	'event = "PostToolUse"',
	'matcher = "Write"',
	'command = "aislop hook kimi"',
	"timeout = 15",
	"# aislop:end kimi-hook v1",
].join("\n");

const historicalRulesBody = "# aislop generated rules\n\nRun an older aislop workflow.\n";
const historicalRules = [
	`<!-- aislop:begin v1 hash=${sentinelHash(historicalRulesBody)} -->`,
	historicalRulesBody.trimEnd(),
	"<!-- aislop:end v1 -->",
].join("\n");

const expectModeBeforeReplacement = (
	targetPath: string,
	expectedMode: number,
	operation: () => void,
): void => {
	const renameSync = fs.renameSync;
	let observedReplacement = false;
	const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
		if (String(target) === targetPath) {
			observedReplacement = true;
			expect(fs.statSync(source).mode & 0o777).toBe(expectedMode);
		}
		renameSync(source, target);
	});
	try {
		operation();
	} finally {
		renameSpy.mockRestore();
	}
	expect(observedReplacement).toBe(true);
};

describe("installKimi", () => {
	it("writes rules to ~/.kimi-code/AGENTS.md without registering a runtime hook", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, "[thinking]\nenabled = true\n");

		const result = installKimi(options());
		const rules = resolveKimiPaths(options()).rules;

		expect(result.wrote).toEqual([rules]);
		expect(fs.readFileSync(rules, "utf-8")).toContain("aislop");
		expect(fs.readFileSync(rules, "utf-8")).toContain("without a runtime callback");
		expect(fs.readFileSync(rules, "utf-8")).not.toContain("aislop hook claude");
		expect(fs.readFileSync(rules, "utf-8")).not.toContain("nextSteps[]");
		expect(fs.readFileSync(configuration, "utf-8")).toBe("[thinking]\nenabled = true\n");
	});

	it("is idempotent", () => {
		installKimi(options());
		const rules = resolveKimiPaths(options()).rules;
		const first = fs.readFileSync(rules, "utf-8");

		const second = installKimi(options());

		expect(second.wrote).toHaveLength(0);
		expect(second.skipped).toContain(rules);
		expect(fs.readFileSync(rules, "utf-8")).toBe(first);
	});

	it("uses KIMI_CODE_HOME for global rules", () => {
		const kimiHome = path.join(home, "custom-kimi-home");
		vi.stubEnv("KIMI_CODE_HOME", kimiHome);

		const result = installKimi(options());
		const rules = resolveKimiPaths(options()).rules;

		expect(rules).toBe(path.join(kimiHome, "AGENTS.md"));
		expect(result.wrote).toContain(rules);
		expect(fs.existsSync(rules)).toBe(true);
	});

	it("removes the obsolete runtime hook while preserving unrelated configuration", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, `[thinking]\nenabled = true\n\n${legacyHook}\n`);

		const result = installKimi(options());

		expect(result.wrote).toContain(configuration);
		expect(fs.readFileSync(configuration, "utf-8")).toBe("[thinking]\nenabled = true\n");
	});

	it.runIf(process.platform !== "win32")(
		"preserves config.toml permissions while removing the obsolete runtime hook",
		() => {
			const configuration = path.join(home, ".kimi-code", "config.toml");
			fs.mkdirSync(path.dirname(configuration), { recursive: true });
			fs.writeFileSync(configuration, `[thinking]\nenabled = true\n\n${legacyHook}\n`);
			fs.chmodSync(configuration, 0o600);

			expectModeBeforeReplacement(configuration, 0o600, () => installKimi(options()));

			expect(fs.statSync(configuration).mode & 0o777).toBe(0o600);
		},
	);

	it("leaves config.toml untouched when migration is a dry run", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		const original = `[thinking]\nenabled = true\n\n${legacyHook}\n`;
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, original);
		if (process.platform !== "win32") fs.chmodSync(configuration, 0o600);

		const result = installKimi({ ...options(), dryRun: true });

		expect(result.planned).toContainEqual({
			path: configuration,
			summary: "remove obsolete Kimi PostToolUse hook",
		});
		expect(fs.readFileSync(configuration, "utf-8")).toBe(original);
		if (process.platform !== "win32") {
			expect(fs.statSync(configuration).mode & 0o777).toBe(0o600);
		}
	});

	it("removes its temporary config file when replacement fails", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		const original = `[thinking]\nenabled = true\n\n${legacyHook}\n`;
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, original);
		const renameSync = fs.renameSync;
		const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
			if (String(target) === configuration) throw new Error("simulate config rename failure");
			renameSync(source, target);
		});

		try {
			expect(() => installKimi(options())).toThrow("simulate config rename failure");
		} finally {
			renameSpy.mockRestore();
		}

		expect(fs.readFileSync(configuration, "utf-8")).toBe(original);
		expect(
			fs.readdirSync(path.dirname(configuration)).filter((name) => name.startsWith(".aislop-tmp-")),
		).toEqual([]);
	});

	it("does not remove a colliding temporary file it did not create", () => {
		installKimi(options());
		const configuration = path.join(home, ".kimi-code", "config.toml");
		const original = `[thinking]\nenabled = true\n\n${legacyHook}\n`;
		fs.writeFileSync(configuration, original);
		const randomValue = 0.123456789;
		const randomSuffix = randomValue.toString(36).slice(2, 10);
		const collidingPath = path.join(
			path.dirname(configuration),
			`.aislop-tmp-${process.pid}-${randomSuffix}`,
		);
		fs.writeFileSync(collidingPath, "unrelated temporary content\n");
		const randomSpy = vi.spyOn(Math, "random").mockReturnValue(randomValue);

		try {
			expect(() => installKimi(options())).toThrow(/EEXIST/);
		} finally {
			randomSpy.mockRestore();
		}

		expect(fs.readFileSync(collidingPath, "utf-8")).toBe("unrelated temporary content\n");
		expect(fs.readFileSync(configuration, "utf-8")).toBe(original);
	});

	it("preserves a marked legacy hook whose command was modified", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		const modifiedHook = legacyHook.replace(
			'command = "aislop hook kimi"',
			'command = "custom hook"',
		);
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, `${modifiedHook}\n`);

		installKimi(options());

		expect(fs.readFileSync(configuration, "utf-8")).toBe(`${modifiedHook}\n`);
	});

	it("upgrades an untouched older generated-rules fence", () => {
		const rules = resolveKimiPaths(options()).rules;
		const original = `# User rules\n\n${historicalRules}\n\n## User footer\n`;
		fs.mkdirSync(path.dirname(rules), { recursive: true });
		fs.writeFileSync(rules, original);

		expect(hasManagedKimiRules(original)).toBe(true);

		const result = installKimi(options());
		const updated = fs.readFileSync(rules, "utf-8");

		expect(result.wrote).toContain(rules);
		expect(updated).toContain("# User rules");
		expect(updated).toContain("## User footer");
		expect(updated).not.toContain(historicalRulesBody.trim());
		expect(hasManagedKimiRules(updated)).toBe(true);
	});

	it("does not overwrite a malformed managed-rules fence", () => {
		installKimi(options());
		const rules = resolveKimiPaths(options()).rules;
		const malformed = fs
			.readFileSync(rules, "utf-8")
			.replace(/hash=sha256:[^\s>]+/, "hash=sha256:00000000000000000000000000000000");
		fs.writeFileSync(rules, malformed);

		const result = installKimi(options());

		expect(result.skipped).toContain(rules);
		expect(fs.readFileSync(rules, "utf-8")).toBe(malformed);
	});

	it("does not overwrite an invalid fence before a valid managed fence", () => {
		installKimi(options());
		const rules = resolveKimiPaths(options()).rules;
		const invalidFence = [
			"<!-- aislop:begin v1 hash=sha256:00000000000000000000000000000000 -->",
			"# User-owned rules",
			"<!-- aislop:end v1 -->",
			"",
		].join("\n");
		const mixed = `${invalidFence}${fs.readFileSync(rules, "utf-8")}`;
		fs.writeFileSync(rules, mixed);

		const result = installKimi(options());

		expect(result.skipped).toContain(rules);
		expect(fs.readFileSync(rules, "utf-8")).toBe(mixed);
	});
});

describe("uninstallKimi", () => {
	it("removes the rules file it installed without changing config.toml", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, "[thinking]\nenabled = true\n");
		installKimi(options());
		const rules = resolveKimiPaths(options()).rules;

		const result = uninstallKimi(options());

		expect(result.removed).toContain(rules);
		expect(fs.existsSync(rules)).toBe(false);
		expect(fs.readFileSync(configuration, "utf-8")).toBe("[thinking]\nenabled = true\n");
	});

	it("removes an untouched older generated-rules fence", () => {
		const rules = resolveKimiPaths(options()).rules;
		fs.mkdirSync(path.dirname(rules), { recursive: true });
		fs.writeFileSync(rules, `${historicalRules}\n`);

		const result = uninstallKimi(options());

		expect(result.removed).toContain(rules);
		expect(fs.existsSync(rules)).toBe(false);
	});

	it("preserves pre-existing user rules", () => {
		const rules = resolveKimiPaths(options()).rules;
		fs.mkdirSync(path.dirname(rules), { recursive: true });
		fs.writeFileSync(rules, "# User rules\n");
		installKimi(options());

		uninstallKimi(options());

		expect(fs.readFileSync(rules, "utf-8")).toBe("# User rules\n");
	});

	it("removes an obsolete runtime-only configuration", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, `${legacyHook}\n`);

		const result = uninstallKimi(options());

		expect(result.removed).toContain(configuration);
		expect(fs.existsSync(configuration)).toBe(false);
	});

	it.runIf(process.platform !== "win32")(
		"preserves config.toml permissions while removing the obsolete runtime hook",
		() => {
			const configuration = path.join(home, ".kimi-code", "config.toml");
			fs.mkdirSync(path.dirname(configuration), { recursive: true });
			fs.writeFileSync(configuration, `[thinking]\nenabled = true\n\n${legacyHook}\n`);
			fs.chmodSync(configuration, 0o600);

			expectModeBeforeReplacement(configuration, 0o600, () => uninstallKimi(options()));

			expect(fs.statSync(configuration).mode & 0o777).toBe(0o600);
		},
	);

	it("leaves config.toml untouched when migration is a dry run", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		const original = `[thinking]\nenabled = true\n\n${legacyHook}\n`;
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, original);
		if (process.platform !== "win32") fs.chmodSync(configuration, 0o600);

		const result = uninstallKimi({ ...options(), dryRun: true });

		expect(result.removed).toContain(configuration);
		expect(fs.readFileSync(configuration, "utf-8")).toBe(original);
		if (process.platform !== "win32") {
			expect(fs.statSync(configuration).mode & 0o777).toBe(0o600);
		}
	});

	it("preserves a marked legacy hook whose command was modified", () => {
		const configuration = path.join(home, ".kimi-code", "config.toml");
		const modifiedHook = legacyHook.replace(
			'command = "aislop hook kimi"',
			'command = "custom hook"',
		);
		fs.mkdirSync(path.dirname(configuration), { recursive: true });
		fs.writeFileSync(configuration, `${modifiedHook}\n`);

		const result = uninstallKimi(options());

		expect(result.removed).toEqual([]);
		expect(fs.readFileSync(configuration, "utf-8")).toBe(`${modifiedHook}\n`);
	});

	it.each([
		[
			"wrong hash",
			(content: string) =>
				content.replace(/hash=sha256:[^\s>]+/, "hash=sha256:00000000000000000000000000000000"),
		],
		[
			"mismatched marker version",
			(content: string) => content.replace("<!-- aislop:end v1 -->", "<!-- aislop:end v2 -->"),
		],
		[
			"modified body",
			(content: string) => content.replace(/^# aislop.*agent instructions$/m, "# User-owned rules"),
		],
	])("preserves a rules fence with a %s", (_label, modify) => {
		installKimi(options());
		const rules = resolveKimiPaths(options()).rules;
		const modified = modify(fs.readFileSync(rules, "utf-8"));
		fs.writeFileSync(rules, modified);

		expect(hasManagedKimiRules(modified)).toBe(false);
		const result = uninstallKimi(options());

		expect(result.removed).not.toContain(rules);
		expect(fs.readFileSync(rules, "utf-8")).toBe(modified);
	});
});
