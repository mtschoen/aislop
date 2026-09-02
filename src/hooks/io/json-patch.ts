import ts from "typescript";
import { parseJsonc } from "../../utils/read-jsonc.js";
import {
	deepEqual,
	detectEol,
	detectIndent,
	findProperty,
	formatValue,
	getNodeValue,
	getRootObject,
	hasCommentTrivia,
	insertArrayElementIntoSource,
	insertPropertyIntoSource,
	parseSourceFile,
	removeArrayElementFromSource,
	removePropertyFromSource,
} from "./ast-mutate.js";

export const AISLOP_SENTINEL_KEY = "__aislop" as const;

export const parseJsonConfiguration = (
	raw: string | null,
	target: string,
): Record<string, unknown> => {
	if (raw === null) return {};
	const parsed = parseJsonc(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Cannot update ${target}: invalid JSON. Fix or remove it, then rerun.`);
	}
	return parsed as Record<string, unknown>;
};

const isAislopManaged = (candidate: unknown): boolean =>
	typeof candidate === "object" &&
	candidate !== null &&
	AISLOP_SENTINEL_KEY in (candidate as Record<string, unknown>) &&
	(candidate as Record<string, unknown>)[AISLOP_SENTINEL_KEY] != null;

export interface EventHookOperation {
	event: string;
	action: "upsert" | "remove";
	group?: Record<string, unknown>;
	entry?: Record<string, unknown>;
}

export interface PatchHooksOptions {
	target: string;
	operations: EventHookOperation[];
	ensureRootProperties?: Record<string, unknown>;
	ignoredKeysOnEmptyCheck?: string[];
	isManagedCommand?: (commandCandidate: unknown) => boolean;
}

const validateHooksStructure = (
	root: Record<string, unknown>,
	target: string,
	operations: EventHookOperation[],
) => {
	if (root.hooks === undefined) return;
	if (typeof root.hooks !== "object" || root.hooks === null || Array.isArray(root.hooks)) {
		throw new Error(`Cannot update ${target}: expected hooks to be a JSON object.`);
	}
	const hooksObject = root.hooks as Record<string, unknown>;
	for (const operation of operations) {
		if (
			hooksObject[operation.event] !== undefined &&
			!Array.isArray(hooksObject[operation.event])
		) {
			throw new Error(`Cannot update ${target}: expected hooks.${operation.event} to be an array.`);
		}
	}
};

const applyFreshHooks = (options: PatchHooksOptions): string | null => {
	const rootObject: Record<string, unknown> = {};
	if (options.ensureRootProperties) Object.assign(rootObject, options.ensureRootProperties);
	const hooksObject: Record<string, unknown[]> = {};
	for (const operation of options.operations) {
		if (operation.action === "upsert") {
			hooksObject[operation.event] = operation.group
				? [operation.group]
				: operation.entry
					? [operation.entry]
					: [];
		}
	}
	if (Object.keys(hooksObject).length > 0) rootObject.hooks = hooksObject;
	if (!options.operations.some((operation) => operation.action === "upsert")) return null;
	return `${JSON.stringify(rootObject, null, 2)}\n`;
};

const inspectGroupForManaged = (
	groupNode: ts.ObjectLiteralExpression,
	isManaged: (commandCandidate: unknown) => boolean,
): { managedIndexToRemove?: number; removeWholeGroup: boolean } => {
	const groupHooksProperty = findProperty(groupNode, "hooks");
	if (groupHooksProperty && ts.isArrayLiteralExpression(groupHooksProperty.initializer)) {
		const commandElements = groupHooksProperty.initializer.elements;
		const managedIndices: number[] = [];
		for (let commandIndex = 0; commandIndex < commandElements.length; commandIndex++) {
			if (isManaged(getNodeValue(commandElements[commandIndex]))) managedIndices.push(commandIndex);
		}
		if (managedIndices.length === commandElements.length || isManaged(getNodeValue(groupNode))) {
			return { removeWholeGroup: true };
		}
		if (managedIndices.length > 0) {
			return {
				managedIndexToRemove: managedIndices[managedIndices.length - 1],
				removeWholeGroup: false,
			};
		}
		return { removeWholeGroup: false };
	}
	return { removeWholeGroup: isManaged(getNodeValue(groupNode)) };
};

const isAlreadyConfigured = (
	eventProperty: ts.PropertyAssignment,
	desired: Record<string, unknown>,
	isManaged: (commandCandidate: unknown) => boolean,
): boolean => {
	if (!ts.isArrayLiteralExpression(eventProperty.initializer)) return false;
	let hasMatching = false;
	let hasOtherManaged = false;
	for (const elem of eventProperty.initializer.elements) {
		const elemVal = getNodeValue(elem);
		if (deepEqual(elemVal, desired)) {
			hasMatching = true;
		} else if (ts.isObjectLiteralExpression(elem)) {
			const groupHooks = findProperty(elem, "hooks");
			if (groupHooks && ts.isArrayLiteralExpression(groupHooks.initializer)) {
				if (groupHooks.initializer.elements.some((cmd) => isManaged(getNodeValue(cmd))))
					hasOtherManaged = true;
			} else if (isManaged(elemVal)) {
				hasOtherManaged = true;
			}
		} else if (isManaged(elemVal)) {
			hasOtherManaged = true;
		}
	}
	return hasMatching && !hasOtherManaged;
};

const removeNextManagedFromEvent = (
	source: string,
	eventProperty: ts.PropertyAssignment,
	sourceFile: ts.JsonSourceFile,
	isManaged: (commandCandidate: unknown) => boolean,
): { nextSource: string; removed: boolean } => {
	if (!ts.isArrayLiteralExpression(eventProperty.initializer))
		return { nextSource: source, removed: false };
	const arrayNode = eventProperty.initializer;
	for (let index = 0; index < arrayNode.elements.length; index++) {
		const elementNode = arrayNode.elements[index];
		if (ts.isObjectLiteralExpression(elementNode)) {
			const inspection = inspectGroupForManaged(elementNode, isManaged);
			if (inspection.removeWholeGroup) {
				return {
					nextSource: removeArrayElementFromSource(source, sourceFile, arrayNode, index),
					removed: true,
				};
			}
			if (inspection.managedIndexToRemove !== undefined) {
				const groupHooks = findProperty(elementNode, "hooks");
				if (groupHooks && ts.isArrayLiteralExpression(groupHooks.initializer)) {
					return {
						nextSource: removeArrayElementFromSource(
							source,
							sourceFile,
							groupHooks.initializer,
							inspection.managedIndexToRemove,
						),
						removed: true,
					};
				}
			}
		} else if (isManaged(getNodeValue(elementNode))) {
			return {
				nextSource: removeArrayElementFromSource(source, sourceFile, arrayNode, index),
				removed: true,
			};
		}
	}
	return { nextSource: source, removed: false };
};

const insertEventHook = (
	source: string,
	sourceFile: ts.JsonSourceFile,
	hooksObject: ts.ObjectLiteralExpression,
	event: string,
	elementToInsert: Record<string, unknown>,
): string => {
	const eventProperty = findProperty(hooksObject, event);
	if (eventProperty && ts.isArrayLiteralExpression(eventProperty.initializer)) {
		const formatted = formatValue(elementToInsert, detectIndent(source), detectEol(source), 3);
		return insertArrayElementIntoSource(
			source,
			sourceFile,
			eventProperty.initializer,
			formatted,
			3,
		);
	}
	if (!eventProperty) {
		const formatted = formatValue([elementToInsert], detectIndent(source), detectEol(source), 2);
		return insertPropertyIntoSource(source, sourceFile, hooksObject, event, formatted, 2);
	}
	return source;
};

const mutateEventArray = (
	source: string,
	operation: EventHookOperation,
	isManaged: (commandCandidate: unknown) => boolean,
): string => {
	let currentSource = source;
	const desired = operation.group ?? operation.entry;

	if (operation.action === "upsert" && desired) {
		const sourceFile = parseSourceFile(currentSource);
		const hooksProperty = findProperty(getRootObject(sourceFile), "hooks");
		if (hooksProperty && ts.isObjectLiteralExpression(hooksProperty.initializer)) {
			const eventProperty = findProperty(hooksProperty.initializer, operation.event);
			if (eventProperty && isAlreadyConfigured(eventProperty, desired, isManaged))
				return currentSource;
		}
	}

	while (true) {
		const sourceFile = parseSourceFile(currentSource);
		const hooksProperty = findProperty(getRootObject(sourceFile), "hooks");
		if (!hooksProperty || !ts.isObjectLiteralExpression(hooksProperty.initializer)) break;
		const eventProperty = findProperty(hooksProperty.initializer, operation.event);
		if (!eventProperty) break;
		const { nextSource, removed } = removeNextManagedFromEvent(
			currentSource,
			eventProperty,
			sourceFile,
			isManaged,
		);
		if (!removed) break;
		currentSource = nextSource;
	}

	if (operation.action === "upsert" && desired) {
		const sourceFile = parseSourceFile(currentSource);
		const hooksProperty = findProperty(getRootObject(sourceFile), "hooks");
		if (hooksProperty && ts.isObjectLiteralExpression(hooksProperty.initializer)) {
			currentSource = insertEventHook(
				currentSource,
				sourceFile,
				hooksProperty.initializer,
				operation.event,
				desired,
			);
		}
	}

	const sourceFile = parseSourceFile(currentSource);
	const hooksProperty = findProperty(getRootObject(sourceFile), "hooks");
	if (hooksProperty && ts.isObjectLiteralExpression(hooksProperty.initializer)) {
		const eventProperty = findProperty(hooksProperty.initializer, operation.event);
		if (
			eventProperty &&
			ts.isArrayLiteralExpression(eventProperty.initializer) &&
			eventProperty.initializer.elements.length === 0 &&
			!hasCommentTrivia(currentSource, sourceFile, eventProperty.initializer)
		) {
			currentSource = removePropertyFromSource(
				currentSource,
				sourceFile,
				hooksProperty.initializer,
				operation.event,
			);
		}
	}
	return currentSource;
};

const mutateExistingHooks = (
	source: string,
	options: PatchHooksOptions,
	isManaged: (commandCandidate: unknown) => boolean,
): string => {
	let currentSource = source;
	for (const operation of options.operations) {
		const sourceFile = parseSourceFile(currentSource);
		const hooksProperty = findProperty(getRootObject(sourceFile), "hooks");
		if (!hooksProperty || !ts.isObjectLiteralExpression(hooksProperty.initializer)) break;
		currentSource = mutateEventArray(currentSource, operation, isManaged);
	}
	const sourceFile = parseSourceFile(currentSource);
	const hooksProperty = findProperty(getRootObject(sourceFile), "hooks");
	if (hooksProperty && ts.isObjectLiteralExpression(hooksProperty.initializer)) {
		if (
			(!hooksProperty.initializer.properties ||
				hooksProperty.initializer.properties.length === 0) &&
			!hasCommentTrivia(currentSource, sourceFile, hooksProperty.initializer)
		) {
			currentSource = removePropertyFromSource(
				currentSource,
				sourceFile,
				getRootObject(sourceFile),
				"hooks",
			);
		}
	}
	return currentSource;
};

export const patchJsonHooks = (raw: string | null, options: PatchHooksOptions): string | null => {
	if (raw === null) return applyFreshHooks(options);
	const parsed = parseJsonConfiguration(raw, options.target);
	validateHooksStructure(parsed, options.target, options.operations);

	const isManaged = options.isManagedCommand
		? (candidate: unknown) =>
				isAislopManaged(candidate) || Boolean(options.isManagedCommand?.(candidate))
		: isAislopManaged;

	let source = raw;
	if (options.ensureRootProperties) {
		for (const [key, value] of Object.entries(options.ensureRootProperties)) {
			const sourceFile = parseSourceFile(source);
			if (!findProperty(getRootObject(sourceFile), key)) {
				const formatted = formatValue(value, detectIndent(source), detectEol(source), 1);
				source = insertPropertyIntoSource(
					source,
					sourceFile,
					getRootObject(sourceFile),
					key,
					formatted,
					1,
				);
			}
		}
	}

	const sourceFile = parseSourceFile(source);
	const rootNode = getRootObject(sourceFile);
	const hooksProperty = findProperty(rootNode, "hooks");

	if (!hooksProperty) {
		const upserts = options.operations.filter((operation) => operation.action === "upsert");
		if (upserts.length > 0) {
			const newHooksObject: Record<string, unknown[]> = {};
			for (const operation of upserts) {
				newHooksObject[operation.event] = operation.group
					? [operation.group]
					: operation.entry
						? [operation.entry]
						: [];
			}
			const formattedHooks = formatValue(
				newHooksObject,
				detectIndent(source),
				detectEol(source),
				1,
			);
			source = insertPropertyIntoSource(source, sourceFile, rootNode, "hooks", formattedHooks, 1);
		}
	} else {
		source = mutateExistingHooks(source, options, isManaged);
	}

	let finalSourceFile = parseSourceFile(source);
	let rootObject = getRootObject(finalSourceFile);
	let currentRootValue = (getNodeValue(rootObject) as Record<string, unknown>) || {};
	let remainingKeys = Object.keys(currentRootValue).filter(
		(key) => key !== "hooks" && !options.ignoredKeysOnEmptyCheck?.includes(key),
	);
	let stillHasHooks =
		currentRootValue.hooks &&
		typeof currentRootValue.hooks === "object" &&
		Object.keys(currentRootValue.hooks as object).length > 0;

	if (!stillHasHooks && remainingKeys.length === 0) {
		if (options.ignoredKeysOnEmptyCheck) {
			for (const key of options.ignoredKeysOnEmptyCheck) {
				finalSourceFile = parseSourceFile(source);
				rootObject = getRootObject(finalSourceFile);
				if (findProperty(rootObject, key)) {
					source = removePropertyFromSource(source, finalSourceFile, rootObject, key);
				}
			}
		}
		if (!/\/\/|\/\*/.test(source)) return null;
	}
	return source;
};
