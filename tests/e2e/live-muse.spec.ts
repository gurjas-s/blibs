// Opt-in checks for Muse harnesses using an existing signed-in profile.
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
    const state = JSON.parse(readFileSync(LIVE_STATE, 'utf8')) as { model?: unknown; modelDefaults?: { opencode?: unknown } };
    const model = state.modelDefaults ? state.modelDefaults.opencode
      : state.model === 'opencode-go/beam-free' ? undefined : state.model;
    if (typeof model === 'string' && model) return model;
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
const projectChecks = [
  ['opencode', 'OpenCode', false],
  ['opencode', 'OpenCode', true],
  ['claude-code', 'Claude Code', false],
  ['claude-code', 'Claude Code', true],
] as const;
for (const [harnessId, harnessName, createProject] of projectChecks) test(
  `live Muse uses ${harnessName} to ${createProject ? 'create a project and write a file' : 'write a file in a project'}`,
  { skip: relaySkipReason() || (harnessId === 'claude-code' && !process.env.BLIBS_LIVE_CLAUDE_CODE_MODEL?.trim()
    ? 'Set BLIBS_LIVE_CLAUDE_CODE_MODEL to run the Claude Code check.' : false) },
  async (t) => {
    const projectsDir = mkdtempSync(path.join(os.tmpdir(), 'blibs-live-projects-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    const beta = path.join(projectsDir, 'beta');
    if (!createProject) {
      mkdirSync(alpha);
      mkdirSync(beta);
    }
    const model = harnessId === 'claude-code'
      ? process.env.BLIBS_LIVE_CLAUDE_CODE_MODEL?.trim() : liveRelayModel();
    const app = await launch({ mockLogin: false, profileDir: LIVE_PROFILE, relayCommand: null, projectsDir });
    try {
      await completeOnboarding(app.page);
      if (model) {
        const configured = await fetch(app.backendUrl + '/api/relay/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ harnessId, model }),
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
      {
        const introduction = website.getByRole('log').getByText(
          harnessId === 'claude-code' ? /@claude-code.*Session names are specific/ : '@opencode /new $<project>',
          { exact: false },
        );
        const introductions = await introduction.count();
        await sendFromPane(website, composer, '@blibs');
        await introduction.nth(introductions).waitFor({ timeout: 45_000 });
      }
      if (createProject) {
        const existingIds = new Set((await outboxItems(app)).map(({ id }) => id));
        await sendFromPane(website, composer, 'Ask blibs to create a new project named alpha.');
        await waitForOutbox(app, (item) => !existingIds.has(item.id)
          && item.threadId === website.url() && item.text.includes('Project created. Project ID: $alpha.')
          && item.status === 'sent', 90_000);
      }
      const log = website.locator('[role="log"]');
      const header = `Sent from user's harness (${harnessName}).`;
      const replies = log.getByText(header, { exact: false });
      const replyCount = await replies.count();
      const existingIds = new Set((await outboxItems(app)).map((item) => item.id));
      const content = 'blibs-test-' + randomUUID();
      const sessionName = 'write-' + randomUUID().slice(0, 8);
      await sendFromPane(
        website,
        composer,
        `Use my local ${harnessName} harness in alpha. Start a clean session named ${sessionName} and create hello.txt. ` +
        `${harnessId === 'claude-code' ? 'Use the Write tool. ' : ''}` +
        `Write exactly ${content} to hello.txt with no trailing newline. Leave all other files and projects untouched.`,
      );

      const threadId = website.url();
      await waitFor(`Muse to issue a ${harnessName} task for the test file`, async () => {
        const response = await fetch(app.backendUrl + '/api/imports');
        assert.equal(response.status, 200);
        const { imports } = await response.json() as {
          imports: Array<{ provider: string; role: string; threadId: string; text: string }>;
        };
        return imports.find((item) => item.provider === 'muse' && item.role === 'agent'
          && item.threadId === threadId && !isUserEcho(item.text)
          && extractMentionTask(item.text, `@${harnessId}`)?.toLowerCase().startsWith(`/new $alpha ${sessionName} `)
          && item.text.includes('hello.txt') && item.text.includes(content));
      }, 180_000);
      const notice = await waitForOutbox(app, (item) => !existingIds.has(item.id)
        && item.threadId === threadId && item.text.endsWith(`Active session for $alpha: ${sessionName}.`)
        && item.status === 'sent', 180_000);
      const reply = await waitForOutbox(app, (item) => !existingIds.has(item.id)
        && item.ts >= notice.ts && item.threadId === threadId && item.text.startsWith(header) && item.status === 'sent', 300_000);
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

for (const [harnessId, harnessName] of [['opencode', 'OpenCode'], ['codex', 'Codex'], ['claude-code', 'Claude Code']]) {
  const claudeModel = process.env.BLIBS_LIVE_CLAUDE_CODE_MODEL?.trim();
  const skip = relaySkipReason() || (harnessId === 'claude-code' && !claudeModel
    ? 'Set BLIBS_LIVE_CLAUDE_CODE_MODEL to run the Claude Code check.' : false);
  test(`live Muse starts and resumes ${harnessName} named sessions from the composer`, { skip }, async (t) => {
    const mention = `@${harnessId}`;
    const header = `Sent from user's harness (${harnessName}).`;
    const modelOverride = harnessId === 'claude-code' ? claudeModel
      : harnessId === 'codex' ? process.env.BLIBS_LIVE_CODEX_MODEL?.trim() : process.env.BLIBS_LIVE_MODEL?.trim();
    const projectsDir = mkdtempSync(path.join(os.tmpdir(), 'blibs-live-sessions-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    mkdirSync(alpha);
    const app = await launch({ mockLogin: false, profileDir: LIVE_PROFILE, relayCommand: null, projectsDir });
    try {
      await completeOnboarding(app.page);
      const model = harnessId === 'opencode' ? liveRelayModel() : modelOverride;
      if (model) {
        const configured = await fetch(app.backendUrl + '/api/relay/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ harnessId, model }),
        });
        assert.equal(configured.status, 200);
      }
      const website = await waitFor('the signed-in Muse view', async () =>
        app.context.pages().find((page) => new URL(page.url()).origin === 'https://muse.ai'), 30_000);
      const composer = website.locator('textarea[aria-label="Message"], div[contenteditable="true"]').first();
      const log = website.getByRole('log');
      const introduction = log.getByText(harnessId === 'opencode' ? '@opencode /new $<project>'
        : new RegExp(mention + '.*Session names are specific'), { exact: false });
      const introductions = await introduction.count();
      await sendFromPane(website, composer, '@blibs');
      await introduction.nth(introductions).waitFor({ timeout: 45_000 });

      const write = async (request: string, command: string, name: string, file: string, runModel?: string): Promise<void> => {
        const content = 'blibs-test-' + randomUUID();
        const marker = 'done-' + randomUUID();
        const existingIds = new Set((await outboxItems(app)).map(({ id }) => id));
        const modelOption = runModel ? `--model ${runModel} ` : '';
        const toolInstruction = harnessId === 'claude-code' ? 'Use the Write tool. ' : '';
        const task = `${toolInstruction}Write exactly ${content} to ${file} with no trailing newline. Reply with ${marker} after writing the file. Leave other files untouched.`;
        await sendFromPane(website, composer, request +
          ` Send this exact command as your own message: ${mention} ${command} $alpha ${name} ${modelOption}${task}`);
        const fresh = (item: { id: string; threadId?: string; status: string }): boolean =>
          !existingIds.has(item.id) && item.threadId === website.url() && item.status === 'sent';
        await waitForOutbox(app, (item) =>
          fresh(item) && item.text.endsWith(`Active session for $alpha: ${name}.`), 180_000);
        const result = await waitForOutbox(app, (item) => fresh(item)
          && ((item.text.startsWith(header) && item.text.includes(marker)) || item.text.startsWith(`The ${harnessName} harness failed:`)), 300_000);
        await waitFor('Muse to use the session name in its command', async () => {
          const response = await fetch(app.backendUrl + '/api/imports');
          assert.equal(response.status, 200);
          const { imports } = await response.json() as {
            imports: Array<{ provider: string; role: string; threadId: string; text: string }>;
          };
          return imports.find((item) => {
            if (item.provider !== 'muse' || item.role !== 'agent' || item.threadId !== website.url() || isUserEcho(item.text)) return false;
            const task = extractMentionTask(item.text, mention);
            const prefix = `${command} $alpha ${name} `;
            return task?.toLowerCase().startsWith(prefix) && task.slice(prefix.length).startsWith(modelOption)
              && task.includes(content) && task.includes(marker);
          });
        }, 30_000);
        assert.ok(result.text.startsWith(header), `${harnessName} reported a harness failure.`);
        assert.deepEqual(readFileSync(path.join(alpha, file)), Buffer.from(content));
      };

      if (harnessId === 'claude-code' && claudeModel) {
        const baselineIds = new Set((await outboxItems(app)).map(({ id }) => id));
        const unavailable = 'That session is unavailable for this chat and project.';
        await sendFromPane(website, composer,
          `Send this exact command as your own message: ${mention} /resume $alpha missing Follow up.`);
        await waitForOutbox(app, (item) => !baselineIds.has(item.id)
          && item.threadId === website.url() && item.text.includes(unavailable) && item.status === 'sent', 60_000);

        const correctionIds = new Set((await outboxItems(app)).map(({ id }) => id));
        const wrongModel = claudeModel.length > 1 ? claudeModel.slice(0, -1) : claudeModel + '-typo';
        const retryName = 'retry-' + randomUUID().slice(0, 8);
        const retryContent = 'blibs-test-' + randomUUID();
        const retryMarker = 'done-' + randomUUID();
        const retryTask = `Use the Write tool. Write exactly ${retryContent} to model-retry.txt with no trailing newline. ` +
          `Reply with ${retryMarker} after writing the file. Leave other files untouched.`;
        await sendFromPane(website, composer,
          `Ask Muse to send this exact command as its own message, then retry with the exact model ID from blibs' choices and the same task. ` +
          `${mention} /new $alpha ${retryName} --model ${wrongModel} ${retryTask}`);
        const choices = await waitForOutbox(app, (item) => !correctionIds.has(item.id)
          && item.threadId === website.url() && item.text.includes('Closest available model IDs:')
          && item.text.split('\n').includes(`- ${claudeModel}`) && item.status === 'sent', 180_000);

        const correctedTask = `--model ${claudeModel} ${retryTask}`;
        await waitFor('Muse to retry with the exact available model ID', async () => {
          const response = await fetch(app.backendUrl + '/api/imports');
          assert.equal(response.status, 200);
          const { imports } = await response.json() as {
            imports: Array<{ provider: string; role: string; threadId: string; text: string }>;
          };
          return imports.find((item) => item.provider === 'muse' && item.role === 'agent'
            && item.threadId === website.url() && !isUserEcho(item.text)
            && extractMentionTask(item.text, mention)?.toLowerCase()
              .startsWith(`/new $alpha ${retryName} ${correctedTask}`.toLowerCase()));
        }, 240_000);
        const notice = await waitForOutbox(app, (item) => !correctionIds.has(item.id)
          && item.threadId === website.url() && item.text.endsWith(`Active session for $alpha: ${retryName}.`)
          && item.status === 'sent', 180_000);
        assert.ok(notice.ts >= choices.ts, 'The relay must offer model choices before starting the session.');
        const result = await waitForOutbox(app, (item) => !correctionIds.has(item.id)
          && item.ts >= notice.ts && item.threadId === website.url()
          && item.text.startsWith(header) && item.text.includes(retryMarker) && item.status === 'sent', 300_000);
        assert.deepEqual(readFileSync(path.join(alpha, 'model-retry.txt')), Buffer.from(retryContent));
        await log.getByText(result.text, { exact: false }).last().waitFor({ timeout: 30_000 });
      }

      const suffix = randomUUID().slice(0, 8);
      const first = 'draft-' + suffix;
      const second = 'review-' + suffix;
      await write(`Use my local ${harnessName} harness to start a clean session named ${first} in alpha.`, '/new', first, 'first.txt', modelOverride);
      await write(`Use my local ${harnessName} harness to start a clean session named ${second} in alpha.`, '/new', second, 'second.txt');
      const secondFile = readFileSync(path.join(alpha, 'second.txt'));
      await write(`Use my local ${harnessName} harness to continue the same session that created first.txt in alpha.`, '/resume', first, 'first.txt');
      assert.deepEqual(readFileSync(path.join(alpha, 'second.txt')), secondFile);
    } finally {
      await app.close();
    }
  });
}
