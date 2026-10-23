import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CandidateSpan,
	detectHardcodedUserPaths,
	dropContainedSpans,
} from "../src/engines/ai-slop/hardcoded-user-path.js";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import type { EngineContext } from "../src/engines/types.js";

let temporaryDirectory: string;

const writeFile = (relativePath: string, content: string): void => {
	const absolutePath = path.join(temporaryDirectory, relativePath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, content, "utf-8");
};

const buildContext = (
	languages: EngineContext["languages"],
	bannedRoots: string[] = [],
	allowedPlaceholders: string[] = [],
): EngineContext => ({
	rootDirectory: temporaryDirectory,
	languages,
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
		aiSlop: { hardcodedUserPath: { bannedRoots, allowedPlaceholders } },
	},
});

// Fixture paths are assembled from parts so this file's own text never spells
// a home path of a real user (aislop scans itself).
const posixHome = (root: string, name: string, ...rest: string[]): string =>
	["", root, name, ...rest].join("/");
const windowsHome = (drive: string, name: string, separator: string, ...rest: string[]): string =>
	[`${drive}:`, "Users", name, ...rest].join(separator);

// The account running the scan. It is mocked (both \`os.homedir()\` and the
// environment variables it reads) so a test can prove the verdict ignores it.
const hardcodedPathDiagnostics = async (
	languages: EngineContext["languages"],
	bannedRoots: string[],
	options: { allowedPlaceholders?: string[]; accountHome?: string } = {},
): Promise<Awaited<ReturnType<typeof detectHardcodedUserPaths>>> => {
	const accountHome = options.accountHome ?? "/home/example";
	vi.spyOn(os, "homedir").mockReturnValue(accountHome);
	vi.stubEnv("HOME", accountHome);
	vi.stubEnv("USERPROFILE", accountHome);
	return detectHardcodedUserPaths(
		buildContext(languages, bannedRoots, options.allowedPlaceholders),
	);
};

const enginePathDiagnostics = async (
	languages: EngineContext["languages"],
): Promise<Awaited<ReturnType<typeof aiSlopEngine.run>>["diagnostics"]> => {
	const result = await aiSlopEngine.run(buildContext(languages));
	return result.diagnostics.filter(
		(diagnostic) => diagnostic.rule === "ai-slop/hardcoded-user-path",
	);
};

beforeEach(() => {
	temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-hardcoded-path-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("hardcoded user paths", () => {
	it("flags a home path by shape through the AI slop engine", async () => {
		const homeDirectory = posixHome("home", "zed");
		writeFile("src/launch.ts", `const tool = "${homeDirectory}/project";`);

		const diagnostics = await enginePathDiagnostics(["typescript"]);

		expect(diagnostics).toEqual([
			expect.objectContaining({ filePath: "src/launch.ts", line: 1, column: 15 }),
		]);
	});

	describe("home path shapes", () => {
		const shapedPaths: [string, string][] = [
			["POSIX /home", posixHome("home", "zed", "project")],
			["macOS /Users", posixHome("Users", "zed", "project")],
			["Windows backslash", windowsHome("C", "zed", "\\", "project")],
			["Windows escaped backslash", windowsHome("C", "zed", "\\\\", "project")],
			["Windows forward slash", windowsHome("D", "zed", "/", "project")],
			["file:/ with no authority", `file:${posixHome("home", "zed", "project")}`],
			["POSIX file URL", `file://${posixHome("home", "zed", "project")}`],
			["file://localhost/ with /home", `file://localhost${posixHome("home", "zed", "project")}`],
			["Windows file URL", `file:///${windowsHome("C", "zed", "/", "project")}`],
			["localhost file URL", `file://localhost${posixHome("Users", "zed", "project")}`],
		];

		it.each(shapedPaths)("flags %s for a non-blessed name", async (_, fixture) => {
			writeFile("src/launch.ts", `const tool = "${fixture}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toHaveLength(1);
		});

		it("flags the same findings whichever account runs the scan", async () => {
			writeFile(
				"src/launch.ts",
				[
					`const own = "${posixHome("home", "alice-dev", "x")}";`,
					`const other = "${posixHome("home", "ci-account", "x")}";`,
				].join("\n"),
			);

			const asDeveloper = await hardcodedPathDiagnostics(["typescript"], [], {
				accountHome: posixHome("home", "alice-dev"),
			});
			const asCiAccount = await hardcodedPathDiagnostics(["typescript"], [], {
				accountHome: posixHome("home", "ci-account"),
			});

			expect(asDeveloper).toHaveLength(2);
			expect(asCiAccount).toEqual(asDeveloper);
		});

		it.each([
			"runner",
			"runneradmin",
			"root",
			"user",
			"username",
			"default",
			"defaultuser",
			"example",
			"Example",
			"EXAMPLE",
			"public",
			"shared",
			"someone",
			"me",
			"your-name",
			"yourname",
			"runner~1",
			"RUNNER~1",
		])("does not flag the blessed name %s on any shape", async (name) => {
			writeFile(
				"src/launch.ts",
				[
					posixHome("home", name, "work", "repo"),
					posixHome("Users", name, "work", "repo"),
					windowsHome("C", name, "\\", "work", "repo"),
				]
					.map((fixture, index) => `const tool${index} = "${fixture}";`)
					.join("\n"),
			);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toEqual([]);
		});

		it.each(["zed", "ZED"])("does not flag allowedPlaceholders entry matching %s", async (name) => {
			writeFile("src/launch.ts", `const tool = "${posixHome("home", name, "project")}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], {
				allowedPlaceholders: ["zed"],
			});

			expect(diagnostics).toEqual([]);
		});

		it("still flags other names when allowedPlaceholders is set", async () => {
			writeFile("src/launch.ts", `const tool = "${posixHome("home", "yan", "project")}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], {
				allowedPlaceholders: ["zed"],
			});

			expect(diagnostics).toHaveLength(1);
		});

		it.each(["alice", "zed", "alice-dev"])("flags the non-blessed name %s", async (name) => {
			writeFile("src/launch.ts", `const tool = "${posixHome("home", name, "x")}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toHaveLength(1);
		});

		it("flags a longer name that starts with a blessed name", async () => {
			writeFile("src/launch.ts", `const tool = "${posixHome("home", "example-dev", "x")}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toHaveLength(1);
		});

		it("ignores the account home when it has a non-standard shape", async () => {
			const customHome = posixHome("srv", "alice-dev");
			writeFile("src/launch.ts", `const tool = "${customHome}/x";`);

			const asOwner = await hardcodedPathDiagnostics(["typescript"], [], {
				accountHome: customHome,
			});
			const asOther = await hardcodedPathDiagnostics(["typescript"], [], {
				accountHome: posixHome("srv", "other"),
			});

			expect(asOwner).toEqual([]);
			expect(asOther).toEqual([]);
		});

		it.each([
			["a host named home", "file://home/zed/project"],
			["a remote host", "file://server" + posixHome("home", "zed", "x")],
			["a remote host with a drive root", "file://server/" + windowsHome("C", "zed", "/", "x")],
			[
				"a remote share with an embedded =/home suffix (issue-101)",
				`file://server/share/name=${posixHome("home", "zed", "x")}`,
			],
			[
				"a remote share with a query =/home suffix (issue-101)",
				`file://server/share?next=${posixHome("home", "zed", "x")}`,
			],
			[
				"a remote share with a query drive suffix (issue-101)",
				`file://server/share?next=${windowsHome("C", "zed", "/", "x")}`,
			],
			[
				"a non-home local file URL with a query =/home suffix (issue-101)",
				`file:/etc/config?next=${posixHome("home", "zed", "x")}`,
			],
		])("does not flag a file URL with %s as its authority", async (_, fixture) => {
			writeFile("src/launch.ts", `const tool = "${fixture}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toEqual([]);
		});

		it.each([
			["a template variable", "/home/$" + "{name}/x"],
			["a shell variable", "/home/$" + "USER/x"],
			["a Windows variable", "C:\\Users\\%" + "USERNAME%\\x"],
			["an angle-bracket name", "/home/<name>/x"],
			["a glob", "/home/*/x"],
			["a web URL", "https://example.com/home/zed/x"],
			["a mid-token route", "/api/home/zed/x"],
			["a bare directory", "/home/"],
			["the superuser root directory", "/root/.ssh/config"],
		])("does not flag %s", async (_, fixture) => {
			writeFile("src/launch.ts", `const tool = "${fixture}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toEqual([]);
		});

		it("reports a banned root and the shape on one path once", async () => {
			writeFile(
				"src/launch.ts",
				[
					`const tool = "${posixHome("home", "zed", "project")}";`,
					`const nestedRoot = "${posixHome("home", "zed", "folder=/mnt/data/team/x")}";`,
				].join("\n"),
			);

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				[posixHome("home", "zed", "project"), "/mnt/data/team"],
			);

			expect(diagnostics).toHaveLength(2);
		});
	});

	describe("banned root resolution", () => {
		it("[A] flags a path under a configured non-standard root", async () => {
			writeFile("src/launch.ts", 'const tool = "/mnt/data/zed/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/zed"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[B] flags a configured root named for a blessed name", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/example/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[C] does not flag a non-standard path that is not configured", async () => {
			writeFile("src/launch.ts", 'const tool = "/mnt/data/zed/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toEqual([]);
		});

		it("[E] collapses overlapping configured roots to one diagnostic", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/example/project/tool";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				["/home/example", "/home/example/project"],
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[F] flags a Windows file URL form matching a configured root once", async () => {
			writeFile("src/launch.ts", 'const tool = "file:///C:/Users/example/x";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				[String.raw`C:\Users\example`],
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[G] flags a bare configured root with no descendant", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/example";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[H] does not flag a configured root appearing inside a web URL", async () => {
			writeFile("src/launch.ts", 'const u = "https://example.com/home/example/profile";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toEqual([]);
		});

		it("[I] flags the motivating ExecStart case for the source issue", async () => {
			writeFile(
				"src/service.ts",
				'const unitFile = "ExecStart=/home/example/schoen-lab/.venv/bin/pr-crew";',
			);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[J] does not flag a route that merely contains '/home' mid-token", async () => {
			writeFile("src/routes.ts", 'router.get("/api/home/customer/orders", handler);');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toEqual([]);
		});
	});

	describe("rejects non-absolute configured roots", () => {
		const withStderr = async (run: () => Promise<void>): Promise<string> => {
			const chunks: string[] = [];
			const originalWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = (chunk: unknown) => {
				chunks.push(String(chunk));
				return true;
			};
			try {
				await run();
			} finally {
				process.stderr.write = originalWrite;
			}
			return chunks.join("");
		};

		// Regression: `const name = "example";` must stay clean when a config typo
		// hands the detector `bannedRoots: ["example"]` - a bare word with no
		// leading separator would otherwise build a matcher with no
		// path-boundary requirement and flag the plain identifier.
		it.each([
			["example", "bare word"],
			["home/example", "relative path"],
			["", "empty string"],
			["./relative", "dot-relative path"],
		])("drops a non-absolute banned root (%s: %s) with a visible warning", async (root) => {
			writeFile("src/launch.ts", 'const name = "example";');
			let diagnostics: Awaited<ReturnType<typeof detectHardcodedUserPaths>> = [];
			const stderr = await withStderr(async () => {
				diagnostics = await hardcodedPathDiagnostics(["typescript"], [root]);
			});

			expect(diagnostics).toEqual([]);
			expect(stderr).toContain("bannedRoots");
			expect(stderr).toContain(JSON.stringify(root));
		});

		it("still flags a valid root alongside a rejected one in the same list", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/example/project/tool";');
			let diagnostics: Awaited<ReturnType<typeof detectHardcodedUserPaths>> = [];

			const stderr = await withStderr(async () => {
				diagnostics = await hardcodedPathDiagnostics(["typescript"], ["example", "/home/example"]);
			});

			expect(diagnostics).toHaveLength(1);
			expect(stderr).toContain("bannedRoots");
		});
	});

	it.each([
		["Linux", "/home/example", "/home/example/project/tool"],
		["macOS", "/Users/example", "/Users/example/project/tool"],
		["Windows", String.raw`C:\Users\example`, String.raw`C:\Users\example\project\tool`],
	])("flags the exact %s home root and a descendant", async (_, homeDirectory, descendant) => {
		writeFile(
			"src/launch.ts",
			[`const homeDirectory = "${homeDirectory}";`, `const tool = "${descendant}";`].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toEqual([
			expect.objectContaining({ filePath: "src/launch.ts", line: 1 }),
			expect.objectContaining({ filePath: "src/launch.ts", line: 2 }),
		]);
	});

	it("accepts raw, escaped, mixed, forward-slash, and case-varied Windows paths", async () => {
		const homeDirectory = String.raw`C:\Users\Example Doe`;
		const variants = [
			String.raw`C:\Users\Example Doe\project\tool.exe`,
			String.raw`C:\\Users\\Example Doe\\project\\tool.exe`,
			String.raw`C:\Users/Example Doe\project/tool.exe`,
			"C:/Users/Example Doe/project/tool.exe",
			String.raw`c:\users\example doe\project\tool.exe`,
		];
		writeFile("src/launch.ts", variants.map((value) => `const tool = "${value}";`).join("\n"));

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(variants.length);
	});

	it("matches local POSIX file URLs without treating an arbitrary authority as local", async () => {
		const homeDirectory = "/home/example";
		writeFile(
			"src/launch.ts",
			[
				'const compact = "file:/home/example/project";',
				'const standard = "file:///home/example/project";',
				'const localhost = "file://localhost/home/example/project";',
				'const authority = "file://home/example/project";',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(3);
	});

	it("matches the localhost authority case-insensitively", async () => {
		writeFile("src/launch.ts", 'const tool = "file://LOCALHOST/home/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("does not treat a non-localhost, non-empty authority as local for a POSIX root", async () => {
		writeFile("src/launch.ts", 'const tool = "file://remotehost/home/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("does not treat a non-localhost, non-empty authority as local for a Windows drive root", async () => {
		writeFile("src/launch.ts", 'const tool = "file://remotehost/C:/Users/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\example`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("does not double-report a single file://localhost URL", async () => {
		writeFile("src/launch.ts", 'const tool = "file://localhost/home/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toHaveLength(1);
	});

	it.each([
		["configured root", "C:/Users/example/project/tool", [String.raw`C:\Users\example`]],
		[
			"default shape without bannedRoots (issue-101)",
			windowsHome("C", "zed", "/", "project", "tool"),
			[],
		],
	])(
		"reports equivalent Windows file URL spellings once each, including localhost (%s)",
		async (_, userPath, bannedRoots) => {
			const variants = [
				`file:/${userPath}`,
				`file://${userPath}`,
				`file:///${userPath}`,
				`file://localhost/${userPath}`,
			];
			writeFile("src/launch.ts", variants.map((value) => `const tool = "${value}";`).join("\n"));

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], bannedRoots);

			expect(diagnostics).toHaveLength(variants.length);
		},
	);

	it("does not double-report a single file://localhost URL for a Windows drive root", async () => {
		writeFile("src/launch.ts", 'const tool = "file://localhost/C:/Users/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\example`],
		);

		expect(diagnostics).toHaveLength(1);
	});

	it("ignores a POSIX home embedded in a Windows file URL", async () => {
		writeFile("src/launch.ts", 'const tool = "file:///C:/home/example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("accepts UNC root, descendant, escaped, forward-slash, and file URL spellings", async () => {
		const homeDirectory = String.raw`\\server\profiles\example`;
		const variants = [
			homeDirectory,
			String.raw`\\server\profiles\example\project\tool.exe`,
			String.raw`\\\\server\\profiles\\example\\project\\tool.exe`,
			"//server/profiles/example/project/tool.exe",
			"file://server/profiles/example/project/tool.exe",
			String.raw`\\SERVER\PROFILES\Example\project\tool.exe`,
		];
		writeFile(
			"src/launch.ts",
			variants.map((value) => `const tool = String.raw\`${value}\`;`).join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(variants.length);
	});

	it("does not treat the localhost authority as equivalent to a UNC server name", async () => {
		// file://localhost/server/... names a different machine's local root
		// (with a literal "server" path segment), not the UNC \\server\... share.
		// Node throws ERR_INVALID_FILE_URL_PATH resolving this form for a UNC
		// path, so it must not be reported as the configured UNC root.
		writeFile(
			"src/launch.ts",
			'const tool = "file://localhost/server/profiles/example/project/tool.exe";',
		);

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`\\server\profiles\example`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("ignores a UNC home nested under another file URL authority", async () => {
		writeFile(
			"src/launch.ts",
			'const tool = "file://other/server/profiles/example/project/tool.exe";',
		);

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`\\server\profiles\example`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("scans production, test, comment, Java, and Python source", async () => {
		const homeDirectory = "/home/example";
		writeFile("src/launch.ts", 'const tool = "/home/example/project/tool";');
		writeFile("tests/service.test.ts", "// installed at /home/example/project/tool\n");
		writeFile("src/path-resolver.java", 'var path = Paths.get("/home/example/project");\n');
		writeFile("src/cache.py", 'tool = cache.get("/home/example/project/tool")\n');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript", "java", "python"],
			[homeDirectory],
		);

		expect(diagnostics.map(({ filePath }) => filePath).sort()).toEqual([
			"src/cache.py",
			"src/launch.ts",
			"src/path-resolver.java",
			"tests/service.test.ts",
		]);
	});

	it("matches supported token boundaries without matching nested paths", async () => {
		const linuxHome = posixHome("home", "zed");
		const macHome = posixHome("Users", "zed");
		const otherLinuxHome = posixHome("home", "yan", "x");
		const allowedLinuxHome = posixHome("home", "allowed-user", "bin2");
		const allowedWindowsHome = windowsHome("C", "allowed-user", "/", "bin");
		const windowsZedSlash = windowsHome("D", "zed", "/", "bin");
		const windowsZedBackslash = windowsHome("D", "zed", "\\", "bin");
		const windowsYanSlash = windowsHome("D", "yan", "/", "bin");
		writeFile(
			"src/paths.ts",
			[
				`${linuxHome}/project`,
				`// installed at ${linuxHome}/project`,
				`ExecStart=${linuxHome}/project/tool`,
				`PATH=/usr/bin:${linuxHome}/bin`,
				`PATH=/usr/bin:${macHome}/bin`,
				`PATH=${linuxHome}:/usr/bin`,
				`const posixFolderEquals = "${linuxHome}/folder=${otherLinuxHome}";`,
				`const windowsFolderEquals = "${windowsHome("C", "zed", "/", `folder=${otherLinuxHome}`)}";`,
				`const blessedPosixFolderEquals = "/home/example/folder=${otherLinuxHome}";`,
				`const blessedWindowsFolderEquals = "C:/Users/example/folder=${otherLinuxHome}";`,
				`PATH=/home/example/bin2:${linuxHome}/bin`,
				`PATH=/Users/example/bin/:${macHome}/bin`,
				`PATH=${allowedLinuxHome}:${linuxHome}/bin`,
				`PATH=${linuxHome}/bin2:${otherLinuxHome}`,
				`PATH=${linuxHome}/bin2:/mnt/data/team/bin`,
				`PATH=/mnt/data/team/bin:${linuxHome}/bin`,
				`paths=/home/example/x,${linuxHome}/y`,
				`PATH=C:/Users/example/bin;${windowsZedSlash}`,
				`PATH=${windowsHome("C", "example", "\\", "bin")};${windowsZedBackslash}`,
				`PATH=${allowedWindowsHome};${windowsZedSlash}`,
				`PATH=${windowsHome("C", "zed", "/", "bin")};${windowsYanSlash}`,
				`file:///C:/Users/example/x;${windowsHome("D", "zed", "/", "y")}`,
				`const repeatedPosix = "${linuxHome}////project";`,
				`const repeatedWindows = "${windowsHome("C", "zed", "/")}////project";`,
				`const repeatedFile = "file://${linuxHome}////project";`,
				`const malformedPosix = "${linuxHome}////<";`,
				`const malformedMac = "${macHome}////<";`,
				`const malformedWindowsSlash = "${windowsHome("C", "zed", "/")}////<";`,
				`const malformedWindowsBackslash = "${windowsHome("C", "zed", "\\")}\\\\\\\\<";`,
				`const malformedFilePosix = "file://${linuxHome}////<";`,
				`const malformedFileWindows = "file:///${windowsHome("C", "zed", "/")}////<";`,
				`const nested = "/srv/site${linuxHome}/project";`,
				`const driveNested = "C:${linuxHome}/project";`,
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/team"], {
			allowedPlaceholders: ["allowed-user"],
		});

		expect(diagnostics).toEqual([
			expect.objectContaining({ line: 1, column: 1 }),
			expect.objectContaining({ line: 2 }),
			expect.objectContaining({ line: 3 }),
			expect.objectContaining({ line: 4 }),
			expect.objectContaining({ line: 5 }),
			expect.objectContaining({ line: 6 }),
			expect.objectContaining({ line: 7, column: 28 }),
			expect.objectContaining({ line: 8, column: 30 }),
			expect.objectContaining({ line: 11, column: 25 }),
			expect.objectContaining({ line: 12, column: 26 }),
			expect.objectContaining({ line: 13, column: 30 }),
			expect.objectContaining({ line: 14, column: 6 }),
			expect.objectContaining({ line: 14, column: 21 }),
			expect.objectContaining({ line: 15, column: 6 }),
			expect.objectContaining({ line: 15, column: 21 }),
			expect.objectContaining({ line: 16, column: 6 }),
			expect.objectContaining({ line: 16, column: 25 }),
			expect.objectContaining({ line: 17, column: 23 }),
			expect.objectContaining({ line: 18, column: 27 }),
			expect.objectContaining({ line: 19, column: 27 }),
			expect.objectContaining({ line: 20, column: 32 }),
			expect.objectContaining({ line: 21, column: 6 }),
			expect.objectContaining({ line: 21, column: 23 }),
			expect.objectContaining({ line: 22, column: 28 }),
			expect.objectContaining({ line: 23, column: 24 }),
			expect.objectContaining({ line: 24, column: 26 }),
			expect.objectContaining({ line: 25, column: 23 }),
		]);
	});

	it("ignores web URLs while finding a later local path on the same large line", async () => {
		const homeDirectory = "/home/example";
		const urls = Array.from(
			{ length: 8_000 },
			(_, index) => `https://example.test/${index}/home/example/project`,
		);
		writeFile(
			"src/urls.ts",
			`${urls.map((value) => `"${value}"`).join(",")},"/home/example/project"`,
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(1);
	});

	it("ignores a non-standard path for a different user", async () => {
		writeFile("src/launch.ts", 'const tool = "/mnt/data/unrelated/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/current-user"]);

		expect(diagnostics).toEqual([]);
	});

	it("ignores arbitrary and templated web routes that do not share a configured root", async () => {
		writeFile(
			"src/routes.ts",
			[
				'router.get("/home/{tenant}/detail", handler);',
				'router.get("/api/{tenant}/home/example/summary", handler);',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("flags the configured home path regardless of receiver name", async () => {
		writeFile("src/cache.ts", 'cache.get("/home/example/project/tool")');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("flags a file URL even when it is passed to a route-like receiver", async () => {
		writeFile("src/routes.ts", 'router.get("file:///home/example/project/tool", handler);');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("does not match a longer username that starts with the configured home root", async () => {
		writeFile("src/launch.ts", 'const tool = "/mnt/data/example-other/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("uses case-sensitive matching for POSIX home directories", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/Example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("ignores portable absolute paths outside the configured home directory", async () => {
		writeFile(
			"src/system.ts",
			[
				'const configuration = "/etc/service/config.yml";',
				'const executable = "/usr/local/bin/service";',
				String.raw`const program = "C:\\Program Files\\Service\\service.exe";`,
				'const driveNested = "C:/home/example/project";',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("returns no diagnostics when the only configured root normalizes to empty", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/"]);

		expect(diagnostics).toEqual([]);
	});

	it("skips auto-generated source files", async () => {
		writeFile("src/client.ts", '// auto-generated\nconst tool = "/home/example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("skips a source file that cannot be read", async () => {
		writeFile("src/unreadable.ts", 'const tool = "/home/example/project/tool";');
		vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
			throw new Error("simulated read failure");
		});

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});
});

describe("dropContainedSpans overlap resolution scales linearly", () => {
	// Counts property reads instead of measuring wall-clock time. A quadratic
	// implementation (each span compared against every previously kept span,
	// as in `kept.some((k) => ...)`) reads `.end` roughly n^2 times; the O(n)
	// sweep here reads each span's `.start`/`.end` a small constant number of
	// times regardless of input size, plus the O(n log n) sort comparator.
	const countingSpans = (spanCount: number, counter: { reads: number }): CandidateSpan[] =>
		Array.from({ length: spanCount }, (_, index) => {
			const start = index * 10;
			const end = start + 5;
			return {
				get start() {
					counter.reads++;
					return start;
				},
				get end() {
					counter.reads++;
					return end;
				},
			};
		});

	const countPropertyReads = (spanCount: number): number => {
		const counter = { reads: 0 };
		dropContainedSpans(countingSpans(spanCount, counter));
		return counter.reads;
	};

	it("keeps all non-overlapping spans", () => {
		const spans = countingSpans(500, { reads: 0 });
		expect(dropContainedSpans(spans)).toHaveLength(500);
	});

	it("reads span properties O(n log n) times, not O(n^2), as span count quadruples", () => {
		const small = countPropertyReads(2_000);
		const large = countPropertyReads(8_000);

		// n log n growth for a 4x input increase is roughly 4x-5x; O(n^2) growth
		// is roughly 16x. A threshold of 8 cleanly separates the two.
		expect(large / small).toBeLessThan(8);
	});
});
