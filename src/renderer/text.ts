/** Remove vendor interface labels from collected message text. */
export function cleanImportText(raw: string): string {
  return raw
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^(assistant message|user message|you)[ \t]*:[ \t]*/i, '')
    .trim();
}

export function normalizeMessageText(text: string): string {
  return cleanImportText(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

export type MessagePart = { kind: 'text'; text: string } | { kind: 'code'; text: string; language: string };

/** Render fenced code as text, without interpreting message content as HTML. */
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const fence = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*(?:\n|$)/gm;
  let previous = 0;
  for (const match of text.matchAll(fence)) {
    if (match.index > previous) parts.push({ kind: 'text', text: text.slice(previous, match.index) });
    parts.push({ kind: 'code', language: match[1].trim(), text: match[2].replace(/\n$/, '') });
    previous = match.index + match[0].length;
  }
  if (previous < text.length) parts.push({ kind: 'text', text: text.slice(previous) });
  return parts;
}
