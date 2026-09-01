import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "tsdown";
import { buildBuildInfo, gitRevParseHead, resolveCommitSha } from "./src/utils/build-info.ts";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
	version: string;
};

// Resolved once per tsdown invocation so every entry point (and the
// build-info.json written below) stamps the same commit and timestamp.
const commitSha = resolveCommitSha(process.env.COMMIT, () => gitRevParseHead(process.cwd()));
const buildInfo = buildBuildInfo({
	version: packageJson.version,
	commit: commitSha,
	builtAt: new Date(),
});

// Shared across every entry below: none of these ship well as a bundled
// dependency (native bindings, their own plugin loading, or a large parser
// runtime), so tsdown must always require() them instead of inlining them.
const NEVER_BUNDLE = [
	"oxlint",
	"knip",
	"knip/session",
	"@biomejs/biome",
	"typescript",
	"web-tree-sitter",
];

// The options every entry point shares; only `entry`, `dts`, `banner`, and
// `hooks` vary per entry below.
const commonEntryOptions = {
	deps: {
		neverBundle: NEVER_BUNDLE,
	},
	target: "node18",
	platform: "node",
	env: {
		VERSION: process.env.VERSION ?? packageJson.version,
	},
	fixedExtension: false,
} as const;

export default defineConfig([
	{
		...commonEntryOptions,
		entry: {
			cli: "./src/cli.ts",
		},
		dts: true,
		banner: "#!/usr/bin/env node",
		// dist/build-info.json lets external tooling detect a stale install
		// without spawning the CLI. Written in build:done (not at module load)
		// because tsdown cleans outDir at the start of every build, which would
		// otherwise wipe a file written earlier. Wired to only the cli entry
		// since every entry shares the same outDir; writing it three times over
		// would be redundant, not wrong.
		hooks: {
			"build:done": (ctx) => {
				const buildInfoPath = path.join(ctx.options.outDir, "build-info.json");
				fs.writeFileSync(buildInfoPath, `${JSON.stringify(buildInfo)}\n`);
			},
		},
	},
	{
		...commonEntryOptions,
		entry: {
			index: "./src/index.ts",
			"adapters/astro": "./src/framework-adapters/astro.ts",
			"adapters/expo": "./src/framework-adapters/expo.ts",
			"adapters/nuxt": "./src/framework-adapters/nuxt.ts",
			"adapters/sveltekit": "./src/framework-adapters/sveltekit.ts",
			"adapters/vite": "./src/framework-adapters/vite.ts",
		},
		dts: true,
	},
	{
		...commonEntryOptions,
		entry: {
			mcp: "./src/mcp.ts",
		},
		dts: false,
		banner: "#!/usr/bin/env node",
	},
]);
