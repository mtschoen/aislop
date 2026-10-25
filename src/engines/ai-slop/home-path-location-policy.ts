import path from "node:path";

export interface AllowedPathSpan {
	start: number;
	end: number;
}

const DATA_EXTENSIONS = new Set([
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".ini",
	".cfg",
	".conf",
	".env",
]);

export const isHomePathDataFile = (filePath: string): boolean => {
	const name = path.posix.basename(filePath.replaceAll("\\", "/")).toLowerCase();
	return (
		name === ".env" || name.startsWith(".env.") || DATA_EXTENSIONS.has(path.posix.extname(name))
	);
};
