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
): EngineContext => ({
	rootDirectory: temporaryDirectory,
	languages,
	frameworks: [],
	installedTools: {},
	config: {
		quality: { maxFunctionLoc: 80, maxFileLoc: 400, maxNesting: 5, maxParams: 6 },
		security: { audit: false, auditTimeout: 0 },
		lint: { typecheck: false },
		aiSlop: { hardcodedUserPath: { bannedRoots } },
	},
});

// A placeholder seed home. `os.homedir()` is mocked to this by default so
// tests exercise the configured `bannedRoots` in isolation; individual tests
// override the mock to exercise the seed itself.
const PLACEHOLDER_SEED_HOME = "/home/runner";

const hardcodedPathDiagnostics = async (
	languages: EngineContext["languages"],
	bannedRoots: string[],
	seedHomeDirectory: string = PLACEHOLDER_SEED_HOME,
): Promise<Awaited<ReturnType<typeof detectHardcodedUserPaths>>> => {
	vi.spyOn(os, "homedir").mockReturnValue(seedHomeDirectory);
	return detectHardcodedUserPaths(buildContext(languages, bannedRoots));
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
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("hardcoded user paths", () => {
	it("uses the runtime home directory through the AI slop engine", async () => {
		const homeDirectory = "/home/aislop-engine-seed";
		vi.spyOn(os, "homedir").mockReturnValue(homeDirectory);
		writeFile("src/launch.ts", `const tool = "${homeDirectory}/project";`);

		const diagnostics = await enginePathDiagnostics(["typescript"]);

		expect(diagnostics).toEqual([
			expect.objectContaining({ filePath: "src/launch.ts", line: 1, column: 15 }),
		]);
	});

	describe("banned root resolution", () => {
		it("[A] flags a path under a configured root even though the runtime seed differs", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/schoen/x";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				["/home/schoen"],
				"/home/runner",
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[B] flags a path under a configured root even though the runtime seed is a different OS style", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/schoen/x";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				["/home/schoen"],
				String.raw`C:\Users\jordan-w`,
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[C] does not flag a home path that is neither configured nor the runtime seed", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/schoen/x";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], "/home/alice");

			expect(diagnostics).toEqual([]);
		});

		it("[D] skips seeding from a placeholder runtime home", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/runner/work/repo";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], "/home/runner");

			expect(diagnostics).toEqual([]);
		});

		it.each([
			"runneradmin",
			"root",
			"user",
			"username",
			"default",
			"defaultuser",
			"example",
			"public",
			"shared",
			"someone",
			"me",
			"your-name",
			"yourname",
			"runner~1",
		])("skips seeding from the placeholder home segment %s", async (segment) => {
			writeFile("src/launch.ts", `const tool = "/home/${segment}/work/repo";`);

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				[],
				`/home/${segment}`,
			);

			expect(diagnostics).toEqual([]);
		});

		it("[E] collapses overlapping configured roots to one diagnostic", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/alice/project/tool";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [
				"/home/alice",
				"/home/alice/project",
			]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[F] flags a Windows file URL form matching a configured root once", async () => {
			writeFile("src/launch.ts", 'const tool = "file:///C:/Users/alice/x";');

			const diagnostics = await hardcodedPathDiagnostics(
				["typescript"],
				[String.raw`C:\Users\alice`],
			);

			expect(diagnostics).toHaveLength(1);
		});

		it("[G] flags a bare configured root with no descendant", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/alice";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[H] does not flag a configured root appearing inside a web URL", async () => {
			writeFile("src/launch.ts", 'const u = "https://example.com/home/alice/profile";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

			expect(diagnostics).toEqual([]);
		});

		it("[I] flags the motivating ExecStart case for the source issue", async () => {
			writeFile(
				"src/service.ts",
				'const unitFile = "ExecStart=/home/schoen/schoen-lab/.venv/bin/pr-crew";',
			);

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/schoen"]);

			expect(diagnostics).toHaveLength(1);
		});

		it("[J] does not flag an unrelated route that merely shares the '/home' prefix", async () => {
			writeFile("src/routes.ts", 'router.get("/home/customer/orders", handler);');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

			expect(diagnostics).toEqual([]);
		});

		it("[K] does not seed a banned root from the container root user's home", async () => {
			// CI jobs commonly run inside a Docker container as the root user, so
			// os.homedir() returns "/root". That is a superuser home, never a real
			// developer's home, so it must not be seeded as a banned root: doing
			// so would flag every legitimate reference to /root (systemd unit
			// paths, container mount targets, deploy key paths) as if it were a
			// hardcoded personal path.
			writeFile("src/service.ts", 'const sshConfig = "/root/.ssh/config";');

			const diagnostics = await hardcodedPathDiagnostics(["typescript"], [], "/root");

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

		// Regression: `const name = "alice";` must stay clean when a config typo
		// hands the detector `bannedRoots: ["alice"]` - a bare word with no
		// leading separator would otherwise build a matcher with no
		// path-boundary requirement and flag the plain identifier.
		it.each([
			["alice", "bare word"],
			["home/alice", "relative path"],
			["", "empty string"],
			["./relative", "dot-relative path"],
		])("drops a non-absolute banned root (%s: %s) with a visible warning", async (root) => {
			writeFile("src/launch.ts", 'const name = "alice";');
			let diagnostics: Awaited<ReturnType<typeof detectHardcodedUserPaths>> = [];
			const stderr = await withStderr(async () => {
				diagnostics = await hardcodedPathDiagnostics(["typescript"], [root]);
			});

			expect(diagnostics).toEqual([]);
			expect(stderr).toContain("bannedRoots");
			expect(stderr).toContain(JSON.stringify(root));
		});

		it("still flags a valid root alongside a rejected one in the same list", async () => {
			writeFile("src/launch.ts", 'const tool = "/home/alice/project/tool";');
			let diagnostics: Awaited<ReturnType<typeof detectHardcodedUserPaths>> = [];

			const stderr = await withStderr(async () => {
				diagnostics = await hardcodedPathDiagnostics(["typescript"], ["alice", "/home/alice"]);
			});

			expect(diagnostics).toHaveLength(1);
			expect(stderr).toContain("bannedRoots");
		});
	});

	it.each([
		["Linux", "/home/admin", "/home/admin/project/tool"],
		["macOS", "/Users/admin", "/Users/admin/project/tool"],
		["Windows", String.raw`C:\Users\admin`, String.raw`C:\Users\admin\project\tool`],
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
		const homeDirectory = String.raw`C:\Users\Jane Doe`;
		const variants = [
			String.raw`C:\Users\Jane Doe\project\tool.exe`,
			String.raw`C:\\Users\\Jane Doe\\project\\tool.exe`,
			String.raw`C:\Users/Jane Doe\project/tool.exe`,
			"C:/Users/Jane Doe/project/tool.exe",
			String.raw`c:\users\jane doe\project\tool.exe`,
		];
		writeFile("src/launch.ts", variants.map((value) => `const tool = "${value}";`).join("\n"));

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(variants.length);
	});

	it("matches local POSIX file URLs without treating an arbitrary authority as local", async () => {
		const homeDirectory = "/home/alice";
		writeFile(
			"src/launch.ts",
			[
				'const compact = "file:/home/alice/project";',
				'const standard = "file:///home/alice/project";',
				'const localhost = "file://localhost/home/alice/project";',
				'const authority = "file://home/alice/project";',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(3);
	});

	it("matches the localhost authority case-insensitively", async () => {
		writeFile("src/launch.ts", 'const tool = "file://LOCALHOST/home/alice/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("does not treat a non-localhost, non-empty authority as local for a POSIX root", async () => {
		writeFile("src/launch.ts", 'const tool = "file://remotehost/home/alice/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("does not treat a non-localhost, non-empty authority as local for a Windows drive root", async () => {
		writeFile("src/launch.ts", 'const tool = "file://remotehost/C:/Users/alice/project";');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\alice`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("does not double-report a single file://localhost URL", async () => {
		writeFile("src/launch.ts", 'const tool = "file://localhost/home/alice/project";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("reports equivalent Windows file URL spellings once each, including localhost", async () => {
		const variants = [
			"file:/C:/Users/alice/project/tool",
			"file://C:/Users/alice/project/tool",
			"file:///C:/Users/alice/project/tool",
			"file://localhost/C:/Users/alice/project/tool",
		];
		writeFile("src/launch.ts", variants.map((value) => `const tool = "${value}";`).join("\n"));

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\alice`],
		);

		expect(diagnostics).toHaveLength(variants.length);
	});

	it("does not double-report a single file://localhost URL for a Windows drive root", async () => {
		writeFile("src/launch.ts", 'const tool = "file://localhost/C:/Users/alice/project";');

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`C:\Users\alice`],
		);

		expect(diagnostics).toHaveLength(1);
	});

	it("ignores a POSIX home embedded in a Windows file URL", async () => {
		writeFile("src/launch.ts", 'const tool = "file:///C:/home/alice/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("accepts UNC root, descendant, escaped, forward-slash, and file URL spellings", async () => {
		const homeDirectory = String.raw`\\server\profiles\alice`;
		const variants = [
			homeDirectory,
			String.raw`\\server\profiles\alice\project\tool.exe`,
			String.raw`\\\\server\\profiles\\alice\\project\\tool.exe`,
			"//server/profiles/alice/project/tool.exe",
			"file://server/profiles/alice/project/tool.exe",
			String.raw`\\SERVER\PROFILES\ALICE\project\tool.exe`,
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
			'const tool = "file://localhost/server/profiles/alice/project/tool.exe";',
		);

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`\\server\profiles\alice`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("ignores a UNC home nested under another file URL authority", async () => {
		writeFile(
			"src/launch.ts",
			'const tool = "file://other/server/profiles/alice/project/tool.exe";',
		);

		const diagnostics = await hardcodedPathDiagnostics(
			["typescript"],
			[String.raw`\\server\profiles\alice`],
		);

		expect(diagnostics).toEqual([]);
	});

	it("scans production, test, comment, Java, and Python source", async () => {
		const homeDirectory = "/home/operator";
		writeFile("src/launch.ts", 'const tool = "/home/operator/project/tool";');
		writeFile("tests/service.test.ts", "// installed at /home/operator/project/tool\n");
		writeFile("src/path-resolver.java", 'var path = Paths.get("/home/operator/project");\n');
		writeFile("src/cache.py", 'tool = cache.get("/home/operator/project/tool")\n');

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
		const homeDirectory = "/home/alice";
		writeFile(
			"src/paths.ts",
			[
				"/home/alice/project",
				"// installed at /home/alice/project",
				"ExecStart=/home/alice/project/tool",
				"PATH=/usr/bin:/home/alice/bin",
				"PATH=/home/alice:/usr/bin",
				'const nested = "/srv/site/home/alice/project";',
				'const driveNested = "C:/home/alice/project";',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toEqual([
			expect.objectContaining({ line: 1, column: 1 }),
			expect.objectContaining({ line: 2 }),
			expect.objectContaining({ line: 3 }),
			expect.objectContaining({ line: 4 }),
			expect.objectContaining({ line: 5 }),
		]);
	});

	it("ignores web URLs while finding a later local path on the same large line", async () => {
		const homeDirectory = "/home/alice";
		const urls = Array.from(
			{ length: 8_000 },
			(_, index) => `https://example.test/${index}/home/alice/project`,
		);
		writeFile(
			"src/urls.ts",
			`${urls.map((value) => `"${value}"`).join(",")},"/home/alice/project"`,
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], [homeDirectory]);

		expect(diagnostics).toHaveLength(1);
	});

	it("ignores a conventional home path for a different user", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/unrelated/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/current-user"]);

		expect(diagnostics).toEqual([]);
	});

	it("ignores arbitrary and templated web routes that do not share a configured root", async () => {
		writeFile(
			"src/routes.ts",
			[
				'router.get("/home/customers/detail", handler);',
				'router.get("/api/{tenant}/home/alice/summary", handler);',
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("flags the configured home path regardless of receiver name", async () => {
		writeFile("src/cache.ts", 'cache.get("/home/alice/project/tool")');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("flags a file URL even when it is passed to a route-like receiver", async () => {
		writeFile("src/routes.ts", 'router.get("file:///home/alice/project/tool", handler);');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toHaveLength(1);
	});

	it("does not match a longer username that starts with the configured home root", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/alice-other/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("uses case-sensitive matching for POSIX home directories", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/Alice/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("ignores portable absolute paths outside the configured home directory", async () => {
		writeFile(
			"src/system.ts",
			[
				'const configuration = "/etc/service/config.yml";',
				'const executable = "/usr/local/bin/service";',
				String.raw`const program = "C:\\Program Files\\Service\\service.exe";`,
			].join("\n"),
		);

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("returns no diagnostics when the only configured root normalizes to empty", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/alice/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/"]);

		expect(diagnostics).toEqual([]);
	});

	it("returns no diagnostics when no roots are configured and the seed is a placeholder", async () => {
		writeFile("src/launch.ts", 'const tool = "/home/alice/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], []);

		expect(diagnostics).toEqual([]);
	});

	it("skips auto-generated source files", async () => {
		writeFile("src/client.ts", '// auto-generated\nconst tool = "/home/alice/project/tool";');

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

		expect(diagnostics).toEqual([]);
	});

	it("skips a source file that cannot be read", async () => {
		writeFile("src/unreadable.ts", 'const tool = "/home/alice/project/tool";');
		vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
			throw new Error("simulated read failure");
		});

		const diagnostics = await hardcodedPathDiagnostics(["typescript"], ["/home/alice"]);

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
