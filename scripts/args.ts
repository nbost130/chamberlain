/** The value after a `--flag` in argv, or undefined when the flag is absent or last. */
export function flagReader(argv: string[]): (name: string) => string | undefined {
	return (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
}
