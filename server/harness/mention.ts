// Chat mention triggers for harnesses (for example @opencode).
//
// Only this module knows the trigger syntax. The relay asks it for the task
// behind a mention and for reply text that cannot retrigger. A syntax change
// or a new harness mention stays here.
import { stripVendorLabel } from '../../shared/vendor-label.js';

export const OPENCODE_MENTION = '@opencode';

/** Muse reports the user turn with role agent and this label. */
export const USER_ECHO_LABEL = 'You:';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionPattern(mention: string): RegExp {
  return new RegExp(`${escapeRegExp(mention)}\\b`, 'gi');
}

export function isUserTurn(text: string): boolean {
  return /^(?:you|user message)\s*:/i.test(text.trimStart());
}

export function isUserEcho(text: string): boolean {
  return isUserTurn(text);
}

export function stripUserEcho(text: string): string {
  if (!isUserEcho(text)) return text;
  return text.trimStart().replace(/^(?:you|user message)\s*:\s*/i, '');
}

/** True when the text starts with the mention after a vendor label. */
export function startsWithMention(text: string, mention: string = OPENCODE_MENTION): boolean {
  const body = stripVendorLabel(text);
  return new RegExp(`^${escapeRegExp(mention)}\\b`, 'i').test(body);
}

/** Remove the mention token. A bare mention returns an empty string. */
export function extractMentionBody(text: string, mention: string = OPENCODE_MENTION): string | null {
  const body = stripVendorLabel(text);
  if (!mentionPattern(mention).test(body)) return null;
  return body.replace(mentionPattern(mention), '').trim().replace(/\n{3,}/g, '\n\n');
}

export function extractMentionTask(text: string, mention: string = OPENCODE_MENTION): string | null {
  const task = extractMentionBody(text, mention);
  if (task === null || task.length < 2) return null;
  return task;
}

export function sanitizeReply(text: string, mention: string = OPENCODE_MENTION): string {
  return text.replace(mentionPattern(mention), mention.replace(/^@/, ''));
}
