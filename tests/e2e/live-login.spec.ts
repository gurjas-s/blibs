// Live vendor checks.
//
// These checks use a real Muse account. They are opt-in and never run in CI.
// Set BLIBS_LIVE_LOGIN=1 and, for the sign-in check, put the account values in
// the ignored .env file. The checks read the values at runtime and write none
// of them to a log, a screenshot, or the repository.
//
// Run them with:
//   BLIBS_LIVE_LOGIN=1 npm run e2e:live
//
// The checks:
// 1. Sign in to Proton with the same mailbox that receives the Muse code.
// 2. Open the Muse sign-in window and submit the account email.
// 3. Read the newest Meta code from the Proton inbox and submit it.
// 4. Send @blibs from the panel and check the generated introduction.
// 5. Import a provider @opencode hi and check the harness reply header.
// 6. Ask Muse to create a file in a temporary project through OpenCode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
import { extractMentionTask, isUserEcho } from '../../server/harness/mention.ts';
import {
  ARTIFACT_DIR,
  completeOnboarding,
  displayAvailable,
  launch,
  NO_DISPLAY_MESSAGE,
  selectAgent,
  type E2EApp,
} from './harness.ts';

const LIVE_ENV = 'BLIBS_LIVE_LOGIN';
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PATH = process.env.BLIBS_CHROME_PATH || DEFAULT_CHROME;
const ENV_FILE = path.join(import.meta.dirname, '..', '..', '.env');
const LIVE_HEADER = "Sent from user's harness (OpenCode).";

interface LiveCredentials {
  email: string;
  password: string;
}

function readEnvValue(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return (match?.[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
}

function liveCredentials(): LiveCredentials | null {
  try {
    const text = readFileSync(ENV_FILE, 'utf8');
    const email = readEnvValue(text, 'EMAIL_MUSE');
    const password = readEnvValue(text, 'PASSWORD_MUSE');
    if (!email || !password) return null;
    return { email, password };
  } catch {
    return null;
  }
}

/** True when the checks have the opt-in flag and a display. */
function baseSkipReason(): string | false {
  if (process.env[LIVE_ENV] !== '1') {
    return `Set ${LIVE_ENV}=1 to run the live check.`;
  }
  if (!displayAvailable()) return NO_DISPLAY_MESSAGE;
  return false;
}

function signInSkipReason(): string | false {
  const base = baseSkipReason();
  if (base) return base;
  if (!existsSync(CHROME_PATH)) {
    return `Chrome is not installed at ${CHROME_PATH}. Set BLIBS_CHROME_PATH to its executable.`;
  }
  if (!liveCredentials()) {
    return 'The live sign-in check needs EMAIL_MUSE and PASSWORD_MUSE in .env.';
  }
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

/** Sign in to the Proton inbox that receives the Muse code. */
async function openInbox(context: BrowserContext, credentials: LiveCredentials): Promise<Page> {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://mail.proton.me/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('input[autocomplete="username"], input[type="email"]').first()
    .fill(credentials.email);
  await page.getByRole('button', { name: /^(Continue|Next)$/ }).first().click();
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 30_000 });
  await password.fill(credentials.password);
  await page.getByRole('button', { name: /^Sign in$/ }).first().click();
  await page.waitForURL(/mail\.proton\.me/, { timeout: 60_000 });
  await page.locator('body').waitFor({ state: 'visible' });
  await sleep(4_000);
  return page;
}

/** True when a clock label from the inbox is recent enough to be a fresh code. */
function isRecentClock(label: string, maxAgeMs = 5 * 60_000): boolean {
  const match = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(label);
  if (!match) return false;
  let hour = Number(match[1]) % 12;
  if (/pm/i.test(match[3])) hour += 12;
  const date = new Date();
  date.setHours(hour, Number(match[2]), 0, 0);
  const now = Date.now();
  if (date.getTime() > now + 5 * 60_000) date.setDate(date.getDate() - 1);
  return now - date.getTime() <= maxAgeMs;
}

/** Snapshot of the first Meta conversation, used to detect the new email. */
async function metaSignature(inbox: Page): Promise<string> {
  await inbox.goto('https://mail.proton.me/u/1/inbox#category=primary', { waitUntil: 'domcontentloaded' });
  await sleep(3_000);
  const body = await inbox.locator('body').innerText().catch(() => '');
  const index = body.search(/Use code \d{6} to log in/i);
  return index >= 0 ? body.slice(index, index + 240) : '';
}

/**
 * Read the newest Meta login code from the inbox. A new sign-in request
 * invalidates an older code, so the check waits for the email that follows
 * the request instead of reusing an old one.
 */
async function latestMetaCode(inbox: Page, previous: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await inbox.goto('https://mail.proton.me/u/1/inbox#category=primary', { waitUntil: 'domcontentloaded' });
    await sleep(4_000);
    const body = await inbox.locator('body').innerText().catch(() => '');
    const index = body.search(/Use code \d{6} to log in/i);
    const block = index >= 0 ? body.slice(index, index + 400) : '';
    const snippetCode = /Use code\s+(\d{6})/i.exec(block)?.[1];
    const clock = /(\d{1,2}:\d{2}\s*(?:AM|PM))/i.exec(block)?.[1];
    const fresh = Boolean(clock && isRecentClock(clock));
    const newer = previous === '' || block !== previous;
    if (snippetCode && fresh && newer) {
      const snippet = inbox.getByText(/Use code \d{6} to log in/).first();
      await snippet.click();
      await sleep(4_000);
      for (const frame of inbox.frames()) {
        const text = await frame.locator('body').innerText().catch(() => '');
        const match = text.match(/Login code\s*(\d{6})/i);
        if (match) return match[1];
      }
      return snippetCode;
    }
    await sleep(3_000);
  }
  throw new Error('The Proton inbox has no fresh Meta login code. Request a new code and try again.');
}

/** Fill the Muse email step and wait for the code step. */
async function submitMuseEmail(page: Page, email: string): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(2_000);
  await page.getByLabel('Mobile number or email').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('6-digit security code').waitFor({ state: 'visible', timeout: 30_000 });
}

/** Submit the latest code. Muse can auto-submit when the field reaches six digits. */
async function submitMuseCode(page: Page, code: string): Promise<void> {
  const field = page.getByLabel('6-digit security code');
  await field.focus();
  await page.keyboard.type(code, { delay: 120 });
  await sleep(2_000);
  const remember = page.locator('input[type="checkbox"]').first();
  if (await remember.isVisible().catch(() => false)) await remember.check().catch(() => undefined);
  const next = page.getByRole('button', { name: 'Next', exact: true });
  if (await next.isVisible().catch(() => false)) {
    await next.click({ timeout: 5_000 }).catch(() => undefined);
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await page.locator('div[contenteditable="true"], textarea, [role="textbox"]').count() > 0) return;
    if (await page.getByText(/incorrect or has expired/i).isVisible().catch(() => false)) {
      throw new Error('Muse rejected the email code. Request a new code after the old code expires.');
    }
    await sleep(1_000);
  }
  throw new Error('The Muse sign-in window did not show the chat after the code step.');
}

/** Poll the panel until the main process reports the Muse session. */
async function waitForSignedIn(page: Page): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const signed = page.getByText(/Signed in to Muse/);
    if (await signed.isVisible().catch(() => false)) return;
    const check = page.getByRole('button', { name: 'Check Muse sign-in again' });
    if (await check.isVisible().catch(() => false)) await check.click().catch(() => undefined);
    await sleep(5_000);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
    await page.getByRole('button', { name: 'Agents', exact: true }).click().catch(() => undefined);
  }
  throw new Error('The panel did not report the Muse sign-in.');
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

/** Open the Muse sign-in window, which is also the visible chat popout. */
async function openMusePopout(app: E2EApp): Promise<{ popout: Page; composer: ReturnType<Page['locator']> }> {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click();
  const pages = () => app.browser.contexts().flatMap((context) => context.pages());
  const before = new Set(pages());
  await app.page.getByRole('button', { name: 'Sign in to Muse' }).click();
  const popout = await waitFor(
    'the Muse popout window',
    async () => pages().find(
      (candidate) => !before.has(candidate) && candidate.url().includes('muse.ai'),
    ),
    30_000,
    500,
  );
  await popout.bringToFront();
  const composer = popout.locator('textarea[aria-label="Message"], div[contenteditable="true"]').first();
  await waitFor(
    'the Muse composer. Sign in to Muse in the app once, then retry.',
    async () => (await composer.isVisible().catch(() => false) ? true : undefined),
    60_000,
    1_000,
  );
  return { popout, composer };
}

/** Type into the Muse composer and use its Send button when it is present. */
async function sendPopout(
  popout: Page,
  composer: ReturnType<Page['locator']>,
  text: string,
): Promise<void> {
  await composer.fill(text);
  const send = popout.getByRole('button', { name: 'Send', exact: true });
  if (await send.isVisible()) await send.click();
  else await composer.press('Enter');
  await popout.getByRole('log').getByText(text, { exact: false }).last().waitFor({ timeout: 30_000 });
}


test(
  'live Muse sign-in with an email code and the @blibs introduction',
  { skip: signInSkipReason() },
  async () => {
    const credentials = liveCredentials();
    assert.ok(credentials, 'The account values must be present.');
    const protonContext = await chromium.launchPersistentContext(
      mkdtempSync(path.join(tmpdir(), 'blibs-live-proton-')),
      { headless: false, executablePath: CHROME_PATH },
    );
    const inbox = await openInbox(protonContext, credentials);
    let app: E2EApp | undefined;
    let projectDir = '';
    let discoveryRoot = '';
    try {
      app = await launch({
        mockLogin: false,
        profileDir: path.join(ARTIFACT_DIR, 'live-profile'),
        timeoutMs: 60_000,
      });
      await completeOnboarding(app.page);
      const { page } = app;

      // Open the real sign-in window. It shares the partition of the hidden view.
      await page.getByRole('button', { name: 'Agents', exact: true }).click();
      const pagesBefore = new Set(app.context.pages());
      await page.getByRole('button', { name: 'Sign in to Muse' }).click();
      await sleep(6_000);
      const signIn = app.context.pages().find(
        (candidate) => !pagesBefore.has(candidate) && candidate.url().includes('muse.ai'),
      );
      assert.ok(signIn, 'The Muse sign-in window must open.');

      const emailField = signIn.getByLabel('Mobile number or email');
      if (await emailField.isVisible().catch(() => false)) {
        const previousMeta = await metaSignature(inbox);
        await submitMuseEmail(signIn, credentials.email);
        let code = await latestMetaCode(inbox, previousMeta);
        try {
          await submitMuseCode(signIn, code);
        } catch (error) {
          // A second request can produce a fresh code after the first one is
          // rejected. Try one resend before the check fails.
          const resend = signIn.getByRole('button', { name: /Resend code/i });
          if (!(await resend.isVisible().catch(() => false))) throw error;
          const beforeResend = await metaSignature(inbox);
          await resend.click();
          code = await latestMetaCode(inbox, beforeResend);
          await submitMuseCode(signIn, code);
        }
      } else {
        await waitFor(
          'the remembered Muse session to show the chat',
          async () => (await signIn.locator('div[contenteditable="true"], textarea, [role="textbox"]').count() > 0
            ? true
            : undefined),
          90_000,
          2_000,
        );
      }
      await waitForSignedIn(page);

      // Return to the chat shell. The sign-in window can close at any time.
      const back = page.getByRole('button', { name: 'Back to chats' });
      if (await back.isVisible().catch(() => false)) await back.click();
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });

      // Reload the hidden view so the shared session reaches the sync view.
      const hidden = app.context.pages().find(
        (candidate) => candidate !== signIn && candidate.url().includes('muse.ai'),
      );
      assert.ok(hidden, 'The hidden Muse view must exist.');
      await hidden.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await waitFor(
        'the hidden Muse view to show a composer',
        async () => (await hidden.locator('div[contenteditable="true"], textarea, [role="textbox"]').count() > 0
          ? true
          : undefined),
        90_000,
        2_000,
      );

      discoveryRoot = mkdtempSync(path.join(tmpdir(), 'blibs-live-root-'));
      projectDir = path.join(discoveryRoot, 'project-alpha');
      mkdirSync(projectDir);
      const registry = await fetch(`${app.backendUrl}/api/relay/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoveryRoot }),
      });
      assert.equal(registry.status, 200);

      // The first scrape of the reloaded view is baseline for the relay. Wait
      // for the relay to see the thread before the test sends a mention.
      await waitFor(
        'the relay to observe the open conversation',
        async () => {
          const status = (await (await fetch(`${app.backendUrl}/api/relay`)).json()) as { processed?: number };
          return (status.processed ?? 0) > 0 ? true : undefined;
        },
        60_000,
        2_000,
      );

      await selectAgent(page, 'Muse');
      const composer = page.getByLabel('Message Muse');
      await waitFor(
        'the Muse composer to enable after sign-in',
        async () => (await composer.isEnabled() ? true : undefined),
        30_000,
        1_000,
      );

      // The panel reports its harness toggles on mount. The introduction uses them.
      await waitFor(
        'the panel to report the harness toggles',
        async () => {
          const status = (await (await fetch(`${app.backendUrl}/api/relay`)).json()) as {
            harnesses?: Array<{ id: string }>;
          };
          return (status.harnesses ?? []).length >= 3 ? true : undefined;
        },
        30_000,
        1_000,
      );

      // 1. The user tags blibs. The relay writes the generated introduction.
      const introsBefore = (await (await fetch(`${app.backendUrl}/api/imports`)).json() as {
        imports?: Array<{ text?: string }>;
      }).imports?.filter((message) => message.text?.startsWith('blibs introduction')).length ?? 0;
      await composer.fill('@blibs What can you do?');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const intro = await waitFor(
        'the generated @blibs introduction',
        async () => {
          const data = (await (await fetch(`${app.backendUrl}/api/imports`)).json()) as {
            imports?: Array<{ text?: string; role?: string }>;
          };
          const intros = (data.imports ?? []).filter((row) => row.text?.startsWith('blibs introduction'));
          return intros.length > introsBefore ? intros[intros.length - 1] : undefined;
        },
        120_000,
        2_000,
      );
      assert.equal(intro.role, 'agent');
      assert.ok(intro.text?.includes('How tagging works:'), 'the reply explains the tags');
      assert.ok(intro.text?.includes('@opencode $<project> <task>'));
      assert.ok(!/project|\$<project>/i.test(intro.text ?? ''), 'the introduction omits project selection');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
      await selectAgent(page, 'Muse');
      const introBubble = page.locator('.msg', { hasText: 'blibs introduction' }).first();
      await introBubble.waitFor({ state: 'visible', timeout: 30_000 });
      await introBubble.scrollIntoViewIfNeeded();
      await sleep(400);
      assert.ok(existsSync(await app.screenshot('live-intro.png')));

      // 2. Muse tags OpenCode. The relay runs the harness and types the reply back.
      const replySentAt = Date.now();
      const providerImport = await fetch(`${app.backendUrl}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            provider: 'muse',
            role: 'agent',
            url: 'https://muse.ai/',
            sourceId: `live-signin-provider-${replySentAt.toString(36)}`,
            ts: replySentAt,
            text: '@opencode $project-alpha hi',
          }],
        }),
      });
      assert.equal(providerImport.status, 200);
      const reply = await waitFor(
        'the harness reply header',
        async () => {
          const data = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
            items?: Array<{ text?: string; ts?: number }>;
          };
          return (data.items ?? []).find(
            (item) => (item.ts ?? 0) >= replySentAt
              && item.text?.startsWith(LIVE_HEADER)
              && item.text.includes('harness reply: hi'),
          );
        },
        180_000,
        2_000,
      );
      assert.ok(reply.text?.startsWith(LIVE_HEADER), 'the header is at the top of the harness message');

      // The vendor session types the reply into the chat. The panel pulls it.
      await waitFor(
        'the harness reply to reach the panel',
        async () => {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
          await selectAgent(page, 'Muse');
          const bubble = page.getByText(LIVE_HEADER).first();
          return (await bubble.count()) > 0 ? bubble : undefined;
        },
        120_000,
        5_000,
      );
      const replyBubble = page.locator('.msg', { hasText: LIVE_HEADER }).first();
      const replyText = await replyBubble.locator('.msg-bubble p').innerText();
      assert.ok(replyText.startsWith(LIVE_HEADER), 'the header is the first line of the message');
      assert.ok(replyText.includes('harness reply: hi'));
      await replyBubble.scrollIntoViewIfNeeded();
      await sleep(400);
      assert.ok(existsSync(await app.screenshot('live-harness-reply.png')));
    } finally {
      await app?.close();
      await protonContext.close();
      if (projectDir) rmSync(projectDir, { recursive: true, force: true });
      if (discoveryRoot) rmSync(discoveryRoot, { recursive: true, force: true });
    }
  },
);


test(
  'live Muse creates a file in the requested project from the composer',
  { skip: relaySkipReason() },
  async (t) => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'blibs-live-projects-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    const beta = path.join(projectsDir, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
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

      const { popout, composer } = await openMusePopout(app);
      const log = popout.locator('[role="log"]');
      const replies = log.getByText(LIVE_HEADER, { exact: false });
      const replyCount = await replies.count();
      const existingIds = new Set((await outboxItems(app)).map((item) => item.id));
      const content = 'blibs-test-' + randomUUID();
      await sendPopout(
        popout,
        composer,
        'Use my local OpenCode harness to create hello.txt in the project named alpha. ' +
        'Write exactly ' + content + ' with no trailing newline. Leave all other files and projects untouched.',
      );

      const threadId = popout.url();
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
      const reply = await waitForOutbox(app, (item) => !existingIds.has(item.id)
        && item.threadId === threadId && item.text.startsWith(LIVE_HEADER) && item.status === 'sent', 300_000);
      await waitFor('the harness reply to appear in the Muse conversation', async () => {
        return (await replies.count()) > replyCount && await log.getByText(reply.text, { exact: false }).last()
          .isVisible().catch(() => false) ? true : undefined;
      }, 30_000);
      assert.deepEqual(readFileSync(path.join(alpha, 'hello.txt')), Buffer.from(content));
      assert.deepEqual(readdirSync(beta), []);
    } finally {
      await app.close();
    }
  },
);
