import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectHallucinatedImports } from "../src/engines/ai-slop/hallucinated-imports.js";
import { addPyDep } from "../src/engines/ai-slop/python-dependency-parser.js";
import type { EngineContext } from "../src/engines/types.js";

describe("Python distribution normalization", () => {
	it.each(["Foo.Bar", "FOO_BAR", "foo-bar", "Foo..__--Bar"])(
		"stores %s as a canonical dependency name",
		(name) => {
			const dependencies = new Set<string>();
			addPyDep(dependencies, `${name}[extra]>=1`);
			addPyDep(dependencies, "foo-bar");
			expect([...dependencies]).toEqual(["foo-bar"]);
		},
	);
});

describe("Python hallucinated-import normalization", () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-python-normalization-"));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const context = (): EngineContext => ({
		rootDirectory: directory,
		languages: ["python"],
		frameworks: [],
		installedTools: {},
		config: {
			quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
			security: { audit: false, auditTimeout: 0 },
			lint: { typecheck: false },
		},
	});

	it.each([
		["Foo.Bar>=1", "foo_bar"],
		["Foo..__--Bar>=1", "foo_bar"],
		["foo-bar>=1", "foo__bar"],
		["discord-py>=2.7,<3", "discord"],
		["discord.py>=2.7,<3", "discord"],
		["python..dateutil>=2", "dateutil"],
	])("accepts %s for import %s", async (dependency, moduleName) => {
		fs.writeFileSync(
			path.join(directory, "pyproject.toml"),
			`[project]\nname = "sample"\ndependencies = ["${dependency}"]\n`,
		);
		fs.writeFileSync(path.join(directory, "app.py"), `import ${moduleName}\n`);
		expect(await detectHallucinatedImports(context())).toEqual([]);
	});

	it.each([
		["requirements.txt", "Foo.Bar>=1\n"],
		["Pipfile", '[packages]\nFoo.Bar = "*"\n'],
	])("normalizes names read from %s", async (manifestName, content) => {
		fs.writeFileSync(path.join(directory, manifestName), content);
		fs.writeFileSync(path.join(directory, "app.py"), "import foo_bar\n");
		expect(await detectHallucinatedImports(context())).toEqual([]);
	});

	it("still reports an unrelated undeclared module", async () => {
		fs.writeFileSync(
			path.join(directory, "pyproject.toml"),
			'[project]\nname = "sample"\ndependencies = ["Foo.Bar>=1"]\n',
		);
		fs.writeFileSync(path.join(directory, "app.py"), "import totally_missing_package_xyz\n");
		expect(await detectHallucinatedImports(context())).toEqual([
			expect.objectContaining({
				rule: "ai-slop/hallucinated-import",
				filePath: "app.py",
				line: 1,
				message: expect.stringContaining("totally_missing_package_xyz"),
			}),
		]);
	});
});
