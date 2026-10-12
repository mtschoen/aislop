import { spawn } from "node:child_process";
import { PACKAGE_ROOT } from "./fs-utils.mjs";

export const runCommand = (command, args, options = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd ?? PACKAGE_ROOT,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let failure = null;
		let bytes = 0;
		const fail = (message) => {
			failure = new Error(message);
			child.kill("SIGKILL");
		};
		const timer = options.timeout
			? setTimeout(() => fail("Benchmark worker timed out"), options.timeout)
			: null;
		const withinLimit = (chunk) => {
			bytes += chunk.length;
			if (options.maximumOutputBytes && bytes > options.maximumOutputBytes) {
				if (!failure) fail("Benchmark worker exceeded its output limit");
				return false;
			}
			return true;
		};

		child.stdout.on("data", (chunk) => {
			if (withinLimit(chunk)) stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			if (withinLimit(chunk)) stderr += chunk.toString();
		});

		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (timer) clearTimeout(timer);
			if (failure) {
				reject(failure);
				return;
			}
			resolve({
				command,
				args,
				code: code ?? 1,
				signal,
				stdout,
				stderr,
			});
		});
	});
