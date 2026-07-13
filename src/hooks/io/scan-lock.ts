import fs from "node:fs";
import path from "node:path";
import { hookStateDir } from "./state-dir.js";

const LOCK_FILE = "hook.lock";
const STALE_MS = 30_000;

interface LockPayload {
	pid: number;
	ts: number;
}

// Lives in the per-repo hook state directory, not in the scanned repo (see
// state-dir.ts). No migration: a stale legacy lock goes stale in 30s anyway.
const lockPath = (cwd: string): string => path.join(hookStateDir(cwd), LOCK_FILE);

const readLock = (target: string): LockPayload | null => {
	try {
		const raw = fs.readFileSync(target, "utf-8");
		const parsed = JSON.parse(raw) as LockPayload;
		if (typeof parsed.pid !== "number" || typeof parsed.ts !== "number") return null;
		return parsed;
	} catch {
		return null;
	}
};

export const acquireHookLock = (cwd: string): (() => void) | null => {
	const target = lockPath(cwd);
	const existing = readLock(target);
	if (existing && Date.now() - existing.ts < STALE_MS) return null;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, JSON.stringify({ pid: process.pid, ts: Date.now() }));
	} catch {
		return null;
	}
	return () => {
		try {
			const current = readLock(target);
			if (current?.pid === process.pid) fs.unlinkSync(target);
		} catch {
			// best-effort release
		}
	};
};
