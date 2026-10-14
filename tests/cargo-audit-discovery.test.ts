import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareScan } from "../src/commands/scan-pipeline.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { EngineContext } from "../src/engines/types.js";

const { isToolAvailable, runSubprocess, getChangedFiles } = vi.hoisted(() => ({
	isToolAvailable: vi.fn(),
	runSubprocess: vi.fn(),
	getChangedFiles: vi.fn(),
}));
vi.mock("../src/utils/git.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/git.js")>()),
	getChangedFiles,
}));
vi.mock("../src/utils/tooling.js", () => ({ isToolAvailable }));
vi.mock("../src/utils/subprocess.js", () => ({ runSubprocess }));
const { checkInstalledTools } = await import("../src/utils/discovery-tools.js");
const { runDependencyAudit } = await import("../src/engines/security/audit.js");

const auditContext = (installedTools: Record<string, boolean>): EngineContext => ({
	rootDirectory: "/repo",
	languages: ["rust"],
	frameworks: [],
	dependencyAuditScope: "full",
	installedTools,
	config: DEFAULT_CONFIG,
});

describe("Cargo audit subcommand discovery", () => {
	let directory: string;
	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-cargo-discovery-"));
		vi.stubEnv("CARGO_HOME", directory);
		isToolAvailable.mockReset();
		runSubprocess.mockReset();
		isToolAvailable.mockImplementation(async (tool: string) => tool === "cargo");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(directory, { recursive: true, force: true });
	});
	it.each([
		{
			name: "plain",
			stdout: "Installed Commands:\n    audit    Check dependencies\n    build    Compile\n",
		},
		{
			name: "forced-color",
			stdout:
				"\u001b[92m\u001b[1mInstalled Commands:\u001b[39m\u001b[22m\n    \u001b[1m\u001b[96maudit\u001b[0m\n",
		},
	])(
		"finds cargo-audit through Cargo listing when direct discovery misses it ($name)",
		async ({ stdout }) => {
			runSubprocess.mockResolvedValue({
				stdout,
				stderr: "",
				exitCode: 0,
			});
			expect(
				(await checkInstalledTools("/repo", { languages: ["rust"], audit: true }))["cargo-audit"],
			).toBe(true);
			expect(runSubprocess).toHaveBeenCalledWith("cargo", ["--color", "never", "--list"], {
				cwd: "/repo",
				timeout: DEFAULT_CONFIG.security.auditTimeout,
			});
		},
	);
	it.each([
		{
			stdout: "",
			stderr:
				"error: rustup could not choose a version of cargo to run, because one wasn't specified explicitly, and no default is configured.",
			exitCode: 1,
		},
		{ stdout: "", stderr: "", exitCode: 0 },
		{ stdout: "   \n", stderr: "", exitCode: 0 },
	])(
		"R2 warns when Cargo discovery cannot establish availability: $exitCode/$stdout",
		async (result) => {
			runSubprocess.mockResolvedValue(result);
			const tools = await checkInstalledTools("/repo", { languages: ["rust"], audit: true });
			const diagnostics = await runDependencyAudit(auditContext(tools));
			expect(diagnostics).toEqual([
				expect.objectContaining({
					rule: "security/dependency-audit-skipped",
					severity: "warning",
					filePath: "Cargo.toml",
					message: "Dependency audit did not complete (cargo audit)",
				}),
			]);
			expect(diagnostics[0].help).toContain("discovery");
		},
	);
	it("R3 bounds pending Cargo discovery and warns on its timeout", async () => {
		let started!: () => void;
		const listingStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let rejectListing!: (error: Error) => void;
		const pendingListing = new Promise<never>((_resolve, reject) => {
			rejectListing = reject;
		});
		runSubprocess.mockImplementation(() => {
			started();
			return pendingListing;
		});
		const discovery = checkInstalledTools("/repo", { languages: ["rust"], audit: true });
		await listingStarted;
		const options = runSubprocess.mock.calls[0][2];
		// Release the controlled pending call even when the timeout assertion fails.
		rejectListing(new Error("Command timed out"));
		const tools = await discovery;
		expect(options.timeout).toBeGreaterThan(0);
		expect(Number.isFinite(options.timeout)).toBe(true);
		expect(await runDependencyAudit(auditContext(tools))).toEqual([
			expect.objectContaining({ rule: "security/dependency-audit-skipped", severity: "warning" }),
		]);
	});
	it("keeps a successfully listed missing auditor silent", async () => {
		runSubprocess.mockResolvedValue({
			stdout: "Installed Commands:\n    build    Compile\n",
			stderr: "",
			exitCode: 0,
		});
		const tools = await checkInstalledTools("/repo", { languages: ["rust"], audit: true });
		expect(await runDependencyAudit(auditContext(tools))).toEqual([]);
	});
	it.each([
		{ stdout: "    audit-extra    Other command\n", stderr: "", exitCode: 0 },
		{ stdout: "    audit    Check dependencies\n", stderr: "", exitCode: 1 },
	])(
		"does not invent an auditor from an unrelated or failed listing: $exitCode",
		async (result) => {
			runSubprocess.mockResolvedValue(result);
			expect(
				(await checkInstalledTools("/repo", { languages: ["rust"], audit: true }))["cargo-audit"],
			).toBe(false);
		},
	);
	it("keeps a failed Cargo listing unavailable", async () => {
		runSubprocess.mockRejectedValue(new Error("cannot start cargo"));
		expect(
			(await checkInstalledTools("/repo", { languages: ["rust"], audit: true }))["cargo-audit"],
		).toBe(false);
	});
	it.each(["cargo-audit", "neither"])(
		"does not list subcommands when PATH already decides availability: %s",
		async (available) => {
			isToolAvailable.mockImplementation(async (tool: string) => tool === available);
			expect(
				(await checkInstalledTools("/repo", { languages: ["rust"], audit: true }))["cargo-audit"],
			).toBe(available === "cargo-audit");
			expect(runSubprocess).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ name: "F4-5 executable", mode: 0o755, expected: true },
		{ name: "F4-5 absent", mode: null, expected: false },
		{ name: "F4-5 non-executable", mode: 0o644, expected: process.platform === "win32" },
	])("isolates Cargo-home presence: $name", async ({ mode, expected }) => {
		if (mode !== null) {
			fs.mkdirSync(path.join(directory, "bin"));
			const binary = path.join(
				directory,
				"bin",
				process.platform === "win32" ? "cargo-audit.exe" : "cargo-audit",
			);
			fs.writeFileSync(binary, "fixture");
			fs.chmodSync(binary, mode);
		}
		expect((await checkInstalledTools(directory))["cargo-audit"]).toBe(expected);
		expect(runSubprocess).not.toHaveBeenCalled();
	});
	it.each([
		{
			name: "F4-1 source-only changes",
			selected: ["main.rs"],
			audit: true,
			security: true,
			listing: false,
		},
		{
			name: "manifest changes",
			selected: ["Cargo.toml"],
			audit: true,
			security: true,
			listing: true,
		},
		{
			name: "audit disabled",
			selected: ["Cargo.toml"],
			audit: false,
			security: true,
			listing: false,
		},
		{
			name: "security disabled",
			selected: ["Cargo.toml"],
			audit: true,
			security: false,
			listing: false,
		},
	])("prepares scoped discovery: $name", async ({ selected, audit, security, listing }) => {
		fs.writeFileSync(path.join(directory, "Cargo.toml"), '[package]\nname = "example"\n');
		fs.writeFileSync(path.join(directory, "main.rs"), "fn main() {}\n");
		getChangedFiles.mockReturnValue(selected.map((file) => path.join(directory, file)));
		runSubprocess.mockResolvedValue({
			stdout: "    audit    Check dependencies\n",
			stderr: "",
			exitCode: 0,
		});
		const prepared = await prepareScan(
			directory,
			{
				...DEFAULT_CONFIG,
				security: { ...DEFAULT_CONFIG.security, audit },
				engines: { ...DEFAULT_CONFIG.engines, security },
			},
			{ kind: "changes" },
		);
		expect(prepared.projectInfo.installedTools["cargo-audit"]).toBe(listing);
		expect(runSubprocess.mock.calls.length > 0).toBe(listing);
	});
	it.each([
		{
			reason: "unrelated scan (non-Rust)",
			options: { languages: ["javascript"], audit: true },
		},
		{
			reason: "audit-disabled scan",
			options: { languages: ["rust"], audit: false },
		},
		{
			reason: "general discovery without language or audit configuration",
			options: undefined,
		},
	])("proves $reason does not invoke Cargo", async ({ options }) => {
		await checkInstalledTools("/repo", options);
		expect(runSubprocess).not.toHaveBeenCalled();
	});
});
