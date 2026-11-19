// Provider-facing choice protocol for harness runs.
//
// A provider chat can choose a project and a session before it sends a task.
// This module owns the `$` grammar and the reply text. It stays generic: the
// relay supplies the harness mention, and a harness adapter supplies the
// session list. A future provider or harness pair can reuse the same protocol.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CHOICES_HEADER, startsWithChoicesHeader } from '../../shared/choices.js';
import { stripVendorLabel } from '../../shared/vendor-label.js';
import type { HarnessSession } from './types.js';

export { CHOICES_HEADER };
export const FIND_PROJECT_TOKEN = 'find-project';
export const PROJECT_CHOICE_LIMIT = 40;
export const SESSION_CHOICE_LIMIT = 40;
const TOKEN_LIMIT = 80;
const TITLE_LIMIT = 80;
const REASON_LIMIT = 200;
const SESSION_ID = /^[A-Za-z0-9._-]{1,100}$/;

/** One project as the provider sees it. */
export interface CommandProject {
  /** Absolute project path. */
  path: string;
  /** Token after `$`, without the dollar sign. */
  token: string;
}

export type ParsedCommand =
  | { kind: 'projects' }
  | { kind: 'sessions'; project: CommandProject }
  | { kind: 'run-session'; project: CommandProject; sessionId: string; task: string }
  | { kind: 'run-new'; project: CommandProject; task: string }
  | { kind: 'find-projects' }
  | { kind: 'find-run'; task: string }
  | { kind: 'routing'; task: string }
  | { kind: 'help'; reason: string; project?: CommandProject };

export interface ChoiceOptions {
  /** Harness trigger, for example `@opencode`. */
  mention: string;
  /** Harness display name, for example `OpenCode`. */
  harnessName: string;
}

/** True when the text is a choice reply or an echo of one. */
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

function isReserved(token: string): boolean {
  return token === FIND_PROJECT_TOKEN
    || token === 'sessions'
    || token.endsWith('-new')
    || token.includes('-ses_');
}

/**
 * Turn project paths into unique `$` tokens. The basename is the token. A
 * duplicate basename or a reserved token gets a short stable path suffix.
 */
export function buildProjectChoices(paths: string[], limit = PROJECT_CHOICE_LIMIT): CommandProject[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    unique.push(resolved);
    if (unique.length >= limit) break;
  }
  const base = unique.map((dir) => baseToken(path.basename(dir)));
  const counts = new Map<string, number>();
  for (const token of base) counts.set(token, (counts.get(token) ?? 0) + 1);
  const used = new Set<string>();
  return unique.map((dir, index) => {
    let token = base[index];
    if ((counts.get(token) ?? 0) > 1 || isReserved(token)) token = `${token}-${hashToken(dir)}`;
    if (used.has(token)) token = `${token}-${index + 1}`;
    used.add(token);
    return { path: dir, token };
  });
}

/**
 * Parse the text behind one harness mention. A bare mention asks for the
 * project list. A `$` token chooses a project or session. Any other text is a
 * task for the existing routing fallback.
 */
export function parseCommandBody(body: string, projects: CommandProject[]): ParsedCommand {
  const trimmed = body.trim();
  if (!trimmed) return { kind: 'projects' };
  if (!trimmed.startsWith('$')) return { kind: 'routing', task: trimmed };
  const match = /^\$(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { kind: 'help', reason: 'A choice must start with $.' };
  const token = match[1].toLowerCase();
  const task = (match[2] ?? '').trim();
  if (token.length > 200) return { kind: 'help', reason: 'The choice is too long.' };
  if (token === 'sessions') {
    const projectToken = task.replace(/^\$/, '').trim().toLowerCase();
    if (!projectToken) return { kind: 'help', reason: 'Add a project after $sessions.' };
    const project = projects.find((entry) => entry.token === projectToken);
    if (!project) return { kind: 'help', reason: `Unknown project $${projectToken}.` };
    return { kind: 'sessions', project };
  }
  if (token === FIND_PROJECT_TOKEN) {
    return task ? { kind: 'find-run', task } : { kind: 'find-projects' };
  }
  const exact = projects.find((project) => project.token === token);
  if (exact) {
    if (task) return { kind: 'help', reason: `Add a session choice after $${token}.`, project: exact };
    return { kind: 'sessions', project: exact };
  }
  if (token.endsWith('-new')) {
    const projectToken = token.slice(0, -4);
    const project = projects.find((entry) => entry.token === projectToken);
    if (project) {
      if (!task) return { kind: 'help', reason: `Add a task after $${token}.`, project };
      return { kind: 'run-new', project, task };
    }
  }
  const byLength = [...projects].sort((a, b) => b.token.length - a.token.length);
  for (const project of byLength) {
    const prefix = `${project.token}-`;
    if (!token.startsWith(prefix)) continue;
    const sessionId = token.slice(prefix.length);
    if (!sessionId || sessionId === 'new' || !SESSION_ID.test(sessionId)) continue;
    if (!task) return { kind: 'help', reason: `Add a task after $${token}.`, project };
    return { kind: 'run-session', project, sessionId, task };
  }
  return { kind: 'help', reason: `Unknown choice $${token}.` };
}

function cleanTitle(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT);
}

function relativeTime(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function projectLines(projects: CommandProject[]): string[] {
  return projects.map((project) => `- $${project.token}`);
}

/** The project list reply. The provider reads the tokens and sends one back. */
export function formatProjectChoices(
  projects: CommandProject[],
  options: ChoiceOptions & { title?: string; note?: string },
): string {
  const lines = [CHOICES_HEADER, '', options.title ?? `${options.harnessName} projects:`];
  if (!projects.length) {
    lines.push('No projects are available.');
    lines.push(`Reply with ${options.mention} $find-project to search your home folder.`);
    return lines.join('\n');
  }
  lines.push(...projectLines(projects));
  if (options.note) lines.push('', options.note);
  lines.push('');
  lines.push(`Reply with ${options.mention} $sessions $<project> to list its sessions before you start a new one.`);
  lines.push(`Reply with ${options.mention} $find-project to search your home folder.`);
  return lines.join('\n');
}

/** The project list reply for a home-folder search. */
export function formatFoundChoices(
  projects: CommandProject[],
  options: ChoiceOptions & { note?: string },
): string {
  return formatProjectChoices(projects, {
    ...options,
    title: 'Projects found in your home folder:',
    note: options.note ?? 'These projects come from the home-folder search.',
  });
}

/** The reply when a home-folder search returns nothing. */
export function formatNoFoundProjects(options: ChoiceOptions): string {
  return [
    CHOICES_HEADER,
    '',
    'No projects were found in your home folder.',
    '',
    `Reply with ${options.mention} to list the configured projects.`,
  ].join('\n');
}

/** The session list reply for one project. */
export function formatSessionChoices(
  project: CommandProject,
  sessions: HarnessSession[],
  options: ChoiceOptions & { note?: string },
): string {
  const lines = [CHOICES_HEADER, '', `Sessions for $${project.token}:`];
  const usable = sessions.filter((session) => SESSION_ID.test(session.id));
  const listed = usable.slice(0, SESSION_CHOICE_LIMIT);
  if (!listed.length) {
    lines.push('No sessions yet.');
  } else {
    for (const session of listed) {
      const title = cleanTitle(session.title);
      const updated = relativeTime(session.updated);
      const suffix = [title, updated].filter(Boolean).join(' — ');
      lines.push(`- $${project.token}-${session.id}${suffix ? ` — ${suffix}` : ''}`);
    }
  }
  if (usable.length > listed.length) lines.push(`Showing ${listed.length} of ${usable.length} sessions.`);
  if (options.note) lines.push('', options.note);
  lines.push('');
  lines.push('Prefer an existing session when the task continues earlier work.');
  lines.push(`Reply with ${options.mention} $${project.token}-<sessionid> <task> to continue a session.`);
  lines.push(`Reply with ${options.mention} $${project.token}-new <task> to start a new session.`);
  return lines.join('\n');
}

/** The reply when the live session list fails but a stored session exists. */
export function formatSessionNote(note: string): string {
  return note.slice(0, REASON_LIMIT);
}

/** A short command help reply. The text never asks for a plain task. */
export function formatHelp(reason: string, options: ChoiceOptions): string {
  return [
    CHOICES_HEADER,
    '',
    reason.slice(0, REASON_LIMIT),
    '',
    `Reply with ${options.mention} to list projects.`,
    `Reply with ${options.mention} $sessions $<project> to list sessions.`,
    `Reply with ${options.mention} $<project>-<sessionid> <task> to continue a session.`,
    `Reply with ${options.mention} $<project>-new <task> to start a session.`,
    `Reply with ${options.mention} $find-project <task> to search your home folder.`,
  ].join('\n');
}
