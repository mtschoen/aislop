import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { fixDotnetFormat, runDotnetFormat } from "../src/engines/format/dotnet-format.js";
import { runDotnetLint } from "../src/engines/lint/dotnet.js";
import { runJbLint } from "../src/engines/lint/jb.js";
import { runSerializedMsbuildPass } from "../src/engines/msbuild-serial.js";
import type { EngineContext } from "../src/engines/types.js";
import {
	hasProcessExited,
	SUBPROCESS_SHUTDOWN_GRACE_MS,
	SubprocessTimeoutError,
} from "../src/utils/subprocess.js";

const { subprocess, realSubprocessRef } = vi.hoisted(() => ({
	subprocess: vi.fn(),
	realSubprocessRef: {
		current: undefined as undefined | typeof import("../src/utils/subprocess.js").runSubprocess,
	},
}));
vi.mock("../src/utils/subprocess.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/subprocess.js")>();
	realSubprocessRef.current = actual.runSubprocess;
	return {
		...actual,
		runSubprocess: subprocess,
	};
});
vi.mock("../src/utils/tooling.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/tooling.js")>()),
	resolveToolBinary: (name: string) => name,
	resolveBundledAnalyzerAssemblies: () => [],
	resolveBundledJbSettings: () => null,
}));

// Lets every already-queued promise continuation run; ordering, not elapsed time.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("runSerializedMsbuildPass", () => {
	it("runs passes for one root strictly one after another", async () => {
		const log: string[] = [];
		const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const pass = (name: string, gate: PromiseWithResolvers<void>) =>
			runSerializedMsbuildPass("scan-root", async () => {
				log.push(`start ${name}`);
				await gate.promise;
				log.push(`end ${name}`);
			});
		const first = pass("a", gates[0]);
		const second = pass("b", gates[1]);
		await flush();
		expect(log).toEqual(["start a"]);
		gates[0].resolve();
		await first;
		await flush();
		expect(log).toEqual(["start a", "end a", "start b"]);
		gates[1].resolve();
		await second;
		expect(log).toEqual(["start a", "end a", "start b", "end b"]);
	});

	it("releases the lock when a pass rejects or throws", async () => {
		const termination = Promise.withResolvers<void>();
		const prebuiltTimeout = new SubprocessTimeoutError(
			"timed out",
			"",
			"",
			termination.promise,
		);
		const failing = runSerializedMsbuildPass("scan-root", async () => {
			throw new Error("boom");
		});
		const synchronousThrow = runSerializedMsbuildPass("scan-root", () => {
			throw new Error("sync boom");
		});
		const timedOut = runSerializedMsbuildPass("scan-root", async () => {
			throw prebuiltTimeout;
		});
		let timedOutSettled = false;
		void timedOut.catch(() => {
			timedOutSettled = true;
		});
		let followingStarted = false;
		const following = runSerializedMsbuildPass("scan-root", async () => {
			followingStarted = true;
			return "ran";
		});
		await expect(failing).rejects.toThrow("boom");
		await expect(synchronousThrow).rejects.toThrow("sync boom");
		await flush();
		expect(timedOutSettled).toBe(false);
		expect(followingStarted).toBe(false);
		termination.resolve();
		await expect(timedOut).rejects.toThrow("timed out");
		await expect(following).resolves.toBe("ran");

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const neverTerminatingTimeout = new SubprocessTimeoutError(
				"unbounded timeout",
				"",
				"",
				new Promise<void>(() => {}),
			);
			const hung = runSerializedMsbuildPass("scan-root", async () => {
				throw neverTerminatingTimeout;
			});
			hung.catch(() => {});
			let afterHungStarted = false;
			const afterHung = runSerializedMsbuildPass("scan-root", async () => {
				afterHungStarted = true;
				return "recovered";
			});
			await flush();
			expect(afterHungStarted).toBe(false);
			vi.advanceTimersByTime(SUBPROCESS_SHUTDOWN_GRACE_MS - 1);
			await flush();
			expect(afterHungStarted).toBe(false);
			vi.advanceTimersByTime(1);
			await expect(hung).rejects.toThrow("unbounded timeout");
			await expect(afterHung).resolves.toBe("recovered");
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not block passes for different roots", async () => {
		const gate = Promise.withResolvers<void>();
		const started: string[] = [];
		const blocked = runSerializedMsbuildPass("root-one", async () => {
			started.push("one");
			await gate.promise;
		});
		const independent = runSerializedMsbuildPass("root-two", async () => {
			started.push("two");
		});
		await independent;
		expect(started).toEqual(["one", "two"]);
		gate.resolve();
		await blocked;
	});

	it("treats equivalent spellings of one root as the same lock", async () => {
		const gate = Promise.withResolvers<void>();
		const started: string[] = [];
		const first = runSerializedMsbuildPass(path.join("a", "b"), async () => {
			started.push("first");
			await gate.promise;
		});
		const second = runSerializedMsbuildPass(["a", "x", "..", "b"].join(path.sep), async () => {
			started.push("second");
		});
		await flush();
		expect(started).toEqual(["first"]);
		gate.resolve();
		await Promise.all([first, second]);
		expect(started).toEqual(["first", "second"]);
	});
});

interface InFlightTool {
	label: string;
	settle: PromiseWithResolvers<void>;
	terminate: PromiseWithResolvers<void>;
	timedOut: boolean;
}

describe("MSBuild-loading C# passes of one scan", () => {
	let root: string;
	let context: EngineContext;
	let inFlight: InFlightTool[];
	let activeTools: number;
	let maximumConcurrent: number;
	let toolsStarted: string[];
	let timedOutTools: Set<string>;

	beforeEach(() => {
		subprocess.mockReset();
		inFlight = [];
		activeTools = 0;
		maximumConcurrent = 0;
		toolsStarted = [];
		timedOutTools = new Set();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-msbuild-serial-"));
		fs.mkdirSync(path.join(root, "App", "obj"), { recursive: true });
		fs.writeFileSync(path.join(root, "App", "App.csproj"), "<Project />");
		fs.writeFileSync(path.join(root, "App", "obj", "project.assets.json"), "{}");
		fs.writeFileSync(
			path.join(root, "App.sln"),
			'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "App\\App.csproj", "{00000000-1111-1111-1111-111111111111}"\nEndProject\n',
		);
		const configuration = structuredClone(DEFAULT_CONFIG);
		configuration.lint.csharp = {
			projectEvaluation: true,
			jb: true,
			roslynator: true,
			jbSeverityFloor: "WARNING",
			jbExcludeTypes: [],
		};
		context = {
			rootDirectory: root,
			languages: ["csharp"],
			frameworks: [],
			installedTools: { jb: true, roslynator: true, dotnet: true },
			config: {
				quality: configuration.quality,
				security: configuration.security,
				lint: configuration.lint,
			},
		};
		subprocess.mockImplementation(async (command: string, arguments_: string[]) => {
			// `dotnet sln list` style project listing is not an MSBuild-loading pass.
			if (command === "dotnet" && arguments_[0] !== "format") {
				return { stdout: "Project(s)\n----------\nApp/App.csproj\n", stderr: "", exitCode: 0 };
			}
			const isFormatCheck = arguments_.includes("--verify-no-changes");
			const label =
				command === "dotnet" ? (isFormatCheck ? "dotnet format" : "dotnet format fix") : command;
			toolsStarted.push(label);
			const settle = Promise.withResolvers<void>();
			const terminate = Promise.withResolvers<void>();
			const timedOut = timedOutTools.has(label);
			activeTools += 1;
			maximumConcurrent = Math.max(maximumConcurrent, activeTools);
			void terminate.promise.then(() => {
				activeTools -= 1;
			});
			inFlight.push({ label, settle, terminate, timedOut });
			await settle.promise;
			if (timedOut) {
				throw new SubprocessTimeoutError(
					`Command timed out: ${label}`,
					"",
					"",
					terminate.promise,
				);
			}
			terminate.resolve();
			const output =
				arguments_.find((argument) => argument.startsWith("--output="))?.slice(9) ??
				arguments_[arguments_.indexOf("--output") + 1];
			if (command === "jb") fs.writeFileSync(output, "<Report><Issues /></Report>");
			if (command === "roslynator") fs.writeFileSync(output, "<Roslynator />");
			return { stdout: "Analyze 'App' 1/1\nInspecting App.csproj", stderr: "", exitCode: 0 };
		});
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const drain = async (passes: Promise<unknown>, onBeforeTerminate?: (label: string) => void) => {
		let finished = false;
		void passes.then(() => {
			finished = true;
		});
		while (!finished) {
			await flush();
			const next = inFlight.shift();
			if (!next) continue;
			const startedBeforeSettle = toolsStarted.length;
			next.settle.resolve();
			await flush();
			if (next.timedOut) {
				expect(toolsStarted).toHaveLength(startedBeforeSettle);
				expect(activeTools).toBe(1);
				onBeforeTerminate?.(next.label);
				next.terminate.resolve();
			}
		}
	};

	it("never overlaps jb, roslynator and dotnet format on the same root", async () => {
		timedOutTools = new Set(["jb", "roslynator", "dotnet format", "dotnet format fix"]);
		let fixSettled = false;
		const fixPromise = fixDotnetFormat(context).then(
			() => {
				fixSettled = true;
			},
			(error: unknown) => {
				fixSettled = true;
				throw error;
			},
		);
		await drain(
			Promise.allSettled([
				runJbLint(context, { includeCsharp: true, includeCpp: false }),
				runDotnetLint(context),
				runDotnetFormat(context),
				fixPromise,
			]),
			(label) => {
				if (label === "dotnet format fix") {
					expect(fixSettled).toBe(false);
				}
			},
		);

		await expect(fixPromise).rejects.toThrow("Command timed out: dotnet format fix");
		expect([...toolsStarted].sort()).toEqual([
			"dotnet format",
			"dotnet format fix",
			"jb",
			"roslynator",
		]);
		expect(maximumConcurrent).toBe(1);

		toolsStarted = [];
		maximumConcurrent = 0;
		timedOutTools = new Set();
		await drain(
			Promise.allSettled([
				runJbLint(context, { includeCsharp: true, includeCpp: false }),
				runDotnetLint(context),
				runDotnetFormat(context),
				fixDotnetFormat(context),
			]),
		);

		expect([...toolsStarted].sort()).toEqual([
			"dotnet format",
			"dotnet format fix",
			"jb",
			"roslynator",
		]);
		expect(maximumConcurrent).toBe(1);

		// Exercise the Windows taskkill-ENOENT fallback with real parent and
		// worker processes: direct-child exit leaves the worker alive and
		// unconfirmed, so the following same-root pass must stay blocked until
		// the bounded shutdown grace expires.
		const originalPlatform = process.platform;
		const pidsFile = path.join(root, "surviving-worker-pids.json");
		const parentScript = [
			`const worker = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });`,
			`require("node:fs").writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parentPid: process.pid, workerPid: worker.pid }));`,
			"setInterval(() => {}, 1000);",
		].join("\n");
		const realSpawn = childProcess.spawn.bind(childProcess);
		const spawnSpy = vi
			.spyOn(childProcess, "spawn")
			.mockImplementation((command, arguments_, spawnOptions) => {
				if (command === "taskkill") {
					const fakeTaskkill = new EventEmitter() as unknown as ChildProcess;
					setImmediate(() => {
						fakeTaskkill.emit(
							"error",
							Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }),
						);
					});
					return fakeTaskkill;
				}
				return realSpawn(command, arguments_ as string[], spawnOptions ?? {});
			});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		Object.defineProperty(process, "platform", { value: "win32" });
		let workerPid: number | undefined;
		try {
			const firstPass = runSerializedMsbuildPass(root, () => {
				if (!realSubprocessRef.current) throw new Error("missing real runSubprocess");
				return realSubprocessRef.current(process.execPath, ["-e", parentScript], { timeout: 1000 });
			});
			firstPass.catch(() => {});
			let followingStarted = false;
			const followingPass = runSerializedMsbuildPass(root, async () => {
				followingStarted = true;
			});

			let parentPid: number | undefined;
			await flush();
			const spawnDeadline = Date.now() + 20000;
			while ((parentPid === undefined || workerPid === undefined) && Date.now() < spawnDeadline) {
				if (fs.existsSync(pidsFile)) {
					try {
						const parsed = JSON.parse(fs.readFileSync(pidsFile, "utf-8")) as {
							parentPid?: number;
							workerPid?: number;
						};
						if (typeof parsed.parentPid === "number" && typeof parsed.workerPid === "number") {
							parentPid = parsed.parentPid;
							workerPid = parsed.workerPid;
						}
					} catch {}
				}
			}
			expect(parentPid).toBeDefined();
			expect(workerPid).toBeDefined();

			vi.advanceTimersByTime(1000);
			const parentExitDeadline = Date.now() + 20000;
			while (
				parentPid !== undefined &&
				!hasProcessExited(parentPid) &&
				Date.now() < parentExitDeadline
			) {
				await flush();
			}
			await flush();
			expect(parentPid !== undefined && hasProcessExited(parentPid)).toBe(true);
			expect(workerPid !== undefined && !hasProcessExited(workerPid)).toBe(true);
			expect(followingStarted).toBe(false);

			vi.advanceTimersByTime(SUBPROCESS_SHUTDOWN_GRACE_MS - 1);
			await flush();
			expect(followingStarted).toBe(false);

			vi.advanceTimersByTime(1);
			await expect(firstPass).rejects.toThrow(/timed out/);
			await followingPass;
			expect(followingStarted).toBe(true);
		} finally {
			Object.defineProperty(process, "platform", { value: originalPlatform });
			spawnSpy.mockRestore();
			if (workerPid !== undefined) {
				try {
					if (!hasProcessExited(workerPid)) {
						process.kill(workerPid, "SIGKILL");
					}
				} catch {}
			}
			vi.useRealTimers();
		}
	});
});
