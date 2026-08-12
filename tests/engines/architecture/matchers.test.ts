import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRules } from "../../../src/engines/architecture/matchers.js";
import type { ArchitectureRule } from "../../../src/engines/architecture/rule-loader.js";
import type { EngineContext } from "../../../src/engines/types.js";

let temporaryDirectory: string;

const writeSource = (relativePath: string, content: string): string => {
	const filePath = path.join(temporaryDirectory, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf8");
	return filePath;
};

const contextFor = (...files: string[]): EngineContext => ({
	rootDirectory: temporaryDirectory,
	files,
	languages: ["typescript"],
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false, expoDoctor: false },
	},
});

const rule = (
	name: string,
	type: ArchitectureRule["type"],
	options: Partial<ArchitectureRule>,
): ArchitectureRule => ({ name, type, severity: "error", ...options });

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-architecture-matchers-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("architecture rule matchers", () => {
	it.each([
		{
			name: "ECMAScript imports and require calls",
			relativePath: "src/client.ts",
			content: [
				'import React from "react";',
				'const logger = require("@internal/logger");',
				'export { safe } from "./safe";',
			].join("\n"),
			match: "@internal",
			expectedImport: "@internal/logger",
			expectedLine: 2,
		},
		{
			name: "Python imports",
			relativePath: "src/client.py",
			content: "import requests\nfrom domain.service import fetch\n",
			match: "domain.service",
			expectedImport: "domain.service",
			expectedLine: 2,
		},
		{
			name: "Go single and grouped imports",
			relativePath: "src/client.go",
			content: ['import "fmt"', "import (", '\t"company/internal/log"', '\t"net/http"', ")"].join(
				"\n",
			),
			match: "company/internal",
			expectedImport: "company/internal/log",
			expectedLine: 3,
		},
	])(
		"finds forbidden $name",
		async ({ relativePath, content, match, expectedImport, expectedLine }) => {
			const filePath = writeSource(relativePath, content);

			const diagnostics = await checkRules(contextFor(filePath), [
				rule("forbidden-dependency", "forbid_import", { match }),
			]);

			expect(diagnostics).toHaveLength(1);
			expect(diagnostics[0]).toMatchObject({
				filePath: relativePath,
				rule: "arch/forbidden-dependency",
				line: expectedLine,
				message: expect.stringContaining(expectedImport),
				fixable: false,
			});
		},
	);

	it("applies path-scoped import rules with globstar, character classes, and wildcards", async () => {
		const matchingFile = writeSource(
			"src/features/a1.ts",
			'import data from "@private/service/data";\n',
		);
		const otherFile = writeSource(
			"lib/features/a1.ts",
			'import data from "@private/service/data";\n',
		);

		const diagnostics = await checkRules(contextFor(matchingFile, otherFile), [
			rule("feature-boundary", "forbid_import_from_path", {
				from: "src/**/[ab]?.ts",
				forbid: "@private/**",
			}),
		]);

		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			filePath: "src/features/a1.ts",
			rule: "arch/feature-boundary",
			line: 1,
		});
	});

	it("matches literal unmatched brackets in path-scoped rules", async () => {
		const filePath = writeSource("src/[handler.ts", 'import logger from "@internal/logger";\n');

		const diagnostics = await checkRules(contextFor(filePath), [
			rule("literal-bracket", "forbid_import_from_path", {
				from: "src/[handler.ts",
				forbid: "@internal/**",
			}),
		]);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				filePath: "src/[handler.ts",
				rule: "arch/literal-bracket",
				line: 1,
			}),
		]);
	});

	it("rejects a forbidden import fragment inside a prefixed path", async () => {
		const filePath = writeSource(
			"src/client.ts",
			'import logger from "virtual:@internal/logger";\n',
		);

		const diagnostics = await checkRules(contextFor(filePath), [
			rule("internal-fragment", "forbid_import_from_path", {
				from: "src/*.ts",
				forbid: "@internal/**",
			}),
		]);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				filePath: "src/client.ts",
				rule: "arch/internal-fragment",
				message: expect.stringContaining("virtual:@internal/logger"),
			}),
		]);
	});

	it("reports a missing required pattern only in matching files", async () => {
		const missingPattern = writeSource("src/handler.ts", "export const handler = () => true;\n");
		const presentPattern = writeSource(
			"src/audited.ts",
			"audit();\nexport const handler = () => true;\n",
		);
		const outsideScope = writeSource("lib/handler.ts", "export const handler = () => true;\n");

		const diagnostics = await checkRules(contextFor(missingPattern, presentPattern, outsideScope), [
			rule("audit-handlers", "require_pattern", { where: "src/*.ts", pattern: "audit()" }),
		]);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				filePath: "src/handler.ts",
				rule: "arch/audit-handlers",
				line: 0,
				message: expect.stringContaining("audit()"),
			}),
		]);
	});

	it("ignores incomplete and unknown rules", async () => {
		const filePath = writeSource("src/client.ts", 'import React from "react";\n');
		const unknownRule = {
			name: "future-rule",
			type: "future_rule",
			severity: "warning",
		} as unknown as ArchitectureRule;

		const diagnostics = await checkRules(contextFor(filePath), [
			rule("missing-match", "forbid_import", {}),
			rule("missing-path-options", "forbid_import_from_path", {}),
			rule("missing-pattern-options", "require_pattern", {}),
			unknownRule,
		]);

		expect(diagnostics).toEqual([]);
	});

	it("skips source files that become unreadable during the scan", async () => {
		const filePath = writeSource("src/client.ts", 'import React from "react";\n');
		const originalReadFileSync = fs.readFileSync;
		vi.spyOn(fs, "readFileSync").mockImplementation((requestedPath, options) => {
			if (requestedPath === filePath) throw new Error("permission denied");
			return originalReadFileSync(requestedPath, options as never);
		});

		const diagnostics = await checkRules(contextFor(filePath), [
			rule("no-react", "forbid_import", { match: "react" }),
		]);

		expect(diagnostics).toEqual([]);
	});
});
