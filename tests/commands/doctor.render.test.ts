import { describe, expect, it, vi } from "vitest";
import {
	buildDoctorRender,
	type DoctorEngineRow,
	planAiSlopForTest,
	planFormatForTest,
	planLintForTest,
	planSecurityForTest,
} from "../../src/commands/doctor.js";
import * as tooling from "../../src/utils/tooling.js";
import { stripAnsi as strip } from "../helpers/ansi.js";

describe("doctor render", () => {
	it("shows each engine with its tool and an 'all ready' footer", () => {
		const rows: DoctorEngineRow[] = [
			{ engine: "Formatting", tool: "biome (bundled)", status: "ok" },
			{ engine: "Linting", tool: "oxlint (bundled)", status: "ok" },
			{ engine: "Security", tool: "pnpm audit", status: "ok" },
			{ engine: "Architecture", tool: "opt-in", status: "skipped", skipReason: "not configured" },
		];
		const out = strip(
			buildDoctorRender({
				projectName: "my-app",
				languageLabel: "typescript",
				rows,
				invocation: "aislop",
			}),
		);
		expect(out).toContain("Doctor report");
		expect(out).toContain("my-app");
		expect(out).toContain("typescript");
		expect(out).toContain("Engines");
		expect(out).toContain("✓ Formatting");
		expect(out).toMatch(/Status\s+ready/);
		expect(out).toContain("biome (bundled)");
		expect(out).toContain("· Architecture");
		expect(out).toMatch(/Reason\s+not configured/);
		expect(out).toMatch(/Ready\s+3 engines/);
		expect(out).toMatch(/Missing\s+0/);
		expect(out).toMatch(/Scan\s+aislop scan/);
		expect(out).not.toContain("◆ Formatting");
		expect(out).not.toContain("│");
		expect(out).not.toContain("└");
	});

	it("surfaces missing tools with remediation and an install hint", () => {
		const rows: DoctorEngineRow[] = [
			{ engine: "Formatting", tool: "ruff (system)", status: "ok" },
			{
				engine: "Linting",
				tool: "ruff not found",
				status: "missing",
				remediation: "Install: pipx install ruff",
			},
		];
		const out = strip(
			buildDoctorRender({
				projectName: "my-app",
				languageLabel: "python",
				rows,
				invocation: "aislop",
			}),
		);
		expect(out).toContain("✗ Linting");
		expect(out).toContain("ruff not found");
		expect(out).toMatch(/Fix\s+Install: pipx install ruff/);
		expect(out).toMatch(/Ready\s+1 engines/);
		expect(out).toMatch(/Missing\s+1/);
		expect(out).toMatch(/Action\s+Install the missing tools/);
		expect(out).toMatch(/Then\s+aislop scan/);
		expect(out).not.toContain("│");
		expect(out).not.toContain("└");
	});

	it("uses the invocation string in the next command", () => {
		const out = strip(
			buildDoctorRender({
				projectName: "my-app",
				languageLabel: "typescript",
				rows: [{ engine: "Formatting", tool: "biome (bundled)", status: "ok" }],
				invocation: "aislop",
			}),
		);
		expect(out).toMatch(/Scan\s+aislop scan/);
	});
});

describe("planLint csharp linter selection", () => {
	it("reports jb inspectcode when jb is installed", () => {
		const decision = planLintForTest({
			languages: ["csharp"],
			installedTools: { jb: true, roslynator: false },
			projectEvaluation: true,
		});
		expect(decision.tool).toBe("jb inspectcode (system)");
		expect(decision.status).toBe("ok");
	});

	it("reports roslynator when jb is absent but roslynator is installed", () => {
		const decision = planLintForTest({
			languages: ["csharp"],
			installedTools: { jb: false, roslynator: true },
			projectEvaluation: true,
		});
		expect(decision.tool).toBe("roslynator (system)");
		expect(decision.status).toBe("ok");
	});

	it("reports not-found with jb install hint when neither tool is installed", () => {
		const decision = planLintForTest({
			languages: ["csharp"],
			installedTools: { jb: false, roslynator: false },
			projectEvaluation: true,
		});
		expect(decision.status).toBe("missing");
		expect(decision.tool).toContain("not found");
		expect(decision.remediation).toContain("JetBrains.ReSharper.GlobalTools");
	});

	it("reports the project-evaluation gate across C# engines", () => {
		const overrides = {
			languages: ["csharp"] as const,
			installedTools: { dotnet: true, jb: true, roslynator: true },
		};
		const decisions = [
			planFormatForTest({ ...overrides, languages: [...overrides.languages] }),
			planLintForTest({ ...overrides, languages: [...overrides.languages] }),
			planSecurityForTest({ ...overrides, languages: [...overrides.languages] }),
		];

		expect(decisions).toEqual(
			Array.from({ length: 3 }, () => ({
				tool: "project-backed C# tools",
				status: "skipped",
				skipReason: "set lint.csharp.projectEvaluation: true only for repositories you trust",
			})),
		);
	});
});

describe("planFormat/planLint cpp tools", () => {
	it("reports cpp tools: clang-format for format, cppcheck preferred for lint", () => {
		const decisionFormat = planFormatForTest({
			languages: ["cpp"],
			installedTools: { "clang-format": true },
		});
		expect(decisionFormat).toMatchObject({ tool: "clang-format (system)", status: "ok" });

		const decisionLint = planLintForTest({
			languages: ["cpp"],
			installedTools: { cppcheck: true, "clang-tidy": true },
		});
		expect(decisionLint).toMatchObject({ tool: "cppcheck (system)", status: "ok" });

		const none = planLintForTest({
			languages: ["cpp"],
			installedTools: {},
		});
		expect(none.status).toBe("missing");
		expect(none.tool).toContain("cppcheck not found");
	});

	it("falls through a gated C# tool to available C++ tools", () => {
		const languages = ["csharp", "cpp"] as const;
		expect(
			planFormatForTest({
				languages: [...languages],
				installedTools: { dotnet: true, "clang-format": true },
			}),
		).toMatchObject({ tool: "clang-format (system)", status: "ok" });
		expect(
			planLintForTest({
				languages: [...languages],
				installedTools: { jb: true, cppcheck: true },
			}),
		).toMatchObject({ tool: "cppcheck (system)", status: "ok" });
	});

	it("keeps the C# trust gate visible when no fallback tool is available", () => {
		expect(
			planFormatForTest({
				languages: ["csharp", "cpp"],
				installedTools: { dotnet: true, "clang-format": false },
			}),
		).toMatchObject({ tool: "project-backed C# tools", status: "skipped" });
	});
});

describe("planAiSlop csharp grammar reporting", () => {
	it("reports tree-sitter-c_sharp (bundled) for C# projects when grammar is available", () => {
		const decision = planAiSlopForTest({
			languages: ["csharp"],
			installedTools: {},
		});
		expect(decision.tool).toBe("tree-sitter-c_sharp (bundled)");
		expect(decision.status).toBe("ok");
	});

	it("reports built-in for non-C# projects", () => {
		const decision = planAiSlopForTest({
			languages: ["typescript"],
			installedTools: {},
		});
		expect(decision.tool).toBe("built-in");
		expect(decision.status).toBe("ok");
	});

	it("reports missing when the C# grammar wasm is absent", () => {
		const spy = vi.spyOn(tooling, "resolveBundledCsharpGrammar").mockReturnValue(null);
		try {
			const decision = planAiSlopForTest({
				languages: ["csharp"],
				installedTools: {},
			});
			expect(decision.status).toBe("missing");
			expect(decision.tool).toBe("tree-sitter-c_sharp not found");
			expect(decision.remediation).toBe(
				"Reinstall aislop so the bundled grammar tools/grammars/tree-sitter-c_sharp.wasm is present.",
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("reports missing when web-tree-sitter does not resolve", () => {
		const spy = vi.spyOn(tooling, "resolveWebTreeSitter").mockReturnValue(null);
		try {
			const decision = planAiSlopForTest({
				languages: ["csharp"],
				installedTools: {},
			});
			expect(decision.status).toBe("missing");
			expect(decision.tool).toBe("web-tree-sitter not found");
			expect(decision.remediation).toBe(
				"Reinstall aislop so its web-tree-sitter dependency is installed.",
			);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("doctor fork pin row", () => {
	const rows: DoctorEngineRow[] = [{ engine: "Formatting", tool: "biome (bundled)", status: "ok" }];
	const render = (forkPinStatus?: Parameters<typeof buildDoctorRender>[0]["forkPinStatus"]) =>
		strip(
			buildDoctorRender({
				projectName: "my-app",
				languageLabel: "typescript",
				rows,
				invocation: "aislop",
				forkPinStatus,
			}),
		);

	it("omits the row when the repository pins no fork commit", () => {
		expect(render({ state: "no-pin", pinnedCommit: null, runningCommit: null })).not.toContain(
			"Fork pin",
		);
	});

	it("omits the row when no status was resolved at all", () => {
		expect(render()).not.toContain("Fork pin");
	});

	it("reports an aligned install with the pinned commit", () => {
		const out = render({
			state: "aligned",
			pinnedCommit: "ad036928176523101132e39b11b8fd9e108db601",
			runningCommit: "ad036928176523101132e39b11b8fd9e108db601",
		});
		expect(out).toMatch(/Fork pin\s+aligned \(ad03692\)/);
	});

	it("reports drift with both commits so the mismatch is legible", () => {
		const out = render({
			state: "drift",
			pinnedCommit: "ad036928176523101132e39b11b8fd9e108db601",
			runningCommit: "9de29395a1b2c3d4e5f60718293a4b5c6d7e8f90",
		});
		expect(out).toContain("drift");
		expect(out).toContain("9de2939");
		expect(out).toContain("ad03692");
	});

	it("reports an unstamped build without claiming drift", () => {
		const out = render({
			state: "unknown-build",
			pinnedCommit: "ad036928176523101132e39b11b8fd9e108db601",
			runningCommit: null,
		});
		expect(out).toContain("running build unstamped");
		expect(out).not.toContain("drift");
	});
});
