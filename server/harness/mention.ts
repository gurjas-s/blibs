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

export function isUserEcho(text: string): boolean {
  return text.trimStart().startsWith(USER_ECHO_LABEL);
}

export function stripUserEcho(text: string): string {
  if (!isUserEcho(text)) return text;
  return text.trimStart().slice(USER_ECHO_LABEL.length).trimStart();
}

export function extractMentionTask(text: string, mention: string = OPENCODE_MENTION): string | null {
  const body = stripVendorLabel(text);
  if (!mentionPattern(mention).test(body)) return null;
  const task = body.replace(mentionPattern(mention), '').trim().replace(/\n{3,}/g, '\n\n');
  if (task.length < 2) return null;
  return task;
}

export function sanitizeReply(text: string, mention: string = OPENCODE_MENTION): string {
  return text.replace(mentionPattern(mention), mention.replace(/^@/, ''));
}
