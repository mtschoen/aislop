const emittedWarnings = new Set<string>();

export const emitConfigWarning = (message: string): void => {
	if (emittedWarnings.has(message)) return;
	emittedWarnings.add(message);
	process.stderr.write(message);
};

export const resetConfigWarnings = (): void => {
	emittedWarnings.clear();
};
