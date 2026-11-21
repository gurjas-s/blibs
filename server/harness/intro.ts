// The blibs introduction reply.
//
// A chat can ask blibs about itself with an @blibs mention. The relay answers
// with one short message: what blibs does, which harnesses exist, which ones
// this assistant can use, and how a harness tag works. This module owns the
// trigger and the reply text. The shared module owns the first line.
import { INTRO_HEADER, startsWithIntroHeader } from '../../shared/intro.js';
import { stripVendorLabel } from '../../shared/vendor-label.js';
import { projectCreationFormat, projectSelectionFormat, projectTaskFormat } from './project-reply.js';
import { HARNESS_KINDS } from './registry.js';

export { INTRO_HEADER };

export const BLIBS_MENTION = '@blibs';

/** Harness that the introduction suggests first when it is enabled. */
const PREFERRED_HARNESS_ID = 'opencode';

/** One harness as the panel reports it. */
export interface HarnessChoice {
  id: string;
  name: string;
  enabled: boolean;
}

const BLIBS_PATTERN = /@blibs(?![\w-]|\.[\w-])/i;

/** True when the text tags blibs. The check ignores case and a vendor label. */
export function isBlibsMention(text: string): boolean {
  return BLIBS_PATTERN.test(stripVendorLabel(text));
}

/** True when the text is an introduction reply or an echo of one. */
export function isIntroMessage(text: string): boolean {
  return startsWithIntroHeader(stripVendorLabel(text));
}

export function harnessTag(id: string): string {
  return `@${id}`;
}

function names(choices: HarnessChoice[]): string {
  return choices.map((choice) => choice.name).join(', ');
}

function defaultChoices(): HarnessChoice[] {
  return HARNESS_KINDS.map((kind) => ({ id: kind.id, name: kind.name, enabled: true }));
}

function preferredHarness(enabled: HarnessChoice[]): HarnessChoice | undefined {
  return enabled.find((choice) => choice.id === PREFERRED_HARNESS_ID) ?? enabled[0];
}

/**
 * Build the introduction reply. The panel reports the harness list, so the
 * text follows the same toggles that the panel shows. An empty report falls
 * back to the harnesses that this build can drive.
 */
export function introMessage(choices: HarnessChoice[]): string {
  const available = choices.length ? choices : defaultChoices();
  const enabled = available.filter((choice) => choice.enabled);
  const enabledLine = enabled.length
    ? `Enabled for this assistant: ${names(enabled)}.`
    : 'Enabled for this assistant: no harness yet. Turn one on in Connections.';
  const suggested = preferredHarness(enabled);

  const lines = [
    INTRO_HEADER,
    '',
    'blibs is a desktop control panel for your personal assistant. It connects this chat to the local coding harnesses on your computer and sends tagged tasks to them.',
    '',
    `Available harnesses: ${names(available)}.`,
    enabledLine,
    '',
  ];
  if (suggested) {
    const tag = harnessTag(suggested.id);
    lines.push(
      `How tagging works: start a message with a harness tag. For example, ${tag} $alpha fix the failing test sends that task to ${suggested.name}. blibs types the harness reply back into this chat.`,
      '',
      `Use ${projectTaskFormat(tag)}. Send ${tag} by itself to list projects.`,
      `If the user asks for a new project, use ${projectCreationFormat(tag)}. Then use the returned project ID for your task.`,
      `If blibs asks you to choose a project for a saved task, reply with ${projectSelectionFormat(tag)} using the request ID from that message.`,
    );
  } else {
    lines.push(
      'How tagging works: start a message with a harness tag. A tag sends the task to that harness, and blibs types the harness reply back into this chat.',
      '',
      'Turn on a harness in Connections to send a task.',
    );
  }
  return lines.join('\n');
}
