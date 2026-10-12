import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LANGUAGES } from "./args.mjs";

export const validateRepo = (repo) => {
	const component = (value) =>
		typeof value === "string" &&
		/^[a-zA-Z0-9_.-]{1,100}$/.test(value) &&
		!/^\.{1,2}$/.test(value) &&
		!value.endsWith(".") &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
	if (
		!repo ||
		!DEFAULT_LANGUAGES.includes(repo.language) ||
		!component(repo.owner) ||
		!component(repo.name) ||
		!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(repo.owner)
	) {
		throw new Error(
			"Invalid repository identity: expected supported language and single-component owner/name",
		);
	}
	const cloneUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
	if (
		(repo.cloneUrl !== undefined && repo.cloneUrl !== cloneUrl) ||
		(repo.revision !== undefined &&
			(typeof repo.revision !== "string" ||
				!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(repo.revision)))
	) {
		throw new Error("Invalid repository URL or pinned revision");
	}
	return { ...repo, cloneUrl };
};

export const assertNoSymlinks = (target) => {
	let current = path.resolve(target);
	while (true) {
		const stat = fs.lstatSync(current, { throwIfNoEntry: false });
		if (stat?.isSymbolicLink()) throw new Error(`Unsafe symlink in benchmark path: ${current}`);
		if (current !== path.resolve(target) && stat && !stat.isDirectory()) {
			throw new Error(`Non-directory benchmark ancestor: ${current}`);
		}
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
};

const isDescendant = (root, target) => {
	const relative = path.relative(root, target);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
};

export const containedPath = (root, ...components) => {
	const target = path.resolve(root, ...components);
	if (!isDescendant(path.resolve(root), target)) throw new Error("Benchmark path escapes its root");
	assertNoSymlinks(target);
	if (
		fs.existsSync(root) &&
		fs.existsSync(target) &&
		!isDescendant(fs.realpathSync(root), fs.realpathSync(target))
	) {
		throw new Error("Benchmark real path escapes its root");
	}
	return target;
};
