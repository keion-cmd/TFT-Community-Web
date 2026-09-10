// T-CODE-40 Part 4 — message formatting. Rendering concern only, no schema
// change (messages.content stays plain text).
//
// SECURITY: this module never produces an HTML string. It parses plain text
// into a typed token tree that a future UI renders as React elements
// (<strong>{token.content}</strong>, etc.) with the token's text content as
// a normal React child — React escapes text children itself, so there is no
// HTML string at any point in this pipeline and therefore no
// dangerouslySetInnerHTML call is possible, needed, or should ever be added
// for this feature. This is stronger than an "escape then whitelist markup
// back in" approach (the more common way these renderers get built): there
// is no un-escape step for an attacker to find a gap in.
//
// Only four constructs are recognised, per the task's explicit allow-list:
// **bold**, *italic*, `code`, and a leading "> " on a line for a quote.
// Everything else (raw HTML, links, anything else) is left as plain text —
// this parser has no concept of "unsafe input" because it never interprets
// anything as markup other than these four patterns, and even those never
// leave the token/plain-text domain.

export type InlineToken =
  | { type: "text"; content: string }
  | { type: "bold"; content: string }
  | { type: "italic"; content: string }
  | { type: "code"; content: string };

export type FormattedLine = {
  quote: boolean;
  inline: InlineToken[];
};

// Matches, in order of precedence: **bold**, *italic*, `code`. Bold is
// checked before italic so `**x**` is never mis-split into two italics
// around an empty bold.
const INLINE_PATTERN = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`/g;

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_PATTERN.lastIndex = 0;
  while ((match = INLINE_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    const [, bold, italic, code] = match;
    if (bold !== undefined) {
      tokens.push({ type: "bold", content: bold });
    } else if (italic !== undefined) {
      tokens.push({ type: "italic", content: italic });
    } else if (code !== undefined) {
      tokens.push({ type: "code", content: code });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", content: text.slice(lastIndex) });
  }
  if (tokens.length === 0) {
    tokens.push({ type: "text", content: text });
  }
  return tokens;
}

// Splits on line breaks first (each line parsed independently — the inline
// patterns above never span a line break), then strips a leading "> " to
// mark a line as a quote line for the UI to render inside a <blockquote>.
export function parseMessageContent(content: string): FormattedLine[] {
  return content.split("\n").map((line) => {
    const quote = line.startsWith("> ");
    const rest = quote ? line.slice(2) : line;
    return { quote, inline: parseInline(rest) };
  });
}
