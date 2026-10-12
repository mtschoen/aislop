import fs from "node:fs";
import path from "node:path";
import { assertNoSymlinks } from "./containment.mjs";
import { PACKAGE_ROOT } from "./fs-utils.mjs";
import { runCommand } from "./run-command.mjs";

// The worker sees only public system runtimes, trusted scanner assets, and one read-only clone.
export const sandboxArguments = (repoDirectory) => {
	if (process.platform !== "linux")
		throw new Error(
			"OSS benchmark scans require Linux and bubblewrap; no unsandboxed fallback is available.",
		);
	assertNoSymlinks(repoDirectory);
	const arguments_ = [
		"--unshare-all",
		"--unshare-user",
		"--disable-userns",
		"--assert-userns-disabled",
		"--cap-drop",
		"ALL",
		"--new-session",
		"--die-with-parent",
		"--clearenv",
	];
	for (const directory of ["/usr", "/lib", "/lib64", "/bin", "/sbin"]) {
		if (fs.existsSync(directory)) arguments_.push("--ro-bind", directory, directory);
	}
	arguments_.push(
		"--dir",
		"/scanner",
		"--ro-bind",
		fs.realpathSync(process.execPath),
		"/scanner/node",
	);
	for (const asset of [
		"dist",
		"package.json",
		"node_modules",
		"tools/bin",
		"tools/analyzers",
		"tools/jb",
		"tools/grammars",
	]) {
		const source = path.join(PACKAGE_ROOT, asset);
		if (!fs.existsSync(source)) {
			if (["dist", "package.json", "node_modules"].includes(asset))
				throw new Error(`Build/install the scanner before benchmarking: missing ${asset}`);
			continue;
		}
		assertNoSymlinks(source);
		arguments_.push("--ro-bind", source, `/scanner/${asset}`);
	}
	arguments_.push(
		"--ro-bind",
		fs.realpathSync(repoDirectory),
		"/repo",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--size",
		"536870912",
		"--tmpfs",
		"/tmp",
		"--dir",
		"/tmp/home",
		"--dir",
		"/tmp/bin",
		"--symlink",
		"/scanner/node",
		"/tmp/bin/node",
	);
	const environment = {
		HOME: "/tmp/home",
		TMPDIR: "/tmp",
		XDG_CACHE_HOME: "/tmp/home/.cache",
		PATH: "/tmp/bin:/usr/bin:/bin",
		AISLOP_NO_TELEMETRY: "1",
		AISLOP_NO_HISTORY: "1",
		AISLOP_NO_UPDATE_NOTIFIER: "1",
		DO_NOT_TRACK: "1",
		CI: "1",
		NO_COLOR: "1",
	};
	for (const [key, value] of Object.entries(environment)) arguments_.push("--setenv", key, value);
	return [...arguments_, "--chdir", "/repo", "--"];
};

export const runIsolatedScan = (repoDirectory) =>
	runCommand(
		"bwrap",
		[
			...sandboxArguments(repoDirectory),
			"/scanner/node",
			"/scanner/dist/cli.js",
			"scan",
			"/repo",
			"--json",
		],
		{ env: { PATH: process.env.PATH }, timeout: 300_000, maximumOutputBytes: 64 * 1024 * 1024 },
	);

export const checkSandbox = async () => {
	const result = await runCommand(
		"bwrap",
		[...sandboxArguments(path.join(PACKAGE_ROOT, "dist")), "/scanner/node", "--version"],
		{
			env: { PATH: process.env.PATH },
			timeout: 30_000,
		},
	);
	if (result.code !== 0)
		throw new Error(`Cannot start isolated benchmark worker: ${result.stderr.trim()}`);
};
