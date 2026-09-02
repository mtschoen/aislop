import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/utils/read-jsonc.js";

describe("read-jsonc", () => {
	it("strips block comments before parsing", () => {
		const raw = `{
  "compilerOptions": {
    /* Bundler mode */
    "paths": { "@/*": ["./src/*"] }
  }
}`;
		const parsed = parseJsonc(raw) as { compilerOptions: { paths: Record<string, string[]> } };
		expect(parsed.compilerOptions.paths["@/*"]).toEqual(["./src/*"]);
	});

	it("parses JSONC trailing commas", () => {
		expect(parseJsonc('{ "a": 1, "nested": [true,], }')).toEqual({
			a: 1,
			nested: [true],
		});
	});

	it("returns null for invalid JSON after JSONC normalization", () => {
		expect(parseJsonc('{ "a": }')).toBeNull();
	});

	it("parses strict JSON with https URLs without mangling them", () => {
		const raw = `{
  "repository": { "url": "git+https://github.com/vercel/eve.git" },
  "homepage": "https://github.com/vercel/eve#readme"
}`;
		const parsed = parseJsonc(raw) as {
			repository: { url: string };
			homepage: string;
		};
		expect(parsed.repository.url).toBe("git+https://github.com/vercel/eve.git");
		expect(parsed.homepage).toBe("https://github.com/vercel/eve#readme");
	});

	it("parses tsconfig path aliases containing /* without treating them as comments", () => {
		const raw = `{
  "compilerOptions": {
    "paths": {
      "@/*": ["./*"]
    }
  }
}`;
		const parsed = parseJsonc(raw) as { compilerOptions: { paths: Record<string, string[]> } };
		expect(parsed.compilerOptions.paths["@/*"]).toEqual(["./*"]);
	});

	it("strips UTF-8 BOM before parsing", () => {
		const raw = '\uFEFF{ "name": "aislop", "version": "1.0.0" }';
		expect(parseJsonc(raw)).toEqual({ name: "aislop", version: "1.0.0" });
	});

	it("strips UTF-8 BOM from JSONC content with comments and trailing commas", () => {
		const raw = '\uFEFF// Header comment\r\n{\r\n  /* Block comment */\r\n  "statusLine": true,\r\n  "hooks": [\r\n    "test",\r\n  ],\r\n}';
		expect(parseJsonc(raw)).toEqual({
			statusLine: true,
			hooks: ["test"],
		});
	});

	it("handles line comments with CRLF line endings", () => {
		const raw = '{\r\n  // Line comment\r\n  "a": 1\r\n}';
		expect(parseJsonc(raw)).toEqual({ a: 1 });
	});
});
