/** The Alert Desk's command allowlist: splitting a command line into tokens, refusing shell syntax. */

type Lex = {
	/** The commands so far, split at each unquoted `|`; `part` is the last of them. */
	parts: string[][];
	part: string[];
	cur: string;
	inTok: boolean;
	q: "" | "'" | '"';
};

/** Ends the token being read, if one has begun. */
function endToken(s: Lex): void {
	if (s.inTok) s.part.push(s.cur);
	s.cur = "";
	s.inTok = false;
}

/** One character inside quotes: the fault, or undefined once it is taken. Nothing expands in single quotes; in double quotes `$`, a backtick and a backslash do. */
function quotedChar(s: Lex, c: string): string | undefined {
	if (s.q === "'") {
		if (c === "'") s.q = "";
		else s.cur += c;
		return undefined;
	}
	if (c === '"') s.q = "";
	else if (c === "$" || c === "`" || c === "\\") return "a $, backtick or backslash inside double quotes expands";
	else s.cur += c;
	return undefined;
}

const SHELL_SYNTAX = /[;&<>(){}$`\\*?[\]!~#\n\r]/;

/** One character outside quotes, with the one after it: the fault, or undefined once it is taken. */
function bareChar(s: Lex, c: string, next: string | undefined): string | undefined {
	if (c === "'" || c === '"') {
		s.q = c;
		s.inTok = true;
	} else if (c === " " || c === "\t") {
		endToken(s);
	} else if (c === "|") {
		if (next === "|") return "|| chains commands";
		endToken(s);
		s.part = [];
		s.parts.push(s.part);
	} else if (SHELL_SYNTAX.test(c)) {
		return `an unquoted ${JSON.stringify(c)} is shell syntax (chaining, redirection, expansion or a glob)`;
	} else {
		s.cur += c;
		s.inTok = true;
	}
	return undefined;
}

/** Splits on unquoted `|` and tokenizes each part, or says what is wrong. Quoted text is literal; an unquoted metacharacter is refused. */
export function tokenize(cmd: string): { parts: string[][] } | { error: string } {
	const first: string[] = [];
	const s: Lex = { parts: [first], part: first, cur: "", inTok: false, q: "" };
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd.charAt(i);
		const fault = s.q ? quotedChar(s, c) : bareChar(s, c, cmd[i + 1]);
		if (fault !== undefined) return { error: fault };
	}
	if (s.q) return { error: "an unclosed quote" };
	endToken(s);
	if (s.parts.some((p) => p.length === 0)) return { error: "an empty command around a pipe" };
	return { parts: s.parts };
}

// ---- flag specs --------------------------------------------------------------------------------------
