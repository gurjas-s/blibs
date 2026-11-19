// The blibs introduction marker.
//
// The relay writes the introduction and the panel reads it. Both sides import
// this module, so the first line has one owner. Keep this module free of Node
// and browser APIs: the backend and the renderer both load it.

/** First line of every introduction reply. An echo of this line is not a trigger. */
export const INTRO_HEADER = 'blibs introduction';

/** True when the text starts with the introduction header. */
export function startsWithIntroHeader(text: string): boolean {
  return text.trimStart().startsWith(INTRO_HEADER);
}
