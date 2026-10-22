import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG } from "./defaults.js";
import { loadConfigChain } from "./extends.js";
import { type AislopConfig, parseConfig } from "./schema.js";
import { emitConfigWarning } from "./warnings.js";

export const CONFIG_DIR = ".aislop";
export const CONFIG_FILE = "config.yml";
export const RULES_FILE = "rules.yml";

export const findConfigDir = (startDir: string, stopAt?: string): string | null => {
	let current = path.resolve(startDir);
	const boundary = stopAt ? path.resolve(stopAt) : null;
	while (true) {
		const candidate = path.join(current, CONFIG_DIR);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			return candidate;
		}
		if (boundary && current === boundary) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
};

export interface LoadedConfig {
	config: AislopConfig;
	configPath: string | null;
	// Human-readable descriptions of every fallback the loader applied; empty when
	// the configuration loaded as written (or no configuration file exists).
	recoveries: string[];
}

export const loadConfigWithStatus = (directory: string): LoadedConfig => {
	const configDir = findConfigDir(directory);
	if (!configDir) return { config: DEFAULT_CONFIG, configPath: null, recoveries: [] };

	const configPath = path.join(configDir, CONFIG_FILE);
	if (!fs.existsSync(configPath))
		return { config: DEFAULT_CONFIG, configPath: null, recoveries: [] };

	const recoveries: string[] = [];
	let config: AislopConfig;
	try {
		const merged = loadConfigChain(configPath);
		config = parseConfig(merged, (description) => {
			if (!recoveries.includes(description)) recoveries.push(description);
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		emitConfigWarning(
			`  ⚠ Failed to parse ${configPath}: ${msg}\n  ⚠ Using default configuration.\n`,
		);
		recoveries.push(`failed to parse: ${msg}`);
		config = DEFAULT_CONFIG;
	}
	return { config, configPath, recoveries };
};

export const loadConfig = (directory: string): AislopConfig =>
	loadConfigWithStatus(directory).config;

export { resetConfigWarnings } from "./warnings.js";
export type { AislopConfig } from "./schema.js";
