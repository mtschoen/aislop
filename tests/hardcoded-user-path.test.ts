import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CandidateSpan,
	detectHardcodedUserPaths,
	dropContainedSpans,
} from "../src/engines/ai-slop/hardcoded-user-path.js";
import * as homePathConstSpans from "../src/engines/ai-slop/home-path-const-spans.js";
import { isHomePathDataFile } from "../src/engines/ai-slop/home-path-location-policy.js";
import { aiSlopEngine } from "../src/engines/ai-slop/index.js";
import type { EngineContext } from "../src/engines/types.js";
import * as sourceFiles from "../src/utils/source-files.js";

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
		writeFile("src/launch.ts", `let   tool = "${homeDirectory}/project";`);

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
			writeFile("src/launch.ts", `let   tool = "${fixture}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toHaveLength(1);
		});

		it("flags the same findings whichever account runs the scan", async () => {
			writeFile(
				"src/launch.ts",
				[
					`let   own = "${posixHome("home", "alice-dev", "x")}";`,
					`let   other = "${posixHome("home", "ci-account", "x")}";`,
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

		it.each(["example", "Example", "EXAMPLE", "someone", "me"])(
			"does not flag the blessed name %s on any shape",
			async (name) => {
				writeFile(
					"src/launch.ts",
					[
						posixHome("home", name, "work", "repo"),
						posixHome("Users", name, "work", "repo"),
						windowsHome("C", name, "\\\\", "work", "repo"),
					]
						.map((fixture) => `consume("${fixture}");`)
						.join("\n"),
				);

				const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

				expect(diagnostics).toEqual([]);
			},
		);

		it.each(["zed", "ZED", "runner", "RUNNER"])(
			"does not flag allowedPlaceholders entry matching %s",
			async (name) => {
				writeFile("src/launch.ts", `consume("${posixHome("home", name, "project")}");`);

				const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], {
					allowedPlaceholders: [name.toLowerCase()],
				});

				expect(diagnostics).toEqual([]);
			},
		);

		it("still flags other names when allowedPlaceholders is set", async () => {
			writeFile("src/launch.ts", `consume("${posixHome("home", "yan", "project")}");`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], {
				allowedPlaceholders: ["zed"],
			});

			expect(diagnostics).toHaveLength(1);
		});

		it.each([
			"alice",
			"zed",
			"alice-dev",
			"runner",
			"runneradmin",
			"root",
			"user",
			"username",
			"default",
			"defaultuser",
			"public",
			"shared",
			"your-name",
			"yourname",
			"runner~1",
			"RUNNER~1",
		])("flags the non-blessed name %s", async (name) => {
			writeFile(
				"src/launch.ts",
				[
					posixHome("home", name, "x"),
					posixHome("Users", name, "x"),
					windowsHome("C", name, "\\\\", "x"),
				]
					.map((value) => `consume("${value}");`)
					.join("\n"),
			);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toHaveLength(3);
		});

		it("flags a longer name that starts with a blessed name", async () => {
			writeFile("src/launch.ts", `let   tool = "${posixHome("home", "example-dev", "x")}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toHaveLength(1);
		});

		it("ignores the account home when it has a non-standard shape", async () => {
			const customHome = posixHome("srv", "alice-dev");
			writeFile("src/launch.ts", `let   tool = "${customHome}/x";`);

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
			writeFile("src/launch.ts", `let   tool = "${fixture}";`);

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
			writeFile("src/launch.ts", `let   tool = "${fixture}";`);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toEqual([]);
		});

		it("reports a banned root and the shape on one path once", async () => {
			writeFile(
				"src/launch.ts",
				[
					`let   tool = "${posixHome("home", "zed", "project")}";`,
					`let   nestedRoot = "${posixHome("home", "zed", "folder=/mnt/data/team/x")}";`,
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
			writeFile("src/launch.ts", 'let   tool = "/mnt/data/zed/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/zed"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[B] flags a configured root named for a blessed name", async () => {
			writeFile("src/launch.ts", 'let   tool = "/home/example/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[C] does not flag a non-standard path that is not configured", async () => {
			writeFile("src/launch.ts", 'let   tool = "/mnt/data/zed/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

			expect(diagnostics).toEqual([]);
		});

		it("[E] collapses overlapping configured roots to one diagnostic", async () => {
			writeFile("src/launch.ts", 'let   tool = "/home/example/project/tool";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				["/home/example", "/home/example/project"],
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[F] flags a Windows file URL form matching a configured root once", async () => {
			writeFile("src/launch.ts", 'let   tool = "file:///C:/Users/example/x";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				[String.raw`C:\Users\example`],
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[G] flags a bare configured root with no descendant", async () => {
			writeFile("src/launch.ts", 'let   tool = "/home/example";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[H] does not flag a configured root appearing inside a web URL", async () => {
			writeFile("src/launch.ts", 'let   u = "https://example.com/home/example/profile";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

			expect(diagnostics).toEqual([]);
		});

		it("[I] flags the motivating ExecStart case for the source issue", async () => {
			writeFile(
				"src/service.ts",
				'let   unitFile = "ExecStart=/home/example/schoen-lab/.venv/bin/pr-crew";',
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
			writeFile("src/launch.ts", 'let   name = "example";');
			let diagnostics: Awaited<ReturnType<typeof detectHardcodedUserPaths>> = [];
			const stderr = await withStderr(async () => {
				diagnostics = await hardcodedPathDiagnostics(["typescript"], [root]);
			});

			expect(diagnostics).toEqual([]);
			expect(stderr).toContain("bannedRoots");
			expect(stderr).toContain(JSON.stringify(root));
		});

		it("still flags a valid root alongside a rejected one in the same list", async () => {
			writeFile("src/launch.ts", 'let   tool = "/home/example/project/tool";');
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
			[`let   homeDirectory = "${homeDirectory}";`, `let   tool = "${descendant}";`].join("\n"),
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
		writeFile("src/launch.ts", variants.map((value) => `let   tool = "${value}";`).join("\n"));

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(variants.length);
	});

	it("matches local POSIX file URLs without treating an arbitrary authority as local", async () => {
		const homeDirectory = "/home/example";
		writeFile(
			"src/launch.ts",
			[
				'let   compact = "file:/home/example/project";',
				'let   standard = "file:///home/example/project";',
				'let   localhost = "file://localhost/home/example/project";',
				'let   authority = "file://home/example/project";',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(3);
	});

	it("matches the localhost authority case-insensitively", async () => {
		writeFile("src/launch.ts", 'let   tool = "file://LOCALHOST/home/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("does not treat a non-localhost, non-empty authority as local for a POSIX root", async () => {
		writeFile("src/launch.ts", 'let   tool = "file://remotehost/home/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("does not treat a non-localhost, non-empty authority as local for a Windows drive root", async () => {
		writeFile("src/launch.ts", 'let   tool = "file://remotehost/C:/Users/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\example`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("does not double-report a single file://localhost URL", async () => {
		writeFile("src/launch.ts", 'let   tool = "file://localhost/home/example/project";');

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
			writeFile("src/launch.ts", variants.map((value) => `let   tool = "${value}";`).join("\n"));

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], bannedRoots);

			expect(diagnostics).toHaveLength(variants.length);
		},
	);

	it("does not double-report a single file://localhost URL for a Windows drive root", async () => {
		writeFile("src/launch.ts", 'let   tool = "file://localhost/C:/Users/example/project";');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\example`],
		);

		expect(diagnostics).toHaveLength(1);
	});

	it("ignores a POSIX home embedded in a Windows file URL", async () => {
		writeFile("src/launch.ts", 'let   tool = "file:///C:/home/example/project/tool";');

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
			'let   tool = "file://localhost/server/profiles/example/project/tool.exe";',
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
			'let   tool = "file://other/server/profiles/example/project/tool.exe";',
		);

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`\\server\profiles\example`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("scans production, test, comment, Java, and Python source", async () => {
		const homeDirectory = "/home/example";
		writeFile("src/launch.ts", 'let   tool = "/home/example/project/tool";');
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
				`let   posixFolderEquals = "${linuxHome}/folder=${otherLinuxHome}";`,
				`let   windowsFolderEquals = "${windowsHome("C", "zed", "/", `folder=${otherLinuxHome}`)}";`,
				`let   blessedPosixFolderEquals = "/home/example/folder=${otherLinuxHome}";`,
				`let   blessedWindowsFolderEquals = "C:/Users/example/folder=${otherLinuxHome}";`,
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
				`let   repeatedPosix = "${linuxHome}////project";`,
				`let   repeatedWindows = "${windowsHome("C", "zed", "/")}////project";`,
				`let   repeatedFile = "file://${linuxHome}////project";`,
				`let   malformedPosix = "${linuxHome}////<";`,
				`let   malformedMac = "${macHome}////<";`,
				`let   malformedWindowsSlash = "${windowsHome("C", "zed", "/")}////<";`,
				`let   malformedWindowsBackslash = "${windowsHome("C", "zed", "\\")}\\\\\\\\<";`,
				`let   malformedFilePosix = "file://${linuxHome}////<";`,
				`let   malformedFileWindows = "file:///${windowsHome("C", "zed", "/")}////<";`,
				`let   nested = "/srv/site${linuxHome}/project";`,
				`let   driveNested = "C:${linuxHome}/project";`,
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
		writeFile("src/launch.ts", 'let   tool = "/mnt/data/unrelated/project/tool";');

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
		writeFile("src/launch.ts", 'let   tool = "/mnt/data/example-other/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("uses case-sensitive matching for POSIX home directories", async () => {
		writeFile("src/launch.ts", 'let   tool = "/home/Example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("ignores portable absolute paths outside the configured home directory", async () => {
		writeFile(
			"src/system.ts",
			[
				'let   configuration = "/etc/service/config.yml";',
				'let   executable = "/usr/local/bin/service";',
				String.raw`let   program = "C:\\Program Files\\Service\\service.exe";`,
				'let   driveNested = "C:/home/example/project";',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("returns no diagnostics when the only configured root normalizes to empty", async () => {
		writeFile("src/launch.ts", 'let   tool = "/home/example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/"]);

		expect(diagnostics).toEqual([]);
	});

	it("skips auto-generated source files", async () => {
		writeFile("src/client.ts", '// auto-generated\nlet   tool = "/home/example/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it("skips a source file that cannot be read", async () => {
		writeFile("src/unreadable.ts", 'let   tool = "/home/example/project/tool";');
		vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
			throw new Error("simulated read failure");
		});

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/example"]);

		expect(diagnostics).toEqual([]);
	});

	it.each([
		['const value = "PATH";', 0],
		['const value: string = "PATH";', 0],
		["const value = `PATH`;", 0],
		['const first = "PATH", second = "PATH";', 0],
		['export const value = "PATH";', 1],
		['const value = "PATH"; export { value };', 1],
		['const value = "PATH"; export { value as renamed };', 1],
		['export { value as default }; const value = "PATH";', 1],
		['const value = "PATH"; export default value;', 1],
		['const value = "PATH"; export = value;', 1],
		['const value = "PATH"; export { value } from "./other";', 0],
		['function launch() { const value = "PATH"; }', 1],
		['{ const value = "PATH"; }', 1],
		['namespace N { const value = "PATH"; }', 1],
		['let value = "PATH";', 1],
		['var value = "PATH";', 1],
		['const value = ("PATH");', 1],
		['const value = "PATH" as const;', 1],
		['const value = "PATH" satisfies string;', 1],
		['const value = "PATH" + "/child";', 1],
		["const value = String.raw`PATH`;", 1],
		["const value = `PATH/${suffix}`;", 1],
		['const value = input ?? "PATH";', 1],
		['const value = getenv("HOME", "PATH");', 1],
		['consume("PATH");', 1],
		['const value = "PATH"; consume("PATH"); // PATH', 2],
	])("applies the const policy to %s", async (source, count) => {
		const fixture = posixHome("home", "zed", "project");
		writeFile("src/launch.ts", source.replaceAll("PATH", fixture));
		expect(await hardcodedPathDiagnostics(["typescript"], [])).toHaveLength(count);
	});

	it.each([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])(
		"allows a direct const initializer in %s",
		async (extension) => {
			writeFile(
				`src/launch${extension}`,
				`const value = "${posixHome("home", "zed", "project")}";`,
			);
			expect(await hardcodedPathDiagnostics(["typescript", "javascript"], [])).toEqual([]);
		},
	);

	it("applies location allowances to configured roots too", async () => {
		writeFile(
			"src/launch.ts",
			['const value = "/mnt/data/team/x";', 'consume("/mnt/data/team/x");'].join("\n"),
		);
		expect(await hardcodedPathDiagnostics(["typescript"], ["/mnt/data/team"])).toEqual([
			expect.objectContaining({ line: 2, column: 10 }),
		]);
	});

	it("keeps same-line and CRLF coordinates outside the allowed literal", async () => {
		const fixture = posixHome("home", "zed", "project");
		const line = `const value = "${fixture}"; consume("${fixture}"); // ${fixture}`;
		writeFile("src/launch.ts", `// header\r\n${line}\r\n`);
		expect(await hardcodedPathDiagnostics(["typescript"], [])).toEqual([
			expect.objectContaining({
				line: 2,
				column: line.indexOf(fixture, line.indexOf(fixture) + 1) + 1,
			}),
			expect.objectContaining({ line: 2, column: line.lastIndexOf(fixture) + 1 }),
		]);
	});

	it.each([
		"settings.json",
		"settings.jsonc",
		"settings.yaml",
		"settings.yml",
		"settings.toml",
		"settings.ini",
		"settings.cfg",
		"settings.conf",
		"settings.env",
		".env",
		".env.local",
		"sub/.env.production",
		"sub\\.env.production",
		"SETTINGS.JSON",
		".env.local.ts",
	])("explicitly allows the data filename %s", async (fileName) => {
		expect(isHomePathDataFile(fileName)).toBe(true);
		const normalizedRelative = fileName.replaceAll("\\", "/");
		writeFile(normalizedRelative, posixHome("home", "user", "x"));
		const selected = path.join(temporaryDirectory, normalizedRelative);
		vi.spyOn(sourceFiles, "getSourceFiles").mockReturnValue([selected]);
		vi.spyOn(sourceFiles, "getTestFiles").mockReturnValue([]);
		expect(await hardcodedPathDiagnostics(["typescript"], [posixHome("home", "user")])).toEqual([]);
	});

	it.each([
		"tool.config.ts",
		"tool.config.js",
		"settings.json.ts",
		".env/tool.ts",
		"settings.env.local",
		"notes.md",
		"settings.conf.bak",
	])("does not classify %s as data configuration", (fileName) => {
		expect(isHomePathDataFile(fileName)).toBe(false);
	});

	it.each(["tool.config.ts", "tool.config.js"])(
		"checks inline defaults in %s",
		async (fileName) => {
			writeFile(fileName, `consume("${posixHome("home", "user", "x")}");`);
			expect(await hardcodedPathDiagnostics(["typescript", "javascript"], [])).toHaveLength(1);
		},
	);

	it.each([
		["src/cache.py", "python", 'DEFAULT = "PATH"'],
		["src/Cache.cs", "csharp", 'class Cache { private const string Value = "PATH"; }'],
		["src/Program.cs", "csharp", 'const string value = "PATH";'],
	] as const)(
		"does not guess a structural allowance for %s",
		async (fileName, language, source) => {
			writeFile(fileName, source.replaceAll("PATH", posixHome("home", "user", "x")));
			expect(await hardcodedPathDiagnostics([language], [])).toHaveLength(1);
		},
	);

	it.each([
		["src/launch.cjs", 'const value = "PATH"; module.exports = value;', 1],
		["src/launch.cjs", 'const value = "PATH"; exports.value = value;', 1],
		["src/launch.ts", 'const value = "PATH"; module.exports = value;', 1],
		["src/launch.tsx", 'const value = "PATH"; module.exports = value;', 1],
		["src/launch.ts", 'const value = "PATH"; exports.value = value;', 1],
		["src/launch.tsx", 'const value = "PATH"; exports.value = value;', 1],
		["src/launch.ts", 'const value = "PATH"; module["exports"] = value;', 1],
		["src/launch.ts", 'const value = "PATH"; module.exports.value = value;', 1],
		["src/launch.ts", 'const value = "PATH"; (exports as any).nested.value = value;', 1],
		[
			"src/launch.js",
			'const value = "PATH"; Object.defineProperty(exports, "value", { value });',
			1,
		],
		[
			"src/launch.ts",
			'const value = "PATH"; Object.defineProperty(module.exports, "value", { value });',
			1,
		],
		["src/launch.js", 'const value = "PATH"; module.exports = value; export {};', 1],
		["src/launch.js", 'const value = "PATH"; exports.value = value; export {};', 1],
		["src/launch.ts", 'const value = "PATH"; module.exports = value; export {};', 1],
		["src/launch.ts", 'const value = "PATH"; exports.value = value; export {};', 1],
		["src/launch.js", 'const value = "PATH"; const fs = require("node:fs");', 0],
		["src/launch.jsx", 'const value = "PATH"; const fs = require("node:fs");', 0],
		["src/launch.mjs", 'const value = "PATH"; const fs = require("node:fs");', 0],
		["src/launch.cjs", 'const value = "PATH"; const fs = require("node:fs");', 0],
		["src/launch.ts", 'const value = "PATH"; const fs = require("node:fs");', 0],
		["src/launch.js", 'const value = "PATH"; function load() { return require("node:fs"); }', 0],
		["src/launch.cjs", 'const value = "PATH"; function load() { return require("node:fs"); }', 0],
		["src/launch.js", 'const value = "PATH"; const exports = {}; exports.other = 1;', 0],
		["src/launch.cjs", 'const value = "PATH"; const exports = {}; exports.other = 1;', 0],
		["src/launch.ts", 'const value = "PATH"; const exports = { other: 0 }; exports.other = 1;', 0],
		[
			"src/launch.js",
			'const value = "PATH"; const module = { exports: {} }; module.exports = 1;',
			0,
		],
		[
			"src/launch.cjs",
			'const value = "PATH"; const module = { exports: {} }; module.exports = 1;',
			0,
		],
		[
			"src/launch.js",
			'const value = "PATH"; function helper(exports) { exports.other = 1; } helper(1, 2);',
			0,
		],
		[
			"src/launch.js",
			'const value = "PATH"; let local = 0; local = 1; other.defineProperty(1, 2); const exports = {}; Object.defineProperty(exports, "other", { value: 1 });',
			0,
		],
	])("retains findings in a CommonJS export file: %s (%s)", async (fileName, source, count) => {
		writeFile(fileName, source.replaceAll("PATH", posixHome("home", "zed", "x")));
		expect(await hardcodedPathDiagnostics(["typescript", "javascript"], [])).toHaveLength(count);
	});

	it("does not grant allowances to syntactically broken source", async () => {
		writeFile("src/launch.ts", `const value = "${posixHome("home", "zed", "x")}"; function (`);
		expect(await hardcodedPathDiagnostics(["typescript"], [])).toHaveLength(1);
	});

	it("covers multiline literal spans without hiding a following call", async () => {
		const fixture = posixHome("home", "zed", "x");
		writeFile("src/launch.ts", `const value = \`\n${fixture}\n\`;\nconsume("${fixture}");`);
		expect(await hardcodedPathDiagnostics(["typescript"], [])).toEqual([
			expect.objectContaining({ line: 4, column: 10 }),
		]);
	});

	it.each([
		["example doe", 0],
		["zed doe", 1],
	] as const)("records the existing whitespace username boundary for %s", async (name, count) => {
		writeFile("src/launch.ts", `consume("${posixHome("home", name, "x")}");`);
		expect(await hardcodedPathDiagnostics(["typescript"], [])).toHaveLength(count);
	});

	it("keeps the explicit scan file selection", async () => {
		const fixture = posixHome("home", "zed", "x");
		writeFile("src/selected.ts", `consume("${fixture}");`);
		writeFile("src/other.ts", `consume("${fixture}");`);
		const context = buildContext(["typescript"]);
		context.files = [path.join(temporaryDirectory, "src/selected.ts")];
		expect(await detectHardcodedUserPaths(context)).toEqual([
			expect.objectContaining({ filePath: "src/selected.ts" }),
		]);
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

	it.each([
		["const-and-inline", (_pairCount: number) => []],
		[
			"local-exports-assignments",
			(pairCount: number) => [
				"const exports: Record<string, number> = {};",
				...Array.from({ length: pairCount }, (_, index) => `exports.item${index} = ${index};`),
			],
		],
		[
			"local-module-exports-assignments",
			(pairCount: number) => [
				"const module: { exports: Record<string, number> } = { exports: {} };",
				...Array.from(
					{ length: pairCount },
					(_, index) => `module.exports.item${index} = ${index};`,
				),
			],
		],
		[
			"local-exports-object-assign-calls",
			(pairCount: number) => [
				"const exports: Record<string, number> = {};",
				...Array.from(
					{ length: pairCount },
					(_, index) => `Object.assign(exports, { item${index}: ${index} });`,
				),
			],
		],
		[
			"shadowed-object-assign-calls",
			(pairCount: number) => [
				"const Object = { assign: (..._args: unknown[]) => undefined };",
				...Array.from(
					{ length: pairCount },
					(_, index) => `Object.assign(exports, { item${index}: ${index} });`,
				),
			],
		],
	] as const)(
		"checks allowed const spans linearly across the detector as const and inline counts quadruple (%s)",
		async (_label, buildExtraLines) => {
			const measureDetectorWork = async (
				pairCount: number,
			): Promise<{ spanReads: number; symbolTableOperations: number }> => {
				const fixture = posixHome("home", "zed", "project");
				const constLines = Array.from(
					{ length: pairCount },
					(_, index) => `const path${index} = "${fixture}/${index}";`,
				);
				const extraLines = buildExtraLines(pairCount);
				const inlineLines = Array.from(
					{ length: pairCount },
					(_, index) => `consume("${fixture}/${index}");`,
				);
				writeFile("src/launch.ts", [...constLines, ...extraLines, ...inlineLines].join("\n"));

				let spanReads = 0;
				let symbolTableOperations = 0;
				const actualCollect = homePathConstSpans.collectAllowedHomePathConstSpans;
				const originalMapForEach = Map.prototype.forEach;
				const originalMapGet = Map.prototype.get;
				const spy = vi
					.spyOn(homePathConstSpans, "collectAllowedHomePathConstSpans")
					.mockImplementation((filePath, content) => {
						Map.prototype.forEach = function (callback, thisArg) {
							return originalMapForEach.call(this, function (value, key, map) {
								symbolTableOperations++;
								return callback.call(thisArg, value, key, map);
							});
						};
						Map.prototype.get = function (key) {
							symbolTableOperations++;
							return originalMapGet.call(this, key);
						};
						try {
							return actualCollect(filePath, content).map(({ start, end }) => ({
								get start() {
									spanReads++;
									return start;
								},
								get end() {
									spanReads++;
									return end;
								},
							}));
						} finally {
							Map.prototype.forEach = originalMapForEach;
							Map.prototype.get = originalMapGet;
						}
					});
				try {
					const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);
					expect(diagnostics).toHaveLength(pairCount);
				} finally {
					spy.mockRestore();
				}
				return { spanReads, symbolTableOperations };
			};

			const small = await measureDetectorWork(1_000);
			const large = await measureDetectorWork(4_000);

			expect(small.spanReads).toBeLessThanOrEqual(4_000);
			expect(large.spanReads / small.spanReads).toBeLessThan(6);
			expect(small.symbolTableOperations).toBeLessThanOrEqual(30_000);
			expect(large.symbolTableOperations / small.symbolTableOperations).toBeLessThan(6);
		},
	);
});
