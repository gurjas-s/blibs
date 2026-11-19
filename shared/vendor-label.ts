// Vendor bubble labels.
//
// A scraped vendor bubble can carry a role label before its text. The relay,
// the panel, and the live checks strip the same labels, so they share this
// module. Keep this module free of Node and browser APIs: the backend and
// the renderer both load it.

/** Label that a scraped vendor bubble can carry before its text. */
export const VENDOR_LABEL = /^(?:you|user message|assistant message|agent message)\s*:\s*/i;

/** Remove one vendor bubble label from the start of the text. */
export function stripVendorLabel(text: string): string {
  return text.trimStart().replace(VENDOR_LABEL, '').trimStart();
}
