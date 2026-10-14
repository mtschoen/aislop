#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

// Node's type stripping loads .ts files but does not map a ".js" import
// specifier to its ".ts" source, which the bundler-style imports in src/ rely
// on. Resolve a relative ".js" specifier to the ".ts" file when only that exists.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
			const typeScriptUrl = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
			const javaScriptUrl = new URL(specifier, context.parentURL);
			if (existsSync(fileURLToPath(typeScriptUrl)) && !existsSync(fileURLToPath(javaScriptUrl))) {
				return nextResolve(typeScriptUrl.href, context);
			}
		}
		return nextResolve(specifier, context);
	},
});

const { AislopConfigSchema } = await import("../src/config/schema.ts");

const here = dirname(fileURLToPath(import.meta.url));
// An optional first argument overrides the output path (tests write elsewhere).
const outPath = process.argv[2]
	? resolve(process.argv[2])
	: resolve(here, "..", "schema", "aislop.config.schema.json");

// Strip `required`/`additionalProperties:false` so partial user configs (every
// key has a default) validate, and allow the loader-handled `extends` key.
const relax = (node) => {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) relax(item);
		return;
	}
	delete node.required;
	if (node.additionalProperties === false) delete node.additionalProperties;
	for (const value of Object.values(node)) relax(value);
};

const jsonSchema = z.toJSONSchema(AislopConfigSchema, { target: "draft-2020-12" });
relax(jsonSchema);
jsonSchema.properties.overrides.items.required = ["files"];
jsonSchema.properties.security.properties.acceptedAdvisories.items.required = ["id", "reason"];
jsonSchema.$id = "https://scanaislop.com/schema/aislop.config.schema.json";
jsonSchema.title = "aislop configuration (.aislop/config.yml)";
jsonSchema.description = "Configuration schema for the aislop code-quality CLI.";
jsonSchema.properties.extends = {
	type: "string",
	description: "Path to a parent .aislop config to extend.",
};

writeFileSync(outPath, `${JSON.stringify(jsonSchema, null, "\t")}\n`);
process.stdout.write(`Wrote ${outPath}\n`);
