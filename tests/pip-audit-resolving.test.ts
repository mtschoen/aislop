import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { EngineContext } from "../src/engines/types.js";
import { SubprocessTimeoutError } from "../src/utils/subprocess.js";

const { runSubprocess } = vi.hoisted(() => ({ runSubprocess: vi.fn() }));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/subprocess.js")>()),
	runSubprocess,
}));

const { inspectPipAudit } = await import("../src/engines/security/audit-ecosystem.js");
const { runDependencyAudit } = await import("../src/engines/security/audit.js");
const skippedRule = "security/dependency-audit-skipped";
const resolvingArguments = ["--format=json", "--progress-spinner=off", "-r", "requirements.txt"];
const pinnedArguments = [
	"--format=json",
	"--progress-spinner=off",
	"--disable-pip",
	"--no-deps",
	"-r",
	"requirements.txt",
];
const finding = { name: "urllib3", version: "1.26.0", vulns: [{ id: "PYSEC-1" }] };
const report = JSON.stringify({ dependencies: [finding], fixes: [] });

describe("issue 127: opt-in resolving Python audit", () => {
	let directory: string;
	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-pip-resolving-"));
		fs.writeFileSync(path.join(directory, "requirements.txt"), "requests\n");
		runSubprocess.mockReset();
		runSubprocess.mockResolvedValue({ stdout: report, stderr: "", exitCode: 1 });
	});
	afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

	it.each([
		["flag off under ci", false, "ci", "Pin every requirement"],
		["flag on under scan", true, "scan", "only under `aislop ci`"],
		["flag on without command (hooks or fix)", true, undefined, "only under `aislop ci`"],
	] as const)(
		"skips without spawning: %s",
		async (_name, resolvePythonRequirements, invokingCommand, message) => {
			const outcome = await inspectPipAudit(directory, 25000, {
				resolvePythonRequirements,
				invokingCommand,
			});
			expect(outcome.completed).toBe(false);
			expect(outcome.diagnostics).toEqual([
				expect.objectContaining({ rule: skippedRule, help: expect.stringContaining(message) }),
			]);
			expect(runSubprocess).not.toHaveBeenCalled();
		},
	);

	it.each([
		["bare name", "requests\n", resolvingArguments],
		["version range", "requests>=2\n", resolvingArguments],
		["extras and marker", 'requests[socks]; python_version >= "3.8"\n', resolvingArguments],
		["constraints", "-c constraints.txt\nrequests\n", resolvingArguments],
		["find-links", "--find-links wheels\nrequests\n", resolvingArguments],
		["editable", "-e .\n", resolvingArguments],
		["nested requirements", "-r other.txt\n", resolvingArguments],
		["exact pin", "requests==2.0.0\n", pinnedArguments],
	])(
		"selects safe arguments and parses transitive findings: %s",
		async (_name, contents, arguments_) => {
			fs.writeFileSync(path.join(directory, "requirements.txt"), contents);
			const outcome = await inspectPipAudit(directory, 25000, {
				resolvePythonRequirements: true,
				invokingCommand: "ci",
			});
			expect(runSubprocess).toHaveBeenCalledWith("pip-audit", arguments_, {
				cwd: directory,
				timeout: 25000,
			});
			expect(outcome.completed).toBe(true);
			expect(outcome.diagnostics).toEqual([
				expect.objectContaining({ rule: "security/vulnerable-dependency", packageName: "urllib3" }),
			]);
		},
	);

	it.each([
		[
			"failure exit",
			() => runSubprocess.mockResolvedValue({ stdout: report, stderr: "failed", exitCode: 2 }),
		],
		[
			"timeout",
			() =>
				runSubprocess.mockRejectedValue(
					new SubprocessTimeoutError("pip-audit timed out", report, ""),
				),
		],
		[
			"skipped dependency",
			() =>
				runSubprocess.mockResolvedValue({
					stdout: JSON.stringify({
						dependencies: [finding, { name: "private", skip_reason: "not on PyPI" }],
					}),
					stderr: "",
					exitCode: 1,
				}),
		],
	])("keeps findings but remains incomplete: %s", async (_name, arrange) => {
		arrange();
		const outcome = await inspectPipAudit(directory, 25000, {
			resolvePythonRequirements: true,
			invokingCommand: "ci",
		});
		expect(runSubprocess).toHaveBeenCalledWith("pip-audit", resolvingArguments, expect.any(Object));
		expect(outcome.completed).toBe(false);
		expect(outcome.diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([
			skippedRule,
			"security/vulnerable-dependency",
		]);
		expect(outcome.diagnostics[0].help).toContain(
			"pip-audit --format=json --progress-spinner=off -r requirements.txt",
		);
	});

	it.each([
		[true, "ci", "security/vulnerable-dependency"],
		[true, "scan", skippedRule],
		[true, undefined, skippedRule],
		[false, "ci", skippedRule],
	] as const)(
		"threads resolving=%s and command=%s through dependency auditing",
		async (resolvePythonRequirements, invokingCommand, expectedRule) => {
			const context: EngineContext = {
				rootDirectory: directory,
				languages: ["python"],
				frameworks: [],
				installedTools: { "pip-audit": true },
				invokingCommand,
				config: {
					...DEFAULT_CONFIG,
					security: { ...DEFAULT_CONFIG.security, resolvePythonRequirements },
				},
			};
			const diagnostics = await runDependencyAudit(context);
			expect(diagnostics.map((diagnostic) => diagnostic.rule)).toEqual([expectedRule]);
		},
	);

	it("reports a completed clean resolving audit", async () => {
		runSubprocess.mockResolvedValue({
			stdout: JSON.stringify({
				dependencies: [{ name: "requests", version: "2.32.5", vulns: [] }],
			}),
			stderr: "",
			exitCode: 0,
		});
		await expect(
			inspectPipAudit(directory, 25000, {
				resolvePythonRequirements: true,
				invokingCommand: "ci",
			}),
		).resolves.toEqual({ diagnostics: [], completed: true });
	});

	it("does not resolve an unreadable requirements file", async () => {
		fs.unlinkSync(path.join(directory, "requirements.txt"));
		fs.mkdirSync(path.join(directory, "requirements.txt"));
		const outcome = await inspectPipAudit(directory, 25000, {
			resolvePythonRequirements: true,
			invokingCommand: "ci",
		});
		expect(outcome.completed).toBe(false);
		expect(outcome.diagnostics[0].help).toContain("could not be read");
		expect(runSubprocess).not.toHaveBeenCalled();
	});
});
