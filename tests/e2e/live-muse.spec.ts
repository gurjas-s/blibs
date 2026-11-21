// Opt-in check for Muse and OpenCode using an existing signed-in profile.
// Run with BLIBS_LIVE_LOGIN=1 npm run e2e:live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { extractMentionTask, isUserEcho } from '../../server/harness/mention.ts';
import {
  completeOnboarding,
  displayAvailable,
  launch,
  NO_DISPLAY_MESSAGE,
  type E2EApp,
} from './harness.ts';

const LIVE_ENV = 'BLIBS_LIVE_LOGIN';
const LIVE_HEADER = "Sent from user's harness (OpenCode).";

/** True when the checks have the opt-in flag and a display. */
function baseSkipReason(): string | false {
  if (process.env[LIVE_ENV] !== '1') {
    return `Set ${LIVE_ENV}=1 to run the live check.`;
  }
  if (!displayAvailable()) return NO_DISPLAY_MESSAGE;
  return false;
}

/** Electron user-data directory for the installed app. The live profile holds the Muse session. */
function defaultUserDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'blibs');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'blibs');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'blibs');
}

const LIVE_PROFILE = process.env.BLIBS_LIVE_PROFILE?.trim() || defaultUserDataDir();
const LIVE_STATE = path.join(LIVE_PROFILE, 'history', 'relay-state.json');

function relaySkipReason(): string | false {
  const base = baseSkipReason();
  if (base) return base;
  if (!existsSync(LIVE_PROFILE)) {
    return `The live profile is missing at ${LIVE_PROFILE}. Start the app and sign in to Muse once.`;
  }
  return false;
}

function liveRelayModel(): string | undefined {
  const override = process.env.BLIBS_LIVE_MODEL?.trim();
  if (override) return override;
  try {
    const state = JSON.parse(readFileSync(LIVE_STATE, 'utf8')) as { model?: unknown };
    if (typeof state.model === 'string' && state.model) return state.model;
  } catch { /* use the default model */ }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  label: string,
  read: () => Promise<T | undefined>,
  timeoutMs: number,
  interval = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms: ${label}`);
    await sleep(interval);
  }
}

async function outboxItems(app: E2EApp): Promise<Array<{ id: string; ts: number; status: string; text: string; threadId?: string }>> {
  const data = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
    items?: Array<{ id: string; ts: number; status: string; text: string; threadId?: string }>;
  };
  return data.items ?? [];
}

async function waitForOutbox(
  app: E2EApp,
  predicate: (item: { id: string; ts: number; status: string; text: string; threadId?: string }) => boolean,
  timeoutMs: number,
): Promise<{ id: string; ts: number; status: string; text: string; threadId?: string }> {
  return waitFor(
    'an outbox item',
    async () => (await outboxItems(app)).find(predicate),
    timeoutMs,
    2_000,
  );
}

/** Type into the Muse composer and use its Send button when it is present. */
async function sendFromPane(
  website: Page,
  composer: ReturnType<Page['locator']>,
  text: string,
): Promise<void> {
  await composer.fill(text);
  const send = website.getByRole('button', { name: 'Send', exact: true });
  if (await send.isVisible()) await send.click();
  else await composer.press('Enter');
  await website.getByRole('log').getByText(text, { exact: false }).last().waitFor({ timeout: 30_000 });
}

const creationChat = process.env.BLIBS_LIVE_CREATION_CHAT?.trim();
for (const createProject of [false, true]) test(
  createProject
    ? 'live Muse creates a project and writes a file from the composer'
    : 'live Muse creates a file in the requested project from the composer',
  { skip: relaySkipReason() },
  async (t) => {
    const projectsDir = mkdtempSync(path.join(os.tmpdir(), 'blibs-live-projects-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    const beta = path.join(projectsDir, 'beta');
    if (!createProject) {
      mkdirSync(alpha);
      mkdirSync(beta);
    }
    const model = liveRelayModel();
    const app = await launch({ mockLogin: false, profileDir: LIVE_PROFILE, relayCommand: null, projectsDir });
    try {
      await completeOnboarding(app.page);
      if (model) {
        const configured = await fetch(app.backendUrl + '/api/relay/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        assert.equal(configured.status, 200);
      }

      const website = await waitFor('the signed-in Muse view', async () =>
        app.context.pages().find((page) => new URL(page.url()).origin === 'https://muse.ai'), 30_000);
      const composer = website.locator('textarea[aria-label="Message"], div[contenteditable="true"]').first();
      if (createProject && creationChat) {
        const target = new URL(creationChat);
        assert.equal(target.origin, 'https://muse.ai');
        await website.goto(target.href);
        assert.equal(website.url(), target.href);
      }
      await composer.waitFor();
      if (createProject) {
        const introduction = website.getByRole('log').getByText('@opencode /new-project', { exact: false });
        const introductions = await introduction.count();
        await sendFromPane(website, composer, '@blibs');
        await introduction.nth(introductions).waitFor({ timeout: 45_000 });
      }
      const log = website.locator('[role="log"]');
      const replies = log.getByText(LIVE_HEADER, { exact: false });
      const replyCount = await replies.count();
      const existingIds = new Set((await outboxItems(app)).map((item) => item.id));
      const content = 'blibs-test-' + randomUUID();
      await sendFromPane(
        website,
        composer,
        (createProject
          ? 'Ask blibs to create a new project named alpha, then use my local OpenCode harness to create hello.txt in it. '
          : 'Use my local OpenCode harness to create hello.txt in the project named alpha. ') +
        'Write exactly ' + content + ' with no trailing newline. Leave all other files and projects untouched.',
      );

      const threadId = website.url();
      await waitFor('Muse to issue an OpenCode task for the test file', async () => {
        const response = await fetch(app.backendUrl + '/api/imports');
        assert.equal(response.status, 200);
        const { imports } = await response.json() as {
          imports: Array<{ provider: string; role: string; threadId: string; text: string }>;
        };
        return imports.find((item) => item.provider === 'muse' && item.role === 'agent'
          && item.threadId === threadId && !isUserEcho(item.text)
          && extractMentionTask(item.text)?.includes(content));
      }, 180_000);
      if (createProject) {
        await waitForOutbox(app, (item) => !existingIds.has(item.id)
          && item.threadId === threadId && item.text.includes('Project created. Project ID: $alpha.')
          && item.status === 'sent', 180_000);
      }
      const reply = await waitForOutbox(app, (item) => !existingIds.has(item.id)
        && item.threadId === threadId && item.text.startsWith(LIVE_HEADER) && item.status === 'sent', 300_000);
      await waitFor('the harness reply to appear in the Muse conversation', async () => {
        return (await replies.count()) > replyCount && await log.getByText(reply.text, { exact: false }).last()
          .isVisible().catch(() => false) ? true : undefined;
      }, 30_000);
      assert.deepEqual(readFileSync(path.join(alpha, 'hello.txt')), Buffer.from(content));
      if (createProject) assert.deepEqual(readdirSync(projectsDir), ['alpha']);
      else assert.deepEqual(readdirSync(beta), []);
    } finally {
      await app.close();
    }
  },
);
