import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/sync_consumers.sh");
const OLD_PIN = "a".repeat(40);
const NEW_PIN = "b".repeat(40);
const BRANCH = "chore/aislop-pin-bump";
const HAND_EDITED_TITLE = "fix: hand-edited title";

const FAKE_CURL = String.raw`#!/usr/bin/env bash
# Minimal stand-in for the Gitea REST API used by sync_consumers.sh.
method=GET; out=""; write_format=""; url=""
while [ $# -gt 0 ]; do
	case "$1" in
	-X) method="$2"; shift 2 ;;
	-o) out="$2"; shift 2 ;;
	-w) write_format="$2"; shift 2 ;;
	-H | --data-binary) shift 2 ;;
	-*) shift ;;
	*) url="$1"; shift ;;
	esac
done
echo "$method $url" >>"$FAKE_REQUEST_LOG"
status=200
case "$method $url" in
"GET "*/users/*) body='{"id":1}' ;;
"GET "*/repos/search*) body='{"data":[{"name":"consumer","default_branch":"main","clone_url":"http://gitea.test/schoen/consumer.git"}]}' ;;
"GET "*/contents/.aislop/fork-commit*) body="{\"content\":\"$(printf '%s\n' "$FAKE_OLD_PIN" | base64 | tr -d '\n')\"}" ;;
"GET "*/pulls?state=open*) body="[{\"number\":7,\"title\":\"$FAKE_PR_TITLE\",\"head\":{\"ref\":\"chore/aislop-pin-bump\"},\"base\":{\"ref\":\"main\"}}]" ;;
"POST "*/pulls) status="$FAKE_PR_CREATE_STATUS"; body='{"html_url":"http://gitea.test/schoen/consumer/pulls/7"}' ;;
"PATCH "*/pulls/7) body='{"html_url":"http://gitea.test/schoen/consumer/pulls/7"}' ;;
*) status=404; body='{}' ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
if [ -n "$write_format" ]; then printf '%s' "$status"; fi
`;

let root: string;
let bareDir: string;
let workDir: string;
let requestLog: string;

const git = (cwd: string, ...args: string[]): string => {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
};

const commitFile = (relativePath: string, content: string, message: string): void => {
	const target = path.join(workDir, relativePath);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
	git(workDir, "add", "-A");
	git(workDir, "commit", "-q", "-m", message);
};

const bareGit = (...args: string[]): string => git(bareDir, ...args);

const isAncestor = (ancestor: string, descendant: string): boolean =>
	spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: bareDir }).status === 0;

interface SyncResult {
	status: number | null;
	output: string;
	requests: string;
}

// Windows jq translates newlines to CRLF, which the script's numeric tests and
// base64 decode cannot read. Its --binary flag restores LF output; Linux and
// macOS jq need no shim.
const installWindowsJqShim = (binDir: string): void => {
	if (process.platform !== "win32") return;
	const located = (process.env.PATH ?? "")
		.split(path.delimiter)
		.map((directory) => path.join(directory, "jq.exe"))
		.find((candidate) => fs.existsSync(candidate));
	if (!located) return;
	const realJq = located.replaceAll("\\", "/");
	fs.writeFileSync(path.join(binDir, "jq"), `#!/usr/bin/env bash
exec "${realJq}" --binary "$@"
`, { mode: 0o755 });
};

// A bare `bash` on Windows can be the WSL launcher (System32 or WindowsApps), which
// does not honor the Windows PATH or POSIX tool lookups. Use the bash that ships
// beside git (Git\cmd\git.exe -> Git\bin\bash.exe) when it exists.
const resolveBash = (): string => {
	if (process.platform !== "win32") return "bash";
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!fs.existsSync(path.join(directory, "git.exe"))) continue;
		const candidate = path.resolve(directory, "..", "bin", "bash.exe");
		if (fs.existsSync(candidate)) return candidate;
	}
	return "bash";
};

interface ConcurrentRefUpdate {
	ref: string;
	sha: string;
}

interface RunSyncOptions {
	prCreateStatus?: number;
	beforeUnshallow?: ConcurrentRefUpdate;
	beforePush?: ConcurrentRefUpdate;
}

const FAKE_GIT = [
	"#!/usr/bin/env bash",
	'while [ "${PATH#"$FAKE_BIN_DIR":}" != "$PATH" ]; do PATH="${PATH#"$FAKE_BIN_DIR":}"; done',
	"export PATH",
	'case " $* " in',
	'*" fetch --quiet --unshallow "*)',
	'\tif [ -n "$FAKE_BEFORE_UNSHALLOW_REF" ] && [ -f "$FAKE_HOOK_ONCE" ]; then',
	'\t\trm -f "$FAKE_HOOK_ONCE"',
	'\t\tgit -C "$FAKE_BARE_DIR" update-ref "$FAKE_BEFORE_UNSHALLOW_REF" "$FAKE_BEFORE_UNSHALLOW_SHA"',
	"\tfi",
	"\t;;",
	'*" push "*)',
	'\tif [ -n "$FAKE_BEFORE_PUSH_REF" ] && [ -f "$FAKE_HOOK_ONCE" ]; then',
	'\t\trm -f "$FAKE_HOOK_ONCE"',
	'\t\tgit -C "$FAKE_BARE_DIR" update-ref "$FAKE_BEFORE_PUSH_REF" "$FAKE_BEFORE_PUSH_SHA"',
	"\tfi",
	"\t;;",
	"esac",
	'exec git "$@"',
	"",
].join("\n");

const stageConcurrentCommit = (relativePath: string, content: string, message: string): string => {
	commitFile(relativePath, content, message);
	const sha = git(workDir, "rev-parse", "HEAD");
	git(workDir, "push", "-q", "--force", "origin", `${sha}:refs/concurrent/staged`);
	return sha;
};

const runSync = (options: RunSyncOptions = {}): SyncResult => {
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(path.join(binDir, "curl"), FAKE_CURL, { mode: 0o755 });
	const hookOnceFile = path.join(root, "hook-once");
	if (options.beforeUnshallow || options.beforePush) {
		fs.writeFileSync(path.join(binDir, "git"), FAKE_GIT, { mode: 0o755 });
		fs.writeFileSync(hookOnceFile, "1");
	}
	installWindowsJqShim(binDir);
	// Windows spells the variable `Path`; spreading process.env and then adding `PATH`
	// would leave two keys and the child may see the original, so drop every casing.
	const inheritedEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
	);
	// Git for Windows' bash puts its own /usr/bin (with a real curl) ahead of the
	// inherited PATH, so a PATH entry alone is not enough. BASH_ENV is sourced after
	// that setup and re-prepends the fake bin directory.
	const bashEnvFile = path.join(root, "prepend-fake-bin.sh");
	fs.writeFileSync(
		bashEnvFile,
		[
			'if command -v cygpath >/dev/null 2>&1; then FAKE_BIN_DIR="$(cygpath -u "$FAKE_BIN_DIR")"; fi',
			'export PATH="$FAKE_BIN_DIR:$PATH"',
			"",
		].join("\n"),
	);
	const bareUrl = `${pathToFileURL(path.dirname(bareDir)).href}/`;
	const result = spawnSync(resolveBash(), [SCRIPT, NEW_PIN], {
		encoding: "utf-8",
		env: {
			...inheritedEnvironment,
			PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
			BASH_ENV: bashEnvFile,
			FAKE_BIN_DIR: binDir,
			FAKE_BARE_DIR: bareDir,
			FAKE_HOOK_ONCE: hookOnceFile,
			FAKE_BEFORE_UNSHALLOW_REF: options.beforeUnshallow?.ref ?? "",
			FAKE_BEFORE_UNSHALLOW_SHA: options.beforeUnshallow?.sha ?? "",
			FAKE_BEFORE_PUSH_REF: options.beforePush?.ref ?? "",
			FAKE_BEFORE_PUSH_SHA: options.beforePush?.sha ?? "",
			GITEA_TOKEN: "test-token",
			GITEA_URL: "http://gitea.test",
			SELF_REPO: "not-a-consumer",
			FAKE_REQUEST_LOG: requestLog,
			FAKE_OLD_PIN: OLD_PIN,
			FAKE_PR_TITLE: HAND_EDITED_TITLE,
			FAKE_PR_CREATE_STATUS: String(options.prCreateStatus ?? 409),
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `url.${bareUrl}.insteadOf`,
			GIT_CONFIG_VALUE_0: "http://claude-code:test-token@gitea.test/schoen/",
		},
	});
	const requests = fs.existsSync(requestLog) ? fs.readFileSync(requestLog, "utf-8") : "";
	return { status: result.status, output: `${result.stdout}${result.stderr}`, requests };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "aislop-sync-consumers-"));
	bareDir = path.join(root, "remote", "consumer.git");
	workDir = path.join(root, "work");
	requestLog = path.join(root, "requests.log");
	fs.mkdirSync(bareDir, { recursive: true });
	git(bareDir, "init", "-q", "--bare", "--initial-branch=main");
	git(root, "init", "-q", "--initial-branch=main", workDir);
	git(workDir, "config", "user.name", "tester");
	git(workDir, "config", "user.email", "tester@example.invalid");
	git(workDir, "remote", "add", "origin", pathToFileURL(bareDir).href);
	commitFile(".aislop/fork-commit", `${OLD_PIN}\n`, "chore: initial pin");
	git(workDir, "push", "-q", "origin", "main");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const pushBranch = (): void => {
	git(workDir, "push", "-q", "--force", "origin", `HEAD:refs/heads/${BRANCH}`);
};

describe("sync_consumers.sh pin-bump branch handling", () => {
	it("appends a pin commit without force when the branch holds fixes, and leaves the PR alone", () => {
		git(workDir, "checkout", "-q", "-b", BRANCH);
		commitFile(".aislop/fork-commit", `${"c".repeat(40)}\n`, "chore: bump aislop fork pin to cccccccccccc");
		commitFile("src/fix.txt", "fix for the new pin\n", "fix: make the new pin pass the gate");
		pushBranch();
		const fixTip = bareGit("rev-parse", BRANCH);

		const result = runSync();

		expect(result.status).toBe(0);
		expect(result.output).toContain("path=append");
		expect(isAncestor(fixTip, BRANCH)).toBe(true);
		expect(bareGit("rev-parse", `${BRANCH}^`)).toBe(fixTip);
		expect(bareGit("show", `${BRANCH}:.aislop/fork-commit`)).toBe(NEW_PIN);
		expect(bareGit("show", `${BRANCH}:src/fix.txt`)).toBe("fix for the new pin");
		expect(bareGit("log", "-1", "--format=%s", BRANCH)).toBe("chore: bump aislop fork pin to bbbbbbbbbbbb");
		expect(result.requests).not.toContain("PATCH");
	});

	it("treats a commit that touches the pin and another file as a fix", () => {
		git(workDir, "checkout", "-q", "-b", BRANCH);
		fs.mkdirSync(path.join(workDir, ".aislop"), { recursive: true });
		fs.writeFileSync(path.join(workDir, ".aislop", "fork-commit"), `${"c".repeat(40)}\n`);
		commitFile("src/fix.txt", "mixed\n", "fix: pin plus a source change");
		pushBranch();
		const mixedTip = bareGit("rev-parse", BRANCH);

		const result = runSync();

		expect(result.output).toContain("path=append");
		expect(bareGit("rev-parse", `${BRANCH}^`)).toBe(mixedTip);
		expect(result.requests).not.toContain("PATCH");
	});

	it.each([
		{
			id: "default-diverged-before-sync",
			advanceDuringUnshallow: false,
			expectedPath: "path=append",
			expectPatch: false,
		},
		{
			id: "default-fast-forwarded-during-unshallow-issue-129",
			advanceDuringUnshallow: true,
			expectedPath: "path=rebuild",
			expectPatch: true,
		},
	])(
		"appends when the branch has fallen behind a default branch that moved on ($id)",
		({ advanceDuringUnshallow, expectedPath, expectPatch }) => {
			git(workDir, "checkout", "-q", "-b", BRANCH);
			commitFile("src/fix.txt", "fix\n", "fix: consumer fix");
			pushBranch();
			const fixTip = bareGit("rev-parse", BRANCH);
			if (!advanceDuringUnshallow) {
				git(workDir, "checkout", "-q", "main");
				commitFile("README.md", "later work\n", "docs: later work on main");
				git(workDir, "push", "-q", "origin", "main");
			}

			const result = runSync(
				advanceDuringUnshallow
					? { beforeUnshallow: { ref: "refs/heads/main", sha: fixTip } }
					: {},
			);

			expect(result.status).toBe(0);
			expect(result.output).toContain(expectedPath);
			expect(isAncestor(fixTip, BRANCH)).toBe(true);
			expect(bareGit("show", `${BRANCH}:src/fix.txt`)).toBe("fix");
			expect(bareGit("show", `${BRANCH}:.aislop/fork-commit`)).toBe(NEW_PIN);
			expect(result.requests.includes("PATCH")).toBe(expectPatch);
		},
	);

	it("records a rejected push as a failure and never retries with force", () => {
		git(workDir, "checkout", "-q", "-b", BRANCH);
		commitFile("src/fix.txt", "fix\n", "fix: consumer fix");
		pushBranch();
		const concurrentFixTip = stageConcurrentCommit(
			"src/second-fix.txt",
			"concurrent fix\n",
			"fix: concurrent fix on branch",
		);

		const result = runSync({
			beforePush: { ref: `refs/heads/${BRANCH}`, sha: concurrentFixTip },
		});

		expect(result.status).toBe(1);
		expect(result.output).toContain("not retried with force");
		expect(bareGit("rev-parse", BRANCH)).toBe(concurrentFixTip);
		expect(bareGit("show", `${BRANCH}:src/second-fix.txt`)).toBe("concurrent fix");
		expect(result.requests).not.toContain("PATCH");
	});

	it.each([
		{
			id: "pin-only-tip-unchanged",
			concurrentFixBeforePush: false,
			expectedStatus: 0,
			expectedOutput: "path=rebuild: PR already open",
			expectStaleAncestor: false,
			expectedPin: NEW_PIN,
			expectedSubject: "chore: bump aislop fork pin to bbbbbbbbbbbb",
			expectPatch: true,
		},
		{
			id: "concurrent-fix-appended-before-push-issue-129",
			concurrentFixBeforePush: true,
			expectedStatus: 1,
			expectedOutput: "path=rebuild: force-push to chore/aislop-pin-bump failed",
			expectStaleAncestor: true,
			expectedPin: "c".repeat(40),
			expectedSubject: "fix: concurrent fix",
			expectPatch: false,
		},
	])(
		"rebuilds and force-pushes when the branch holds only pin-bump commits ($id)",
		({
			concurrentFixBeforePush,
			expectedStatus,
			expectedOutput,
			expectStaleAncestor,
			expectedPin,
			expectedSubject,
			expectPatch,
		}) => {
			git(workDir, "checkout", "-q", "-b", BRANCH);
			commitFile(".aislop/fork-commit", `${"c".repeat(40)}\n`, "chore: bump aislop fork pin to cccccccccccc");
			pushBranch();
			const staleTip = bareGit("rev-parse", BRANCH);
			const beforePush = concurrentFixBeforePush
				? {
						ref: `refs/heads/${BRANCH}`,
						sha: stageConcurrentCommit("src/fix.txt", "concurrent fix\n", "fix: concurrent fix"),
					}
				: undefined;

			const result = runSync({ beforePush });

			expect(result.status).toBe(expectedStatus);
			expect(result.output).toContain(expectedOutput);
			expect(isAncestor(staleTip, BRANCH)).toBe(expectStaleAncestor);
			expect(bareGit("show", `${BRANCH}:.aislop/fork-commit`)).toBe(expectedPin);
			expect(bareGit("log", "-1", "--format=%s", BRANCH)).toBe(expectedSubject);
			expect(result.requests.includes("PATCH")).toBe(expectPatch);
		},
	);

	it.each([
		{
			id: "branch-remains-absent",
			createBranchBeforePush: false,
			expectedStatus: 0,
			expectedOutput: "path=rebuild: PR opened",
			expectedPin: NEW_PIN,
			expectedSubject: "chore: bump aislop fork pin to bbbbbbbbbbbb",
		},
		{
			id: "concurrent-branch-created-before-push-issue-129",
			createBranchBeforePush: true,
			expectedStatus: 1,
			expectedOutput: "path=rebuild: force-push to chore/aislop-pin-bump failed",
			expectedPin: OLD_PIN,
			expectedSubject: "fix: concurrent fix",
		},
	])(
		"rebuilds from the default branch when no pin-bump branch exists ($id)",
		({ createBranchBeforePush, expectedStatus, expectedOutput, expectedPin, expectedSubject }) => {
			git(workDir, "checkout", "-q", "-b", BRANCH);
			const beforePush = createBranchBeforePush
				? {
						ref: `refs/heads/${BRANCH}`,
						sha: stageConcurrentCommit("src/fix.txt", "concurrent fix\n", "fix: concurrent fix"),
					}
				: undefined;

			const result = runSync({ prCreateStatus: 201, beforePush });

			expect(result.status).toBe(expectedStatus);
			expect(result.output).toContain(expectedOutput);
			expect(bareGit("rev-parse", `${BRANCH}^`)).toBe(bareGit("rev-parse", "main"));
			expect(bareGit("show", `${BRANCH}:.aislop/fork-commit`)).toBe(expectedPin);
			expect(bareGit("log", "-1", "--format=%s", BRANCH)).toBe(expectedSubject);
			expect(result.requests).not.toContain("PATCH");
		},
	);
});
