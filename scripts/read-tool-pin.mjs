#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolName = process.argv[2];
if (!toolName) {
	process.stderr.write("Usage: read-tool-pin.mjs <tool-name>\n");
	process.exit(1);
}

const installerPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"install-tools.mjs",
);
const installerContent = fs.readFileSync(installerPath, "utf8");

const pattern = new RegExp(
	`name:\\s*"${toolName}"[\\s\\S]*?version:\\s*"([^"]+)"`,
);
const match = installerContent.match(pattern);
if (!match) {
	process.stderr.write(`Tool pin not found for: ${toolName}\n`);
	process.exit(1);
}

process.stdout.write(match[1]);
