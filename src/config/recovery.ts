// Recovery from an invalid configuration: removes only the entries that fail validation.

import { emitConfigWarning } from "./warnings.js";

export interface ValidationIssue {
	readonly message: string;
	readonly path: PropertyKey[];
}

export const valueAtPath = (input: unknown, issuePath: readonly PropertyKey[]): unknown => {
	let value = input;
	for (const segment of issuePath) {
		if (!value || typeof value !== "object") return undefined;
		value = (value as Record<PropertyKey, unknown>)[segment];
	}
	return value;
};

interface RemovalResult {
	readonly input: unknown;
	readonly removed: boolean;
}

const removeValueAtPath = (input: unknown, issuePath: readonly PropertyKey[]): RemovalResult => {
	const [segment, ...remainingPath] = issuePath;
	if (segment === undefined || !input || typeof input !== "object") {
		return { input, removed: false };
	}

	if (Array.isArray(input)) {
		if (typeof segment !== "number" || segment < 0 || segment >= input.length) {
			return { input, removed: false };
		}
		const copy = [...input];
		if (remainingPath.length === 0) {
			copy.splice(segment, 1);
			return { input: copy, removed: true };
		}
		const childResult = removeValueAtPath(copy[segment], remainingPath);
		if (!childResult.removed) return { input, removed: false };
		copy[segment] = childResult.input;
		return { input: copy, removed: true };
	}

	const record = input as Record<PropertyKey, unknown>;
	if (!Object.hasOwn(record, segment)) return { input, removed: false };
	const copy = { ...record };
	if (remainingPath.length === 0) {
		delete copy[segment];
		return { input: copy, removed: true };
	}
	const childResult = removeValueAtPath(copy[segment], remainingPath);
	if (!childResult.removed) return { input, removed: false };
	copy[segment] = childResult.input;
	return { input: copy, removed: true };
};

const orderPathsForRemoval = (left: ValidationIssue, right: ValidationIssue): number => {
	const leftParent = left.path.slice(0, -1);
	const rightParent = right.path.slice(0, -1);
	const sameParent =
		leftParent.length === rightParent.length &&
		leftParent.every((segment, index) => segment === rightParent[index]);
	const leftLast = left.path.at(-1);
	const rightLast = right.path.at(-1);
	if (sameParent && typeof leftLast === "number" && typeof rightLast === "number") {
		return rightLast - leftLast;
	}
	return right.path.length - left.path.length;
};

interface RecoveryResult {
	readonly input: unknown;
	readonly removedAny: boolean;
}

// Where an issue's fix is applied: the value it points at, or for an absent value (a
// missing required key) the entry that lacks it, because keeping the entry without the
// key would not validate and falling back to defaults for the whole file would silently
// discard every unrelated setting. Numeric array-element targets are preserved even
// when their value is undefined, so an undefined list item is spliced out rather than
// discarding the entire array.
const removalPathFor = (input: unknown, issue: ValidationIssue): readonly PropertyKey[] => {
	const lastSegment = issue.path.at(-1);
	if (typeof lastSegment === "number") {
		return issue.path;
	}
	return valueAtPath(input, issue.path) === undefined ? issue.path.slice(0, -1) : issue.path;
};

// Removes the value each issue points at. Every target is resolved against the input as
// the validator saw it and removed once: several issues can point at one entry (two
// missing keys, two failed checks), and removing it per issue would splice a second,
// valid neighbour out of the list after the indexes shifted.
export const recoverFromIssues = (
	input: unknown,
	issues: readonly ValidationIssue[],
): RecoveryResult => {
	const targets = new Map<string, ValidationIssue>();
	for (const issue of issues) {
		const removalPath = removalPathFor(input, issue);
		const key = JSON.stringify(removalPath);
		if (!targets.has(key)) targets.set(key, { message: issue.message, path: [...removalPath] });
		if (removalPath.length !== issue.path.length) {
			emitConfigWarning(
				`  ⚠ Ignoring aislop configuration entry ${removalPath.join(".")} because ${issue.path.join(".")} is missing.\n`,
			);
		}
	}

	let current = input;
	let removedAny = false;
	for (const target of [...targets.values()].sort(orderPathsForRemoval)) {
		const removal = removeValueAtPath(current, target.path);
		current = removal.input;
		removedAny ||= removal.removed;
	}
	return { input: current, removedAny };
};
