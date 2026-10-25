import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runBunAudit } from "../src/engines/security/audit.js";
import {
	inspectCargoAudit,
	inspectDotnetAudit,
	inspectGovulncheck,
	inspectPipAudit,
} from "../src/engines/security/audit-ecosystem.js";
import type { DependencyAdvisory } from "../src/engines/types.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/subprocess.js")>()),
	runSubprocess,
}));

interface CaptureMetadata {
	binary: string;
	arguments: string[];
	exitCode: number;
	source: "stdout" | "stderr";
	stdout?: string;
	stderr?: string;
}

const fixtureDirectory = path.join(import.meta.dirname, "fixtures", "audit");
const projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-captured-audit-"));
fs.writeFileSync(path.join(projectDirectory, "requirements.txt"), "requests==2.19.1\n");
afterAll(() => fs.rmSync(projectDirectory, { recursive: true, force: true }));
beforeEach(() => runSubprocess.mockReset());

const capture = (tool: string, name: string, extension: string) => {
	const directory = path.join(fixtureDirectory, tool);
	const metadata: CaptureMetadata = JSON.parse(
		fs.readFileSync(path.join(directory, `${name}.meta.json`), "utf8"),
	);
	const output = fs.readFileSync(path.join(directory, `${name}.${extension}`), "utf8");
	return {
		metadata,
		result: {
			stdout: metadata.source === "stdout" ? output : (metadata.stdout ?? ""),
			stderr: metadata.source === "stderr" ? output : (metadata.stderr ?? ""),
			exitCode: metadata.exitCode,
		},
	};
};

const tools = [
	{
		name: "cargo",
		inspect: () => inspectCargoAudit(projectDirectory, 1000),
		failureExtension: "txt",
		packageName: "time",
		advisories: [{ id: "RUSTSEC-2020-0071", aliases: ["CVE-2020-26235", "GHSA-wcg3-cvx6-7396"] }],
	},
	{
		name: "bun",
		inspect: () => runBunAudit(projectDirectory, 1000),
		failureExtension: "txt",
		packageName: "lodash",
		advisories: [{ id: "GHSA-35jh-r3h4-6jhm" }, { id: "GHSA-29mw-wpgm-hmr9" }],
	},
	{
		name: "pip-audit",
		inspect: () => inspectPipAudit(projectDirectory, 1000),
		failureExtension: "txt",
		packageName: "requests",
		advisories: [{ id: "PYSEC-2018-28", aliases: ["GHSA-x84v-xcm2-53pg", "CVE-2018-18074"] }],
	},
	{
		name: "nuget",
		inspect: () =>
			inspectDotnetAudit(
				{ rootDirectory: projectDirectory, dependencyAuditFiles: ["Probe.csproj"] },
				1000,
			),
		failureExtension: "json",
		packageName: "Newtonsoft.Json",
		advisories: [{ id: "GHSA-5crp-9r3c-p9vr" }],
	},
	{
		name: "govulncheck",
		inspect: () => inspectGovulncheck(projectDirectory, 1000),
		failureExtension: "json",
		packageName: "golang.org/x/text",
		advisories: [{ id: "GO-2022-1059", aliases: ["CVE-2022-32149", "GHSA-69ch-w2m2-3vjp"] }],
	},
] satisfies {
	name: string;
	inspect: () => Promise<unknown>;
	failureExtension: string;
	packageName: string;
	advisories: DependencyAdvisory[];
}[];

describe.each(tools)("captured $name output (issue 127)", (tool) => {
	it.each([
		{
			name: "vulnerable",
			extension: "json",
			completed: true,
			diagnostics: [
				{
					rule: "security/vulnerable-dependency",
					severity: "error",
					packageName: tool.packageName,
					advisories: tool.advisories,
				},
			],
		},
		{ name: "clean", extension: "json", completed: true, diagnostics: [] },
		{
			name: "failure",
			extension: tool.failureExtension,
			completed: false,
			diagnostics: [
				{
					rule: "security/dependency-audit-skipped",
					severity: "warning",
					packageName: undefined,
					advisories: undefined,
				},
			],
		},
	])("classifies the $name capture using its recorded exit code", async (expected) => {
		const { metadata, result } = capture(tool.name, expected.name, expected.extension);
		runSubprocess.mockResolvedValue(result);

		const outcome = await tool.inspect();

		expect(outcome.completed).toBe(expected.completed);
		expect(
			outcome.diagnostics.map(({ rule, severity, packageName, advisories }) => ({
				rule,
				severity,
				packageName,
				advisories,
			})),
		).toEqual(expected.diagnostics);
		expect(runSubprocess).toHaveBeenCalledWith(
			metadata.binary,
			metadata.arguments,
			expect.objectContaining({ cwd: projectDirectory }),
		);
	});
});
