import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineContext } from "../../../src/engines/types.js";

const { checkRulesMock } = vi.hoisted(() => ({ checkRulesMock: vi.fn() }));
const { loadArchitectureRulesMock } = vi.hoisted(() => ({ loadArchitectureRulesMock: vi.fn() }));

vi.mock("../../../src/engines/architecture/matchers.js", () => ({
	checkRules: checkRulesMock,
}));
vi.mock("../../../src/engines/architecture/rule-loader.js", () => ({
	loadArchitectureRules: loadArchitectureRulesMock,
}));

const context: EngineContext = {
	rootDirectory: "/repo",
	languages: ["typescript"],
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
	},
};

beforeEach(() => {
	checkRulesMock.mockReset();
	loadArchitectureRulesMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("architectureEngine", () => {
	it("skips when no architecture rules file is configured", async () => {
		const { architectureEngine } = await import("../../../src/engines/architecture/index.js");
		const result = await architectureEngine.run(context);

		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("No architecture rules configured");
		expect(checkRulesMock).not.toHaveBeenCalled();
	});

	it("skips when configured rule file contains no entries", async () => {
		loadArchitectureRulesMock.mockReturnValue([]);
		const { architectureEngine } = await import("../../../src/engines/architecture/index.js");

		const result = await architectureEngine.run({
			...context,
			config: { ...context.config, architectureRulesPath: "/repo/.aislop-architecture.yml" },
		});

		expect(result.skipped).toBe(true);
		expect(result.skipReason).toBe("No rules found in rules file");
		expect(loadArchitectureRulesMock).toHaveBeenCalledWith("/repo/.aislop-architecture.yml");
	});

	it("passes loaded rules to the matcher and returns findings", async () => {
		const rule = {
			name: "no-react",
			type: "forbid_import" as const,
			match: "react",
			severity: "warning" as const,
		};
		loadArchitectureRulesMock.mockReturnValue([rule]);
		checkRulesMock.mockResolvedValue([{ engine: "architecture", rule: "arch/no-react", filePath: "src/a.ts" }]);

		const { architectureEngine } = await import("../../../src/engines/architecture/index.js");
		const result = await architectureEngine.run({
			...context,
			config: { ...context.config, architectureRulesPath: "/repo/architecture.yml" },
		});

		expect(checkRulesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				...context,
				config: expect.objectContaining({
					architectureRulesPath: "/repo/architecture.yml",
				}),
			}),
			[rule],
		);
		expect(result.skipped).toBe(false);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toMatchObject({ filePath: "src/a.ts", rule: "arch/no-react" });
	});
});
