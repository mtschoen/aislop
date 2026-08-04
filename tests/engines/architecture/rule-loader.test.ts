import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
	vi.spyOn(fs, "existsSync");
	vi.spyOn(fs, "readFileSync");

	vi.mocked(fs.existsSync).mockReset();
	vi.mocked(fs.readFileSync).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("loadArchitectureRules", () => {
	it("returns [] when file does not exist", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		const { loadArchitectureRules } = await import("../../../src/engines/architecture/rule-loader.js");

		expect(loadArchitectureRules("/repo/missing.yml")).toEqual([]);
		const fileCalls = vi
			.mocked(fs.readFileSync)
			.mock.calls.filter(([path]) => String(path).startsWith("/repo/"));
		expect(fileCalls).toEqual([]);
	});

	it("returns [] when file parse is invalid", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue("{");
		const { loadArchitectureRules } = await import("../../../src/engines/architecture/rule-loader.js");

		expect(loadArchitectureRules("/repo/bad.yml")).toEqual([]);
		expect(
			vi
				.mocked(fs.readFileSync)
				.mock.calls.find(([path]) => String(path) === "/repo/bad.yml"),
		).toBeDefined();
	});

	it("loads rules from YAML when present", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.readFileSync).mockReturnValue(
			`
rules:
  - name: no-react
    type: forbid_import
    match: react
    severity: warning
`,
		);
		const { loadArchitectureRules } = await import("../../../src/engines/architecture/rule-loader.js");

		expect(loadArchitectureRules("/repo/arch.yml")).toEqual([
			{
				name: "no-react",
				type: "forbid_import",
				match: "react",
				severity: "warning",
			},
		]);
		expect(
			vi
				.mocked(fs.readFileSync)
				.mock.calls.find(([path]) => String(path) === "/repo/arch.yml"),
		).toBeDefined();
	});
});
