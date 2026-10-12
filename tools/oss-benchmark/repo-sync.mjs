import fs from "node:fs";
import path from "node:path";
import { containedPath, validateRepo } from "./containment.mjs";
import { ensureDir, info, REPOS_DIR, repoKey } from "./fs-utils.mjs";
import { runCommand } from "./run-command.mjs";

export const repoDirectoryFor = (language, owner, name) => {
	const repo = validateRepo({ language, owner, name });
	return containedPath(REPOS_DIR, language, repoKey(repo));
};

const git = (arguments_) =>
	runCommand(
		"git",
		[
			"-c",
			"credential.helper=",
			"-c",
			`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
			"-c",
			"core.fsmonitor=false",
			"-c",
			"init.templateDir=",
			"-c",
			"protocol.allow=never",
			"-c",
			"protocol.https.allow=always",
			...arguments_,
		],
		{
			env: {
				PATH: process.env.PATH,
				SYSTEMROOT: process.env.SYSTEMROOT,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
			},
		},
	);

const cloneRepo = async (repo, repoDirectory) => {
	const result = await git([
		"clone",
		"--depth",
		"1",
		"--single-branch",
		"--",
		repo.cloneUrl,
		repoDirectory,
	]);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || "git clone failed");
	}
	return repoDirectory;
};

const checkoutRevision = async (repo, repoDirectory) => {
	const fetched = await git([
		"-C",
		repoDirectory,
		"fetch",
		"--depth",
		"1",
		"origin",
		repo.revision,
	]);
	const checkedOut =
		fetched.code === 0 && (await git(["-C", repoDirectory, "checkout", "--detach", repo.revision]));
	if (!checkedOut || checkedOut.code !== 0) {
		throw new Error(`could not check out pinned revision ${repo.revision}`);
	}
	return repoDirectory;
};

export const syncRepo = async (repo) => {
	const validated = validateRepo(repo);
	const prefix = repoDirectoryFor(validated.language, validated.owner, validated.name);
	ensureDir(path.dirname(prefix));
	// Never update or delete a pre-existing checkout or trust its local Git configuration.
	const allocation = fs.mkdtempSync(`${prefix}-`);
	const repoDirectory = containedPath(REPOS_DIR, path.relative(REPOS_DIR, allocation), "checkout");
	info(`Cloning ${validated.owner}/${validated.name}`);
	await cloneRepo(validated, repoDirectory);
	return validated.revision ? checkoutRevision(validated, repoDirectory) : repoDirectory;
};

export const repoHeadSha = async (repoDirectory) => {
	const result = await git(["-C", repoDirectory, "rev-parse", "HEAD"]);
	if (result.code !== 0) return null;
	return result.stdout.trim() || null;
};
