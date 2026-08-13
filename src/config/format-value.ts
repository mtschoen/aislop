import { inspect } from "node:util";

const INSPECT_OPTIONS = {
	breakLength: Number.POSITIVE_INFINITY,
	compact: true,
	depth: 4,
} as const;

export const formatConfigValue = (value: unknown): string => {
	if (typeof value === "number" && !Number.isFinite(value)) return String(value);
	try {
		return JSON.stringify(value) ?? inspect(value, INSPECT_OPTIONS);
	} catch {
		return inspect(value, INSPECT_OPTIONS);
	}
};
