import { createHash } from 'node:crypto';
import path from 'node:path';
import { CHOICES_HEADER, startsWithChoicesHeader } from '../../shared/choices.js';
import { stripVendorLabel } from '../../shared/vendor-label.js';

export { CHOICES_HEADER };

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

export function projectSelectionFormat(mention: string, requestId = '<request-id>', project = '$<project>'): string {
  return `${mention} /select ${requestId} ${project}`;
}

export function projectCreationFormat(mention: string): string {
  return `${mention} /new-project <name>`;
}

export function sessionCommands(mention: string, project = '$<project>'): string[] {
  return [
    `For a separate task, start a clean session with ${mention} /new ${project} <name> <task>. Use one name with letters, numbers, underscores, or hyphens. Start with a letter or number.`,
    `If you need the available names, list sessions with ${mention} /sessions ${project}.`,
    `For a follow-up, use the session name from the conversation. Send ${mention} /resume ${project} <name> <task> with the full task.`,
    'If blibs lists model IDs, choose an exact ID from the list and resend the full command and task.',
    'If the user requests a model, put --model <model-id> after the session name and before the task. For OpenCode, use provider/model. Omit the option to use the configured default.',
  ];
}

/** Show the available project IDs and how to continue. */
export function formatProjectList(
  choices: ProjectChoice[],
  options: ReplyOptions & { note?: string; requestId?: string; total?: number },
): string {
  const lines = [CHOICES_HEADER];
  if (options.note) lines.push('', options.note);
  if (!choices.length) {
    lines.push(
      '',
      `No projects are available in ${displayPath(options.root)}.`,
    );
  } else {
    lines.push('', 'Pick a project for your task:', ...choices.map(({ token }) => `- $${token}`));
    if (options.total && options.total > choices.length) {
      lines.push(`Showing the first ${choices.length} of ${options.total} projects.`);
    }
    if (options.requestId) {
      lines.push('', `Reply with ${projectSelectionFormat(options.mention, options.requestId)} to see the sessions for that project.`);
    }
  }
  lines.push('', `If the user asks for a new project, use ${projectCreationFormat(options.mention)}.`);
  lines.push('', ...sessionCommands(options.mention));
  return lines.join('\n');
}

export function unknownProjectNote(name: string, options: ReplyOptions): string {
  return `The project "${name.slice(0, REASON_LIMIT)}" is unavailable in ${displayPath(options.root)}.`;
}

function modelDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + Number(left[row - 1] !== right[column - 1]),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

/** Offer exact IDs that the assistant can use in a replacement command. */
export function formatModelChoices(requested: string, models: readonly string[]): string {
  const query = requested.split('#', 1)[0].toLowerCase();
  const slash = query.indexOf('/');
  const provider = slash === -1 ? undefined : query.slice(0, slash);
  const name = query.slice(slash + 1);
  const matches = models.map((id) => {
    const candidate = id.toLowerCase();
    const separator = candidate.indexOf('/');
    const key = candidate.slice(separator + 1);
    let distance = 0;
    if (!key.split(/[-_.:/]+/).includes(name)) {
      distance = key.includes(name) ? 1 : 2 + modelDistance(name, key);
    }
    return { id, distance, providerMatches: candidate.slice(0, separator) === provider };
  }).sort((left, right) =>
    left.distance - right.distance || Number(right.providerMatches) - Number(left.providerMatches)
    || right.id.localeCompare(left.id, 'en', { numeric: true }),
  ).slice(0, 5);
  return [
    CHOICES_HEADER,
    '',
    'The requested model is unavailable in this project. Closest available model IDs:',
    ...matches.map(({ id }) => `- ${id}`),
    '',
    'Choose an exact ID and resend the same /new or /resume command with --model <model-id> and the full task.',
  ].join('\n');
}
