import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { runSubprocess } from "./subprocess.js";
import { isToolAvailable } from "./tooling.js";

export const TOOLS_TO_CHECK = [
	"oxlint",
	"biome",
	"ruff",
	"golangci-lint",
	"npm",
	"pnpm",
	"govulncheck",
	"gofmt",
	"pip-audit",
	"cargo",
	"cargo-audit",
	"clippy-driver",
	"rustfmt",
	"rubocop",
	"phpcs",
	"php-cs-fixer",
	"dotnet",
	"roslynator",
	"jb",
	"cppcheck",
	"clang-format",
	"clang-tidy",
];

export interface CheckInstalledToolsOptions {
	readonly languages?: readonly string[];
	readonly audit?: boolean;
}

const isExecutableFile = (candidate: string): boolean => {
	let stats: fs.Stats;
	try {
		stats = fs.statSync(candidate);
	} catch {
		return false;
	}
	if (!stats.isFile()) return false;
	if (process.platform === "win32") return true;
	return (stats.mode & 0o111) !== 0;
};

const findCargoHomeBinary = (binaryName: string): boolean => {
	const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
	const executable = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
	const candidate = path.join(cargoHome, "bin", executable);
	return isExecutableFile(candidate);
};

export const checkInstalledTools = async (
	projectRoot?: string,
	options?: CheckInstalledToolsOptions,
): Promise<Record<string, boolean>> => {
	const results: Record<string, boolean> = {};
	await Promise.all(
		TOOLS_TO_CHECK.map(async (tool) => {
			results[tool] = await isToolAvailable(tool, projectRoot);
		}),
	);

	// Cargo resolves external subcommands from CARGO_HOME/bin as well as PATH.
	// Keep general discovery presence-only: check Cargo's home bin directory without executing Cargo.
	if (!results["cargo-audit"] && findCargoHomeBinary("cargo-audit")) {
		results["cargo-audit"] = true;
	}

	// Defer project-sensitive Cargo listing until an enabled, in-scope Rust audit.
	if (
		results.cargo &&
		!results["cargo-audit"] &&
		options?.audit === true &&
		options?.languages?.includes("rust")
	) {
		try {
			const listing = await runSubprocess("cargo", ["--color", "never", "--list"], {
				cwd: projectRoot,
				timeout: DEFAULT_CONFIG.security.auditTimeout,
			});
			const output = stripVTControlCharacters(listing.stdout);
			// Retain failed discovery separately from an authoritative missing subcommand.
			results["cargo-audit-discovery-failed"] = listing.exitCode !== 0 || !output.trim();
			results["cargo-audit"] =
				!results["cargo-audit-discovery-failed"] && /^\s*audit(?:\s|$)/m.test(output);
		} catch {
			results["cargo-audit-discovery-failed"] = true;
		}
	}
	return results;
};
