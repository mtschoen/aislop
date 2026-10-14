import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPostFixVerificationEngines, fixCommand } from "../src/commands/fix.js";
import * as fixScope from "../src/commands/fix-scope.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import * as orchestrator from "../src/engines/orchestrator.js";
import * as subprocess from "../src/utils/subprocess.js";
import * as tooling from "../src/utils/tooling.js";

describe("buildPostFixVerificationEngines", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	it.each([
		{ name: "F4-3 enabled fallback", safe: false, scoped: false, audit: true, available: true },
		{ name: "F4-3 safe mode", safe: true, scoped: false, audit: true, available: false },
		{ name: "F4-3 source-only scope", safe: false, scoped: true, audit: true, available: false },
		{ name: "F4-3 disabled audit", safe: false, scoped: false, audit: false, available: false },
	])(
		"passes scoped Cargo fallback to verification: $name",
		async ({ safe, scoped, audit, available }) => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-fix-cargo-"));
			try {
				fs.writeFileSync(path.join(directory, "Cargo.toml"), '[package]\nname = "example"\n');
				vi.stubEnv("CARGO_HOME", directory);
				vi.spyOn(tooling, "isToolAvailable").mockImplementation(async (tool) => tool === "cargo");
				const run = vi
					.spyOn(subprocess, "runSubprocess")
					.mockResolvedValue({
						stdout: "    audit    Check dependencies\n",
						stderr: "",
						exitCode: 0,
					});
				vi.spyOn(fixScope, "collectFixFileScope").mockReturnValue(
					scoped
						? {
								files: [path.join(directory, "main.rs")],
								testFiles: [],
								projectFiles: [],
								dependencyAuditFiles: [],
								dependencyAuditScope: "files",
								scoreFileCount: 1,
								scopeLabel: "changed files",
							}
						: null,
				);
				const verification = vi.spyOn(orchestrator, "runEngines").mockResolvedValue([]);
				await fixCommand(
					directory,
					{
						...DEFAULT_CONFIG,
						engines: {
							format: false,
							lint: false,
							"code-quality": false,
							"ai-slop": false,
							architecture: false,
							security: true,
						},
						security: { ...DEFAULT_CONFIG.security, audit },
						telemetry: { enabled: false },
					},
					{ verbose: false, showHeader: false, safe },
				);
				expect(verification.mock.calls[0][0].installedTools["cargo-audit"]).toBe(available);
				expect(verification.mock.calls[0][0].config.security.audit).toBe(audit && !safe);
				expect(run.mock.calls.length > 0).toBe(available);
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		},
	);
	it("disables lint during post-fix verification", () => {
		const engines = buildPostFixVerificationEngines(DEFAULT_CONFIG.engines);

		expect(engines.lint).toBe(false);
	});

	it("preserves the user's non-lint engine choices", () => {
		const engines = buildPostFixVerificationEngines({
			...DEFAULT_CONFIG.engines,
			format: false,
			"ai-slop": false,
			architecture: true,
		});

		expect(engines).toEqual({
			...DEFAULT_CONFIG.engines,
			format: false,
			lint: false,
			"ai-slop": false,
			architecture: true,
		});
	});
});
