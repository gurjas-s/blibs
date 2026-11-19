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
// 5. Send @opencode hi and check the harness reply header.
// 6. Drive the authenticated popout Muse chat: /clear, @blibs, @opencode hi,
//    and one task that the router sends to a project session.
//
// The sign-in check keeps the deterministic e2e stub. The popout check uses
// OpenCode and the registered projects, so it can take a few minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
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

interface LiveRelaySettings {
  projects: string[];
  discoveryRoot: string;
  model?: string;
}

/** Registry and model from the live app state, with the documented defaults as a fallback. */
function liveRelaySettings(): LiveRelaySettings {
  const settings: LiveRelaySettings = {
    projects: [
      path.join(os.homedir(), 'Projects', 'LeetCode-Solutions'),
      path.join(os.homedir(), 'Projects', 'streaming-simulator'),
    ],
    discoveryRoot: path.join(os.homedir(), 'Projects'),
    model: process.env.BLIBS_LIVE_MODEL?.trim() || undefined,
  };
  try {
    const state = JSON.parse(readFileSync(LIVE_STATE, 'utf8')) as {
      projects?: unknown;
      discoveryRoot?: unknown;
      model?: unknown;
    };
    if (Array.isArray(state.projects) && state.projects.every((entry) => typeof entry === 'string')) {
      settings.projects = state.projects as string[];
    }
    if (typeof state.discoveryRoot === 'string' && state.discoveryRoot) settings.discoveryRoot = state.discoveryRoot;
    if (!settings.model && typeof state.model === 'string' && state.model) settings.model = state.model;
  } catch { /* fall back to the documented defaults */ }
  return settings;
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

/** Wait for one imported history row that matches a predicate. */
async function waitForImport(
  app: E2EApp,
  predicate: (item: { ts: number; text: string }) => boolean,
  timeoutMs: number,
): Promise<{ ts: number; text: string }> {
  return waitFor(
    'an imported history row',
    async () => {
      const data = (await (await fetch(`${app.backendUrl}/api/imports`)).json()) as {
        imports?: Array<{ ts: number; text: string }>;
      };
      return (data.imports ?? []).find(predicate);
    },
    timeoutMs,
    2_000,
  );
}

/** True when a vendor row is the `/clear` command, with or without a vendor label. */
function isClearImport(text: string): boolean {
  return /^\/clear\b/i.test(text.trimStart().replace(/^(?:you|user message)\s*:\s*/i, ''));
}

/** Print the relay and popout state when a live wait fails. */
async function diagnoseLive(app: E2EApp, popout: Page, label: string): Promise<void> {
  try {
    const outbox = await outboxItems(app);
    const imports = (await (await fetch(`${app.backendUrl}/api/imports`)).json()) as {
      imports?: Array<{ ts: number; text: string }>;
    };
    const status = await (await fetch(`${app.backendUrl}/api/relay`)).json();
    const log = await popout.locator('[role="log"]').innerText().catch(() => '');
    console.error(`[live] ${label} status: ${JSON.stringify(status)}`);
    console.error(`[live] ${label} outbox: ${JSON.stringify(outbox.map((item) => [item.ts, item.status, item.text.slice(0, 80)]))}`);
    console.error(`[live] ${label} imports: ${JSON.stringify((imports.imports ?? []).slice(-12).map((item) => [item.ts, item.text.slice(0, 80)]))}`);
    console.error(`[live] ${label} popout: ${JSON.stringify(log.slice(-1200))}`);
  } catch (error) {
    console.error(`[live] ${label} diagnostics failed: ${(error as Error).message}`);
  }
}

/** Open the Muse sign-in window, which is also the visible chat popout. */
async function openMusePopout(app: E2EApp): Promise<{ popout: Page; composer: ReturnType<Page['locator']> }> {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click();
  const before = new Set(app.context.pages());
  await app.page.getByRole('button', { name: 'Sign in to Muse' }).click();
  const popout = await waitFor(
    'the Muse popout window',
    async () => app.context.pages().find(
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
  verify = true,
): Promise<void> {
  const log = popout.locator('[role="log"]');
  const before = await log.getByText(text, { exact: false }).count();
  await composer.fill(text);
  await sleep(300);
  const send = popout.getByRole('button', { name: 'Send', exact: true });
  if (await send.isVisible().catch(() => false)) await send.click();
  else await composer.press('Enter');
  if (verify) {
    await waitFor(
      `the Muse log to show ${JSON.stringify(text)}`,
      async () => ((await log.getByText(text, { exact: false }).count()) > before ? true : undefined),
      30_000,
      1_000,
    );
  }
  await sleep(1_000);
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

      // One project makes the @opencode task unambiguous.
      projectDir = mkdtempSync(path.join(tmpdir(), 'blibs-live-project-'));
      discoveryRoot = mkdtempSync(path.join(tmpdir(), 'blibs-live-root-'));
      const registry = await fetch(`${app.backendUrl}/api/relay/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: [projectDir], discoveryRoot }),
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
      assert.ok(intro.text?.endsWith('To give it a try do @opencode hi.'), 'the reply ends with the first task');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
      await selectAgent(page, 'Muse');
      const introBubble = page.locator('.msg', { hasText: 'blibs introduction' }).first();
      await introBubble.waitFor({ state: 'visible', timeout: 30_000 });
      await introBubble.scrollIntoViewIfNeeded();
      await sleep(400);
      assert.ok(existsSync(await app.screenshot('live-intro.png')));

      // 2. Muse tags OpenCode. The relay runs the harness and types the reply back.
      await composer.fill('@opencode hi');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const reply = await waitFor(
        'the harness reply header',
        async () => {
          const data = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
            items?: Array<{ text?: string }>;
          };
          return (data.items ?? []).find(
            (item) => item.text?.startsWith(LIVE_HEADER) && item.text.includes('harness reply: hi'),
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
  'live popout: clear, ask blibs, ask without a project, then route one project task',
  { skip: relaySkipReason() },
  async () => {
    const settings = liveRelaySettings();
    assert.ok(settings.projects.length >= 2, 'The live check needs at least two registered projects.');
    const app = await launch({
      mockLogin: false,
      profileDir: LIVE_PROFILE,
      relayCommand: null,
      timeoutMs: 60_000,
    });
    try {
      await completeOnboarding(app.page);
      const registry = await fetch(`${app.backendUrl}/api/relay/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projects: settings.projects,
          discoveryRoot: settings.discoveryRoot,
          ...(settings.model ? { model: settings.model } : {}),
        }),
      });
      assert.equal(registry.status, 200);

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

      const { popout, composer } = await openMusePopout(app);

      // 1. Reset the Muse context. Retry until the vendor and the relay both see it.
      const initialImports = (await (await fetch(`${app.backendUrl}/api/imports`)).json()) as {
        imports?: Array<{ text: string }>;
      };
      const clearImportsBefore = (initialImports.imports ?? [])
        .filter((item) => isClearImport(item.text)).length;
      let cleared = false;
      for (let attempt = 0; attempt < 3 && !cleared; attempt++) {
        const clearSentAt = Date.now();
        const vendorClearBefore = await popout.getByText('Conversation cleared.').count();
        await sendPopout(popout, composer, '/clear', false);
        const vendorCleared = await waitFor(
          'Muse to clear the conversation',
          async () => ((await popout.getByText('Conversation cleared.').count()) > vendorClearBefore ? true : undefined),
          30_000,
          1_000,
        ).then(() => true).catch(() => false);
        if (!vendorCleared) continue;
        cleared = await waitForImport(
          app,
          (item) => item.ts >= clearSentAt && isClearImport(item.text),
          30_000,
        ).then(async () => {
          const data = (await (await fetch(`${app.backendUrl}/api/imports`)).json()) as {
            imports?: Array<{ text: string }>;
          };
          const count = (data.imports ?? []).filter((item) => isClearImport(item.text)).length;
          return count > clearImportsBefore;
        }).catch(() => false);
      }
      assert.ok(cleared, 'The relay did not observe the /clear command. Check the Muse popout and retry.');
      // Let the first popout scrape settle so old rows do not mask the new triggers.
      await sleep(15_000);

      // 2. Ask blibs. A new introduction must appear with the dynamic tag hint.
      const askSentAt = Date.now();
      const nonce = askSentAt.toString(36);
      await sendPopout(popout, composer, `@blibs what can you do? ${nonce}`);
      const intro = await waitForOutbox(
        app,
        (item) => item.ts >= askSentAt && item.text.startsWith('blibs introduction'),
        120_000,
      ).catch(async (error: unknown) => {
        await diagnoseLive(app, popout, 'introduction');
        throw error;
      });
      assert.ok(intro.text.includes('How tagging works:'), 'the introduction explains the tags');
      assert.ok(intro.text.endsWith('To give it a try do @opencode hi.'), 'the introduction suggests the enabled harness');
      await sleep(5_000);

      // 3. A task without a project asks which project to use.
      const hiSentAt = Date.now();
      await sendPopout(popout, composer, `@opencode hi ${nonce}`);
      const question = await waitForOutbox(
        app,
        (item) => item.ts >= hiSentAt && item.text.startsWith('Which project'),
        240_000,
      ).catch(async (error: unknown) => {
        await diagnoseLive(app, popout, 'project question');
        throw error;
      });
      assert.ok(question.text.startsWith('Which project'), 'a task without a project asks for one');
      assert.ok(
        question.text.includes('LeetCode-Solutions') || question.text.includes('streaming-simulator'),
        'the question names a registered project',
      );

      // 4. One project task reaches the router, the project agent, and this chat.
      const taskSentAt = Date.now();
      await sendPopout(popout, composer, '@opencode tell me whats in LeetCode-Solutions');
      const reply = await waitForOutbox(
        app,
        (item) => item.ts >= taskSentAt
          && item.text.startsWith(LIVE_HEADER)
          && item.text.toLowerCase().includes('leetcode'),
        300_000,
      ).catch(async (error: unknown) => {
        await diagnoseLive(app, popout, 'project reply');
        throw error;
      });
      assert.ok(reply.text.startsWith(LIVE_HEADER), 'the header is the first line of the project reply');
      assert.match(reply.text, /LeetCode-Solutions|0020|README/i, 'the reply describes the project');

      await waitForOutbox(
        app,
        (item) => item.text === reply.text && item.status === 'sent',
        120_000,
      );
      await popout.bringToFront();
      const headerLine = popout.getByText(LIVE_HEADER).first();
      if (await headerLine.isVisible().catch(() => false)) await headerLine.scrollIntoViewIfNeeded();
      await sleep(500);
      const file = path.join(ARTIFACT_DIR, 'live-popout-relay.png');
      await popout.screenshot({ path: file });
      assert.ok(existsSync(file));
      console.log(`Screenshot: ${file}`);
    } finally {
      await app.close();
    }
  },
);

