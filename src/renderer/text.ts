import { startsWithChoicesHeader } from '../../shared/choices';
import { isHarnessReplyText as hasHarnessHeader } from '../../shared/harness';
import { startsWithIntroHeader } from '../../shared/intro';
import { stripVendorLabel, VENDOR_LABEL } from '../../shared/vendor-label';

/** Remove vendor interface labels from collected message text. */
export function cleanImportText(raw: string): string {
  const cleaned = raw.replace(/\[\[[^\]]*\]\]/g, ' ');
  const labelled = cleaned.trimStart().replace(VENDOR_LABEL, '').trim();
  if (startsWithChoicesHeader(labelled) || startsWithIntroHeader(labelled)) {
    return labelled.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  return cleaned.replace(/\s+/g, ' ').trim().replace(VENDOR_LABEL, '').trim();
}

/** True when an imported message is a project or session choice reply. */
export function isChoicesText(text: string): boolean {
  return startsWithChoicesHeader(stripVendorLabel(text));
}

/** True when an imported message is a harness reply. */
export function isHarnessReplyText(text: string): boolean {
  return hasHarnessHeader(stripVendorLabel(text));
}

/** True when an imported message is the generated blibs introduction. */
export { startsWithIntroHeader as isIntroText } from '../../shared/intro';

/**
 * Remove repeated copies of a blibs or harness reply. The vendor page can
 * re-render one bubble with a new position, and each render becomes a new
 * history row. User messages and normal assistant messages stay untouched.
 */
export function dedupeReplyMessages<T extends { role: string; text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (item.role !== 'agent') return true;
    const text = cleanImportText(item.text);
    if (!startsWithIntroHeader(text) && !isChoicesText(text) && !isHarnessReplyText(text)) return true;
    const key = text.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
