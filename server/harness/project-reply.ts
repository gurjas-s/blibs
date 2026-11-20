// Project reply text for the provider chat.
//
// The relay answers with one of these messages when it cannot start work. The
// provider reads the list, picks a project, and sends the task again. This
// module owns the `$` tokens and the reply text. The relay supplies the
// harness mention and the projects directory.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CHOICES_HEADER, startsWithChoicesHeader } from '../../shared/choices.js';
import { stripVendorLabel } from '../../shared/vendor-label.js';

export { CHOICES_HEADER };

/** Placeholder command for the create-project state. */
export const NEW_PROJECT_COMMAND = 'blibs new-project <name>';
export const PROJECT_CHOICE_LIMIT = 40;

const TOKEN_LIMIT = 80;
const REASON_LIMIT = 200;

/** One project as the provider sees it. */
export interface ProjectChoice {
  /** Absolute project path. */
  path: string;
  /** Token after `$`, without the dollar sign. */
  token: string;
}

export interface ReplyOptions {
  /** Harness trigger, for example `@opencode`. */
  mention: string;
  /** Projects directory, shown with `~` for the home folder. */
  root: string;
}

/** True when the text is a relay reply or an echo of one. */
export function isChoicesMessage(text: string): boolean {
  return startsWithChoicesHeader(stripVendorLabel(text));
}

function hashToken(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 4);
}

function baseToken(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, TOKEN_LIMIT);
  return slug || 'project';
}

/** Turn project paths into unique `$` tokens. The basename is the token. */
export function buildProjectChoices(paths: string[]): ProjectChoice[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push(resolved);
  }
  const base = unique.map((dir) => baseToken(path.basename(dir)));
  const counts = new Map<string, number>();
  for (const token of base) counts.set(token, (counts.get(token) ?? 0) + 1);
  const used = new Set<string>();
  return unique.map((dir, index) => {
    let token = base[index];
    if ((counts.get(token) ?? 0) > 1) token = `${token}-${hashToken(dir)}`;
    const candidate = token;
    let suffix = 2;
    while (used.has(token)) token = `${candidate}-${suffix++}`;
    used.add(token);
    return { path: dir, token };
  });
}

/** Shorten the home folder to `~` in one displayed path. */
export function displayPath(target: string): string {
  const home = process.env.HOME;
  if (!home) return target;
  if (target === home) return '~';
  if (target.startsWith(`${home}${path.sep}`)) return `~${target.slice(home.length)}`;
  return target;
}

function instruction(options: ReplyOptions): string {
  return `Reply with ${options.mention} $<project> <task>.`;
}

function projectLines(choices: ProjectChoice[]): string[] {
  return choices.map((choice) => `- $${choice.token}`);
}

function createLine(): string {
  return `To create a new project, run \`${NEW_PROJECT_COMMAND}\`.`;
}

/** The project list. The provider reads the tokens and sends one back. */
export function formatProjectList(
  choices: ProjectChoice[],
  options: ReplyOptions & { note?: string },
): string {
  const lines = [CHOICES_HEADER, '', 'Pick a project for your task:'];
  if (!choices.length) {
    lines.push(`No projects are available in ${displayPath(options.root)}.`);
    lines.push('');
    lines.push(createLine());
    return lines.join('\n');
  }
  lines.push(...projectLines(choices));
  if (options.note) lines.push('', options.note);
  lines.push('');
  lines.push(instruction(options));
  return lines.join('\n');
}

/** The reply when the task names a project that does not exist. */
export function formatUnknownProject(name: string, options: ReplyOptions): string {
  return [
    CHOICES_HEADER,
    '',
    `The project "${name.slice(0, REASON_LIMIT)}" does not exist in ${displayPath(options.root)}.`,
    '',
    createLine(),
  ].join('\n');
}

/** The reply when a project is named without a task. */
export function formatMissingTask(token: string, options: ReplyOptions): string {
  return [
    CHOICES_HEADER,
    '',
    `Add a task after $${token}.`,
    '',
    instruction(options),
  ].join('\n');
}
