// The harness reply header.
//
// The relay writes harness replies and the panel reads them. Both sides import
// this module, so the header prefix has one owner. Keep this module free of
// Node and browser APIs: the backend and the renderer both load it.

export const HARNESS_HEADER_PREFIX = "Sent from user's harness (";

export function isHarnessReplyText(text: string): boolean {
  return text.trimStart().startsWith(HARNESS_HEADER_PREFIX);
}
