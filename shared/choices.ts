// The blibs choice reply marker.
//
// The relay writes project and session lists and the panel reads them. Both
// sides import this module, so the first line has one owner. Keep this module
// free of Node and browser APIs: the backend and the renderer both load it.

/** First line of every project or session choice reply. */
export const CHOICES_HEADER = 'blibs choices';

export function startsWithChoicesHeader(text: string): boolean {
  return text.trimStart().startsWith(CHOICES_HEADER);
}
