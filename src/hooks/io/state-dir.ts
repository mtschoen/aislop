import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

// Hook runtime artifacts (baseline.json, session.jsonl, hook.lock) live
// OUTSIDE the scanned repo. Writing them into <repo>/.aislop made the tool's
// litter indistinguishable from tracked repo content (an agent deleted a
// repo's tracked .aislop/config.yml after concluding the whole directory was
// tool-generated) and dirtied every scanned worktree. Only an explicit
// `aislop init` may create files inside the repo.
//
// The directory is keyed by the resolved repo path (readable basename plus a
// short hash) so concurrent repos never collide and a moved repo simply
// starts a fresh baseline.
export const hookStateDir = (
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	homeDirectory: string = os.homedir(),
): string => {
	const resolved = path.resolve(cwd);
	const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
	const basename = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
	const key = `${basename}-${hash}`;
	if (env.AISLOP_HOOK_STATE_DIR) {
		return path.join(env.AISLOP_HOOK_STATE_DIR, key);
	}
	if (process.platform === "linux" && env.XDG_STATE_HOME) {
		return path.join(env.XDG_STATE_HOME, "aislop", "hook-state", key);
	}
	return path.join(homeDirectory, ".aislop", "hook-state", key);
};
