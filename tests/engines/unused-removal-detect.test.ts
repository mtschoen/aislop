import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnusedDeclaration } from "../../src/engines/code-quality/unused-removal-types.js";
import type { UnusedVarTarget } from "../../src/engines/code-quality/unused-var-rename.js";
import type { Diagnostic, EngineContext } from "../../src/engines/types.js";

const { runKnipMock, runOxlintMock } = vi.hoisted(() => ({
	runKnipMock: vi.fn(),
	runOxlintMock: vi.fn(),
}));

vi.mock("../../src/engines/code-quality/knip.js", () => ({ runKnip: runKnipMock }));
vi.mock("../../src/engines/lint/oxlint.js", () => ({ runOxlint: runOxlintMock }));

const { detectUnusedDeclarations, diagnosticsToDeclarations } = await import(
	"../../src/engines/code-quality/unused-removal-detect.js"
);
const { removeUnusedDeclarations } = await import(
	"../../src/engines/code-quality/unused-removal.js"
);
const { prefixUnusedVars } = await import("../../src/engines/code-quality/unused-var-rename.js");

let temporaryDirectory: string;

const context: EngineContext = {
	rootDirectory: "/repo",
	languages: ["typescript"],
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false, expoDoctor: false },
	},
};

const diagnostic = (overrides: Partial<Diagnostic>): Diagnostic => ({
	filePath: "src/example.ts",
	engine: "lint",
	rule: "no-unused-vars",
	severity: "warning",
	message: "Variable 'unusedValue' is declared but never used.",
	help: "",
	line: 4,
	column: 2,
	category: "Lint",
	fixable: false,
	...overrides,
});

beforeEach(() => {
	runOxlintMock.mockReset().mockResolvedValue([]);
	runKnipMock.mockReset().mockResolvedValue([]);
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-unused-removal-detect-"));
});

afterEach(() => {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("detectUnusedDeclarations", () => {
	it("normalizes supported oxlint message variants and skips non-actionable diagnostics", async () => {
		runOxlintMock.mockResolvedValue([
			diagnostic({}),
			diagnostic({ message: "Function 'unusedFunction' is declared but never used.", line: 5 }),
			diagnostic({ message: "Class 'UnusedClass' is declared but never used.", line: 6 }),
			diagnostic({
				rule: "typescript/no-unused-vars",
				message: "'unreadValue' is declared but its value is never read.",
				line: 7,
			}),
			diagnostic({ message: "'unusedAlias' is defined but never used.", line: 8 }),
			diagnostic({ message: "Variable '_allowedParameter' is declared but never used.", line: 9 }),
			diagnostic({ rule: "no-console", line: 10 }),
			diagnostic({ message: "unused declaration with an unknown format", line: 11 }),
		]);

		const diagnostics = await detectUnusedDeclarations(context);

		expect(diagnostics.map(({ message }) => message)).toEqual([
			"Unused variable: unusedValue",
			"Unused function: unusedFunction",
			"Unused class: UnusedClass",
			"Unused variable: unreadValue",
			"Unused variable: unusedAlias",
		]);
		expect(diagnostics[0]).toMatchObject({
			engine: "code-quality",
			rule: "code-quality/unused-declaration",
			line: 4,
			column: 2,
			category: "Dead Code",
			fixable: true,
		});
	});

	it("normalizes Knip exports and removes duplicate declarations", async () => {
		runOxlintMock.mockResolvedValue([
			diagnostic({ message: "Variable 'sharedName' is declared but never used." }),
		]);
		runKnipMock.mockResolvedValue([
			diagnostic({
				engine: "code-quality",
				rule: "knip/exports",
				message: "Unused export: sharedName",
			}),
			diagnostic({
				engine: "code-quality",
				rule: "knip/types",
				message: "Unused type: Model",
				line: 12,
			}),
			diagnostic({
				engine: "code-quality",
				rule: "knip/duplicates",
				message: "Duplicate export: duplicateName",
				line: 13,
			}),
			diagnostic({ rule: "knip/files", message: "Unused file", line: 14 }),
			diagnostic({ rule: "knip/exports", message: "unexpected output", line: 15 }),
		]);

		const diagnostics = await detectUnusedDeclarations(context);

		expect(diagnostics.map(({ message }) => message)).toEqual([
			"Unused variable: sharedName",
			"Unused type: Model",
			"Unused variable: duplicateName",
		]);
	});

	it("treats failed external detectors as empty results", async () => {
		runOxlintMock.mockRejectedValue(new Error("oxlint unavailable"));
		runKnipMock.mockRejectedValue(new Error("knip unavailable"));

		await expect(detectUnusedDeclarations(context)).resolves.toEqual([]);
	});

	it("converts supported diagnostics and skips malformed or unknown kinds", () => {
		const declarations = diagnosticsToDeclarations([
			diagnostic({
				message: "Unused enum:   Status  ",
				line: 14,
				column: 3,
			}),
			diagnostic({ message: "Unused namespace: Internal", line: 15 }),
			diagnostic({ message: "unexpected output", line: 16 }),
		]);

		expect(declarations).toEqual([
			{
				filePath: "src/example.ts",
				line: 14,
				column: 3,
				name: "Status",
				kind: "enum",
			},
		]);
	});
});

describe("unused declaration handling edge cases", () => {
	it("reports every declaration whose source file is missing", () => {
		const declarations: UnusedDeclaration[] = [
			{
				filePath: "missing.ts",
				line: 1,
				column: 1,
				name: "missingValue",
				kind: "variable",
			},
			{
				filePath: "missing.ts",
				line: 2,
				column: 1,
				name: "MissingType",
				kind: "type",
			},
		];

		const result = removeUnusedDeclarations(temporaryDirectory, declarations);

		expect(result).toEqual({
			removed: 0,
			skipped: declarations.map((declaration) => ({ declaration, reason: "file not found" })),
		});
	});

	it("preserves a detached leading comment when removing a declaration", () => {
		const source = [
			"// This comment describes the module, not the declaration.",
			"",
			"const unusedValue = 1;",
			"export const keptValue = 2;",
			"",
		].join("\n");
		const filePath = path.join(temporaryDirectory, "detached-comment.ts");
		fs.writeFileSync(filePath, source);

		const result = removeUnusedDeclarations(temporaryDirectory, [
			{
				filePath,
				line: 3,
				column: 7,
				name: "unusedValue",
				kind: "variable",
			},
		]);

		expect(result).toEqual({ removed: 1, skipped: [] });
		expect(fs.readFileSync(filePath, "utf8")).toBe(
			"// This comment describes the module, not the declaration.\n\nexport const keptValue = 2;\n",
		);
	});

	it("reports a missing file when prefixing an unused variable", () => {
		const target: UnusedVarTarget = {
			filePath: "missing.ts",
			line: 1,
			column: 1,
			name: "missingValue",
			type: "variable",
		};

		const result = prefixUnusedVars(temporaryDirectory, [target]);

		expect(result).toEqual({
			renamed: 0,
			skipped: [
				{
					target: { ...target, filePath: path.join(temporaryDirectory, target.filePath) },
					reason: "file not found",
				},
			],
		});
	});

	it("prefixes an unused array binding without changing its position", () => {
		const source = "const [unusedValue] = values;\nexport { values };\n";
		const filePath = path.join(temporaryDirectory, "array-binding.ts");
		fs.writeFileSync(filePath, source);

		const result = prefixUnusedVars(temporaryDirectory, [
			{
				filePath,
				line: 1,
				column: source.indexOf("unusedValue") + 1,
				name: "unusedValue",
				type: "variable",
			},
		]);

		expect(result).toEqual({ renamed: 1, skipped: [] });
		expect(fs.readFileSync(filePath, "utf8")).toBe(
			"const [_unusedValue] = values;\nexport { values };\n",
		);
	});

	it("does not prefix an identifier use when a diagnostic points at the use site", () => {
		const source = "export const value = 1;\nconsole.log(value);\n";
		const filePath = path.join(temporaryDirectory, "use-site.ts");
		fs.writeFileSync(filePath, source);

		const result = prefixUnusedVars(temporaryDirectory, [
			{
				filePath,
				line: 2,
				column: "console.log(".length + 1,
				name: "value",
				type: "variable",
			},
		]);

		expect(result).toEqual({
			renamed: 0,
			skipped: [
				{
					target: expect.objectContaining({ name: "value" }),
					reason: "identifier context not supported",
				},
			],
		});
		expect(fs.readFileSync(filePath, "utf8")).toBe(source);
	});
});
