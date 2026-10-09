/** Remove vendor interface labels from collected message text. */
export function cleanImportText(raw: string): string {
  return raw
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(assistant message|user message|you)\s*:\s*/i, '')
    .trim();
}
