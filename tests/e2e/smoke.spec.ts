// Smoke spec for the real Electron app.
//
// This spec uses no vendor login. It loads the panel with mock chats, checks
// the backend health through the panel proxy and directly, selects a sidebar
// chat, checks the message layout, exercises the theme control, and writes
// screenshots to the ignored artifact directory.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import {
  CONNECTIONS_STORAGE_KEY,
  completeOnboarding,
  displayAvailable,
  launch,
  mockConnections,
  NO_DISPLAY_MESSAGE,
  openSettings,
  resetOnboarding,
  seedChats,
  seedConnections,
  selectAgent,
  selectTheme,
  setTheme,
  type E2EApp,
} from './harness.ts';

let app: E2EApp | undefined;

const REQUIRED_TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-text',
  '--color-accent',
  '--space-2',
  '--font-size-base',
  '--radius-lg',
  '--elevation-1',
];

interface ThemeSnapshot {
  missing: string[];
  background: string;
  text: string;
  bodyBackground: string;
}

async function themeSnapshot(page: Page): Promise<ThemeSnapshot> {
  return page.evaluate((names) => {
    const root = getComputedStyle(document.documentElement);
    return {
      missing: names.filter((name) => !root.getPropertyValue(name).trim()),
      background: root.getPropertyValue('--color-bg').trim(),
      text: root.getPropertyValue('--color-text').trim(),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  }, REQUIRED_TOKENS);
}

function assertImage(file: string): void {
  assert.equal(existsSync(file), true);
  assert.ok(statSync(file).size > 0);
  console.log(`Screenshot: ${file}`);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

before(async () => {
  if (!displayAvailable()) return;
  app = await launch();
  await completeOnboarding(app.page);
  await seedChats(app.page);
});

after(async () => {
  await app?.close();
});

test(
  'panel shows a selected chat and a readable message thread',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    assert.match(await page.title(), /blibs/);
    assert.equal(await page.locator('.shell').isVisible(), true);
    assert.equal(await page.locator('.agent-main').count(), 3);

    const panelHealth = await fetch(`${app.panelUrl}/api/health`);
    assert.equal(panelHealth.status, 200);
    assert.deepEqual(await panelHealth.json(), { ok: true });

    const backendHealth = await fetch(`${app.backendUrl}/api/health`);
    assert.equal(backendHealth.status, 200);
    assert.deepEqual(await backendHealth.json(), { ok: true });

    // The panel pulls imports on load. A successful pull changes the pill.
    await page.waitForFunction(
      () => document.querySelector('.sync-pill')?.textContent?.includes('Synced'),
      undefined,
      { timeout: 20_000 },
    );

    // The sidebar works with the keyboard, not only the pointer.
    await page.locator('.agent-main', { hasText: 'Muse' }).first().focus();
    await page.keyboard.press('Enter');
    await page.locator('.thread[aria-label="Messages with Muse"]').waitFor({ timeout: 5_000 });

    // Harness work appears as an action card with a harness name and a status.
    assert.equal(await page.locator('.action-card').count(), 1);
    assert.equal(await page.locator('.action-name').innerText(), 'Claude Code');
    assert.equal(await page.locator('.action-msg .ui-status-pill').innerText(), 'Completed');
    assert.match(
      await page.locator('.action-detail').innerText(),
      /ran 12 tests/,
    );

    await selectAgent(page, 'Grok');
    assert.equal(await page.locator('.thread').getAttribute('aria-label'), 'Messages with Grok');

    const selected = page.locator('.agent-main', { hasText: 'Grok' }).first();
    assert.equal(await selected.getAttribute('aria-current'), 'page');
    const other = page.locator('.agent-main', { hasText: 'Muse' }).first();
    assert.equal(await other.getAttribute('aria-current'), null);

    assert.equal(await page.locator('.msg').count(), 3);
    assert.deepEqual(
      await page.locator('.msg-role').allInnerTexts(),
      ['Grok', 'You', 'Grok'],
    );
    assert.equal(await page.locator('.msg-meta time').count(), 3);

    // A long URL must wrap inside its bubble instead of clipping.
    const clipped = await page.evaluate(
      () => Array.from(document.querySelectorAll('.msg p'))
        .map((item) => item.scrollWidth - item.clientWidth)
        .filter((delta) => delta > 1),
    );
    assert.deepEqual(clipped, [], 'Message text must wrap inside the bubble.');

    await page.setViewportSize({ width: 1024, height: 800 });
    assert.ok(await horizontalOverflow(page) <= 1, 'The 1024 px layout must not scroll sideways.');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(
      await page.locator('.context').isVisible(),
      false,
      'The context column collapses at 1024 px.',
    );
    assert.equal(await page.locator('.context-toggle').isVisible(), true);

    await page.setViewportSize({ width: 800, height: 800 });
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    const toggle = page.locator('.sidebar-toggle');
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await toggle.click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);

    // The context controls stay reachable at a narrow width.
    await page.locator('.context-toggle').click();
    assert.equal(await page.locator('.context').isVisible(), true);
    assert.equal(await page.locator('.context-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(
      await page.getByRole('checkbox', { name: 'Claude Code for Grok' }).isVisible(),
      true,
    );
    await page.getByRole('button', { name: 'Close context' }).click();
    assert.equal(await page.locator('.context').isVisible(), false);

    await page.setViewportSize({ width: 1440, height: 900 });
    assert.ok(await horizontalOverflow(page) <= 1, 'The 1440 px layout must not scroll sideways.');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(await page.locator('.context').isVisible(), true);
    assert.equal(await page.locator('.context-toggle').isVisible(), false);

    // The connected chat in the dark theme keeps the action card and context.
    await selectAgent(page, 'Muse');
    await selectTheme(page, 'dark');
    assert.equal(await page.locator('.action-card').isVisible(), true);
    assertImage(await app.screenshot('chat-connected-dark.png'));
    await selectAgent(page, 'Grok');
    assertImage(await app.screenshot('panel-selected-chat.png'));
  },
);

test(
  'sync controls live in Settings and apply to the running timer',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    // The sidebar footer keeps only the agents entry.
    assert.equal(await page.locator('.side-foot input[type="checkbox"]').count(), 0);
    assert.equal(await page.locator('.side-foot select').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: 'Agents', exact: true }).isVisible(),
      true,
    );
    assert.equal(await page.getByText('Agents and sign-in').count(), 0);

    await openSettings(page);
    const syncCard = page.locator('.settings-card', {
      has: page.getByRole('heading', { name: 'Sync', exact: true }),
    });
    assert.equal(await syncCard.isVisible(), true);
    const toggle = syncCard.getByLabel('Auto-sync', { exact: true });
    const interval = syncCard.getByLabel('Auto-sync interval');
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await interval.inputValue(), '15');

    // The existing storage keys keep the values.
    await toggle.uncheck();
    assert.equal(await page.evaluate(() => localStorage.getItem('blibs-autopull-v1')), 'false');
    await toggle.check();
    assert.equal(await page.evaluate(() => localStorage.getItem('blibs-autopull-v1')), 'true');
    await interval.selectOption('30');
    assert.equal(await page.evaluate(() => localStorage.getItem('blibs-pullsecs-v1')), '30');

    // The running timer uses the new interval without a restart.
    const nextPull = page.waitForRequest(
      (request) => request.url().includes('/api/imports'),
      { timeout: 10_000 },
    );
    await interval.selectOption('15');
    await nextPull;
    assert.equal(await page.evaluate(() => localStorage.getItem('blibs-pullsecs-v1')), '15');
    assertImage(await app.screenshot('settings-sync.png'));

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('.thread').waitFor();
  },
);

test(
  'topbar search runs one global search with a provider tag and settings',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    // Retained history for the global search. Keyword search needs no model.
    const imported = await fetch(`${app.backendUrl}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [
          {
            provider: 'muse',
            role: 'user',
            sourceId: 'e2e-atlas-1',
            threadId: 'https://muse.example/atlas',
            text: 'The Atlas storage decision is Postgres.',
            ts: Date.now() - 120_000,
          },
          {
            provider: 'muse',
            role: 'agent',
            sourceId: 'e2e-atlas-2',
            threadId: 'https://muse.example/atlas',
            text: 'Atlas storage backups run every night at 02:00.',
            ts: Date.now() - 60_000,
          },
          {
            provider: 'dots',
            role: 'user',
            sourceId: 'e2e-atlas-3',
            threadId: 'https://dots.example/atlas',
            text: 'Atlas storage is out of scope for Dots.',
            ts: Date.now() - 30_000,
          },
        ],
      }),
    });
    assert.equal(imported.status, 200);

    await completeOnboarding(page);
    await selectTheme(page, 'dark');
    await selectAgent(page, 'Muse');

    const input = page.locator('.search input');
    assert.equal(await input.getAttribute('aria-label'), 'Search all conversations');
    // The search UI has one bar and no selectors.
    assert.equal(await page.locator('.topbar select').count(), 0);
    assert.equal(await page.getByLabel('Search scope').count(), 0);

    // Cmd+F or Ctrl+F from a chat prefills that chat's provider tag.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
    await page.waitForFunction(() => {
      const field = document.querySelector<HTMLInputElement>('.search input');
      return field?.value === '#muse ';
    });
    assert.equal(await input.inputValue(), '#muse ');
    const caretAtEnd = await page.evaluate(() => {
      const field = document.querySelector<HTMLInputElement>('.search input');
      return Boolean(field && field.selectionStart === field.value.length);
    });
    assert.equal(caretAtEnd, true, 'The caret must sit after the prefilled tag.');

    // A tag with no query text runs no search.
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.history-search').count(), 0);
    assert.equal(await page.locator('.thread').isVisible(), true);

    const bodies: Array<{ query?: string; filters?: { provider?: string } }> = [];
    const recordSearch = (request: Request): void => {
      if (!request.url().includes('/api/search')) return;
      bodies.push(request.postDataJSON() as { query?: string; filters?: { provider?: string } });
    };
    page.on('request', recordSearch);

    // A #provider tag limits the search. The token stays in the input.
    await input.fill('#muse Atlas storage');
    await page.waitForFunction(
      () => document.querySelectorAll('.history-result').length === 2,
      undefined,
      { timeout: 15_000 },
    );
    assert.equal(await input.inputValue(), '#muse Atlas storage');
    assert.equal(await page.locator('.thread').count(), 0);
    const museBody = bodies.at(-1);
    assert.equal(museBody?.query, 'Atlas storage');
    assert.equal(museBody?.filters?.provider, 'muse');
    assertImage(await app.screenshot('search-provider-tag.png'));

    // Removing the tag searches every chat.
    await input.fill('Atlas storage');
    await page.waitForFunction(
      () => document.querySelectorAll('.history-result').length === 3,
      undefined,
      { timeout: 15_000 },
    );
    const allBody = bodies.at(-1);
    assert.equal(allBody?.query, 'Atlas storage');
    assert.equal(allBody?.filters?.provider, undefined);
    assertImage(await app.screenshot('search-results.png'));

    // Escape returns to the open chat and clears the bar.
    await input.press('Escape');
    await page.locator('.thread').waitFor();
    assert.equal(await input.inputValue(), '');

    // Enter runs the search immediately.
    await input.fill('backups');
    await input.press('Enter');
    await page.locator('.history-result').first().waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.history-result').count(), 1);

    // Clearing the bar returns to the open chat.
    await input.fill('');
    await page.locator('.thread').waitFor();
    assert.equal(await page.locator('.history-search').count(), 0);

    // Settings holds the index controls, Ask locally, the advanced filters, and the theme.
    await input.fill('Atlas storage');
    await page.waitForFunction(
      () => document.querySelectorAll('.history-result').length === 3,
      undefined,
      { timeout: 15_000 },
    );
    await openSettings(page);
    await page.getByText(/passages indexed/).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole('button', { name: /^Pause indexing$|^Resume indexing$/ }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Rebuild vectors' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Ask locally' }).isVisible(), true);
    assert.equal(
      await page.getByRole('button', { name: 'Ask locally' }).isDisabled(),
      true,
      'Ask locally needs a local model.',
    );
    assert.equal(await page.getByLabel('Thread URL or ID', { exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('From', { exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('To', { exact: true }).isVisible(), true);
    assert.equal(await page.getByLabel('Theme').isVisible(), true);
    await page.getByLabel('Thread URL or ID', { exact: true }).fill('https://muse.example/atlas');
    await page.waitForFunction(
      () => (localStorage.getItem('blibs-search-defaults-v1') ?? '').includes('muse.example/atlas'),
    );
    const saved = await page.evaluate(() => localStorage.getItem('blibs-search-defaults-v1'));
    assert.match(saved ?? '', /muse\.example\/atlas/);
    assertImage(await app.screenshot('settings.png'));

    // The advanced filters are search defaults.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.history-result').length === 2,
      undefined,
      { timeout: 15_000 },
    );
    await openSettings(page);
    assert.equal(
      await page.getByLabel('Thread URL or ID', { exact: true }).inputValue(),
      'https://muse.example/atlas',
    );
    await page.getByLabel('Thread URL or ID', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.history-result').length === 3,
      undefined,
      { timeout: 15_000 },
    );

    // Selecting an agent returns to the open chat and clears the bar.
    await page.locator('.agent-main', { hasText: 'Muse' }).first().click();
    await page.locator('.thread').waitFor();
    assert.equal(await page.locator('.history-search').count(), 0);
    assert.equal(await input.inputValue(), '');
    page.off('request', recordSearch);
  },
);

test(
  'theme control follows the system preference and persists the choice',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => localStorage.removeItem('blibs-theme-v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.shell').waitFor({ state: 'visible' });
    await openSettings(page);
    assert.equal(await page.getByLabel('Theme').inputValue(), 'system');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(
      await page.locator('html').getAttribute('data-theme'),
      'dark',
      'The default theme must follow a dark system preference.',
    );

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(
      await page.locator('html').getAttribute('data-theme'),
      'light',
      'The system theme must update without a reload.',
    );

    await selectTheme(page, 'dark');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('blibs-theme-v1')),
      '"dark"',
      'The theme control must save the choice.',
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.shell').waitFor({ state: 'visible' });
    await openSettings(page);
    assert.equal(await page.getByLabel('Theme').inputValue(), 'dark');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');

    const dark = await themeSnapshot(page);
    assert.deepEqual(dark.missing, [], 'The dark theme must define every required token.');
    assertImage(await app.screenshot('panel-dark.png'));

    await selectTheme(page, 'light');
    const light = await themeSnapshot(page);
    assert.deepEqual(light.missing, [], 'The light theme must define every required token.');
    assert.notEqual(light.background, dark.background);
    assert.notEqual(light.text, dark.text);
    assert.notEqual(light.bodyBackground, dark.bodyBackground);
    assertImage(await app.screenshot('panel-light.png'));
  },
);

test(
  'first run shows the connections matrix and does not reappear',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    await page.evaluate((key) => localStorage.removeItem(key), CONNECTIONS_STORAGE_KEY);
    await resetOnboarding(page);
    await setTheme(page, 'dark');

    assert.equal(
      await page.locator('#onboarding-title').innerText(),
      'Connect your AI assistants to this Mac',
    );
    assert.equal(await page.locator('.sidebar').count(), 0, 'Onboarding has no chat sidebar.');
    assert.equal(await page.locator('.connections-matrix input[type="checkbox"]').count(), 9);
    assert.equal(
      await page.getByRole('checkbox', { name: 'Claude Code for Muse' }).isChecked(),
      true,
    );
    assert.equal(await page.locator('.connections-folder-path').innerText(), '~/Projects');
    assert.equal(await page.getByRole('button', { name: 'Change folder' }).isVisible(), true);
    assert.equal(
      await page.getByRole('button', { name: 'Connect another assistant' }).isVisible(),
      true,
    );
    assert.equal(await page.getByRole('button', { name: 'Start chatting' }).isVisible(), true);
    assertImage(await app.screenshot('onboarding-dark.png'));
    await setTheme(page, 'light');
    assertImage(await app.screenshot('onboarding-light.png'));
    await setTheme(page, 'dark');

    // The matrix keeps a keyboard toggle and saves the choice.
    await page.getByRole('checkbox', { name: 'Codex for Muse' }).focus();
    await page.keyboard.press('Space');
    assert.equal(
      await page.getByRole('checkbox', { name: 'Codex for Muse' }).isChecked(),
      false,
    );
    await page.waitForFunction(
      (key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const state = JSON.parse(raw) as {
          assistants?: Record<string, { harnesses?: Record<string, boolean> }>;
        };
        return state.assistants?.muse?.harnesses?.codex === false;
      },
      CONNECTIONS_STORAGE_KEY,
    );

    // Change folder keeps the path in the connection state.
    await page.getByRole('button', { name: 'Change folder' }).click();
    await page.getByLabel('Shared folder path').fill('~/Work');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    assert.equal(await page.locator('.connections-folder-path').innerText(), '~/Work');
    await page.waitForFunction(
      (key) => (localStorage.getItem(key) ?? '').includes('~/Work'),
      CONNECTIONS_STORAGE_KEY,
    );

    await page.getByRole('button', { name: 'Start chatting' }).click();
    await page.locator('.shell').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.onboarding-screen').count(), 0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.shell').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('.onboarding-screen').count(),
      0,
      'The first-run flow must not reappear after completion.',
    );
  },
);

test(
  'vendor sign-in entry point shows mocked steps and returns home',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    await completeOnboarding(page);
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('heading', { name: 'Agents', exact: true }).waitFor();
    assert.equal(await page.locator('.login-vendor').count(), 3);

    // A login attempt reports inline progress and the mobile-code next step.
    await page.getByRole('button', { name: 'Sign in to Muse' }).click();
    await page.getByText(/mobile verification code in the Muse window/).waitFor({ timeout: 10_000 });
    assert.equal(
      await page.getByRole('button', { name: 'Check Muse sign-in again' }).isVisible(),
      true,
    );
    await selectTheme(page, 'dark');
    assertImage(await app.screenshot('login-dark.png'));
    await selectTheme(page, 'light');
    assertImage(await app.screenshot('login-light.png'));
    await selectTheme(page, 'dark');

    // Cancel is always available and reports the result inline.
    await page.getByRole('button', { name: 'Cancel Muse sign-in' }).click();
    await page.getByText(/Sign-in cancelled for Muse/).waitFor();

    // A second attempt can pass the verification step and sign in.
    await page.getByRole('button', { name: 'Sign in to Muse' }).click();
    await page.getByText(/mobile verification code in the Muse window/).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Check Muse sign-in again' }).click();
    await page.getByText(/Signed in to Muse/).waitFor({ timeout: 10_000 });

    // Escape always returns to the home screen.
    await page.keyboard.press('Escape');
    await page.locator('.login-screen').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.thread').isVisible(), true);
    await selectTheme(page, 'dark');
    assertImage(await app.screenshot('home-after-login-dark.png'));
    await selectTheme(page, 'light');
    assertImage(await app.screenshot('home-after-login-light.png'));

    // The in-app Back control returns home too.
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await page.locator('.login-screen').waitFor({ state: 'detached' });
  },
);

test(
  'an unconnected assistant shows an inline setup card and a disabled composer',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    await seedConnections(page, mockConnections({ setup: { grok: 'setup' } }));
    await selectTheme(page, 'light');
    await page.locator('.agent-main', { hasText: 'Grok' }).first().click();
    await page.locator('.setup-card').waitFor({ state: 'visible' });

    // The header reports the connection state.
    assert.match(await page.locator('.chat-identity').innerText(), /Grok/);
    assert.match(await page.locator('.chat-identity .ui-status-pill').innerText(), /Setup/);

    // The card has three numbered steps and the assistant-specific link.
    assert.equal(await page.locator('.setup-step').count(), 3);
    assert.equal(
      await page.locator('.link-box__value').innerText(),
      'https://blibs.app/c/grok',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Copy the Grok connect link' }).isVisible(),
      true,
    );
    assert.equal(await page.getByRole('button', { name: 'Check connection' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Open Grok' }).isVisible(), true);

    // The composer is disabled and says why.
    const composer = page.locator('.composer--disabled');
    assert.equal(await composer.locator('input').isDisabled(), true);
    assert.equal(await composer.getByRole('button', { name: 'Send' }).isDisabled(), true);
    assert.match(
      await page.locator('.composer-reason').innerText(),
      /Connect Grok above before you send a message/,
    );

    // The left list marks the assistant as Setup.
    assert.match(
      await page.locator('.agent--setup .astate').first().innerText(),
      /Setup/,
    );

    // The context column holds the harness toggles and an honest empty activity.
    assert.equal(
      await page.getByRole('checkbox', { name: 'Claude Code for Grok' }).isVisible(),
      true,
    );
    assert.equal(await page.locator('.context-empty').isVisible(), true);
    assertImage(await app.screenshot('chat-setup-light.png'));

    // Copy writes the connect link.
    await page.getByRole('button', { name: 'Copy the Grok connect link' }).click();
    await page.waitForFunction(
      () => document.querySelector('.setup-card [role="status"]')?.textContent === 'Copied',
    );

    // A harness toggle in the context column persists for this assistant.
    await page.getByRole('checkbox', { name: 'Codex for Grok' }).uncheck();
    await page.waitForFunction(
      (key) => {
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const state = JSON.parse(raw) as {
          assistants?: Record<string, { harnesses?: Record<string, boolean> }>;
        };
        return state.assistants?.grok?.harnesses?.codex === false;
      },
      CONNECTIONS_STORAGE_KEY,
    );

    // Open assistant starts the in-app sign-in attempt.
    await page.getByRole('button', { name: 'Open Grok' }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.setup-card').isVisible(), true);

    // Check connection turns the assistant into a connected chat.
    await page.getByRole('button', { name: 'Check connection' }).click();
    await page
      .locator('.thread[aria-label="Messages with Grok"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
    assert.match(await page.locator('.chat-identity .ui-status-pill').innerText(), /Connected/);
    assert.equal(await page.getByLabel('Message Grok').isEnabled(), true);

    // The Connections entry opens the same screen with a Back control.
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.locator('.connections-screen').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.sidebar').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Back to chats' }).isVisible(), true);
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await page.locator('.shell').waitFor({ state: 'visible' });
  },
);

test(
  'an @blibs mention shows the introduction and a harness reply says which harness sent it',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    const project = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-intro-project-'));
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-intro-root-'));
    try {
      // The panel reports its harness toggles. Muse has Codex off, so the
      // introduction must not list Codex as enabled.
      await completeOnboarding(page);
      await seedConnections(page, mockConnections({
        harnesses: { muse: { 'claude-code': true, codex: false, opencode: true } },
      }));
      const harnessDeadline = Date.now() + 15_000;
      let reported = false;
      while (Date.now() < harnessDeadline) {
        const status = (await (await fetch(`${app.backendUrl}/api/relay`)).json()) as {
          harnesses?: Array<{ id: string; enabled: boolean }>;
        };
        if (status.harnesses?.some((entry) => entry.id === 'codex' && entry.enabled === false)) {
          reported = true;
          break;
        }
        await page.waitForTimeout(200);
      }
      assert.equal(reported, true, 'the panel reports the harness toggles to the relay');

      const registry = await fetch(`${app.backendUrl}/api/relay/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: [project], discoveryRoot: emptyRoot }),
      });
      assert.equal(registry.status, 200);

      const threadId = 'https://muse.ai/chat/e2e-intro';
      const importMuse = async (item: Record<string, unknown>): Promise<void> => {
        const response = await fetch(`${app.backendUrl}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ provider: 'muse', url: threadId, ...item }] }),
        });
        assert.equal(response.status, 200);
      };

      await importMuse({
        role: 'user',
        text: 'E2E introduction baseline.',
        sourceId: 'e2e-intro-base',
        ts: Date.now(),
      });
      await page.waitForTimeout(100);

      // A user tags blibs. The relay answers with the generated introduction.
      await importMuse({
        role: 'user',
        text: '@blibs What can you do?',
        sourceId: 'e2e-intro-ask',
        ts: Date.now(),
      });
      await page.waitForTimeout(100);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
      await selectAgent(page, 'Muse');

      const intro = page.locator('.msg.agent', { hasText: 'blibs introduction' }).first();
      await intro.waitFor({ state: 'visible', timeout: 20_000 });
      const introText = await intro.locator('.msg-bubble p').innerText();
      assert.match(introText, /Available harnesses: Claude Code, Codex, OpenCode\./);
      assert.match(introText, /Enabled for this assistant: Claude Code, OpenCode\./);
      assert.ok(
        !/Enabled for this assistant:[^.]*Codex/.test(introText),
        'a disabled harness is not listed as enabled',
      );
      assert.match(introText, /How tagging works:/);
      assert.match(introText, /How to choose a project and session:/);
      assert.match(introText, /\$find-project <task>/);
      assert.ok(introText.endsWith('To give it a try do @opencode.'), 'the reply ends with the project list request');
      await intro.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      assertImage(await app.screenshot('blibs-intro.png'));

      // The relay also sends the reply into the vendor chat. Its echo must not
      // add a second bubble or a second introduction.
      const introOutbox = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
        items?: Array<{ text?: string }>;
      };
      const sentIntro = (introOutbox.items ?? []).find((item) => item.text?.startsWith('blibs introduction'));
      assert.ok(sentIntro?.text, 'the introduction is queued for the vendor chat');
      await importMuse({
        role: 'user',
        text: `You:\n\n${sentIntro.text}`,
        sourceId: 'e2e-intro-echo',
        ts: Date.now(),
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
      await selectAgent(page, 'Muse');
      await page.locator('.msg.agent', { hasText: 'blibs introduction' }).first().waitFor({ timeout: 20_000 });
      assert.equal(
        await page.locator('.msg', { hasText: 'blibs introduction' }).count(),
        1,
        'the vendor echo does not add a second introduction bubble',
      );

      // Muse tags OpenCode. The one project resolves and the harness replies.
      await importMuse({
        role: 'agent',
        text: '@opencode hi',
        sourceId: 'e2e-intro-task',
        ts: Date.now(),
      });
      const header = "Sent from user's harness (OpenCode).";
      let reply = '';
      const replyDeadline = Date.now() + 25_000;
      while (Date.now() < replyDeadline) {
        const outbox = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
          items?: Array<{ text?: string }>;
        };
        const hit = (outbox.items ?? []).find((item) => item.text?.startsWith(header));
        if (hit?.text?.includes('harness reply: hi')) {
          reply = hit.text;
          break;
        }
        await page.waitForTimeout(250);
      }
      assert.ok(reply.startsWith(header), 'the harness reply starts with the harness header');
      assert.ok(reply.includes('harness reply: hi'), 'the harness text follows the header');

      // A vendor session types the reply into the chat. The panel must show
      // the header as the first line of the message.
      await importMuse({
        role: 'agent',
        text: reply,
        sourceId: 'e2e-intro-reply',
        ts: Date.now(),
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
      await selectAgent(page, 'Muse');
      const harnessReply = page.locator('.msg.agent', { hasText: header }).first();
      await harnessReply.waitFor({ state: 'visible', timeout: 20_000 });
      const replyText = await harnessReply.locator('.msg-bubble p').innerText();
      assert.ok(replyText.startsWith(header), 'the header is at the top of the message');
      assert.ok(replyText.includes('harness reply: hi'));
      await harnessReply.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      assertImage(await app.screenshot('harness-reply.png'));
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  },
);

test(
  'the relay lists projects and sessions and runs a chosen session',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    const project = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-choice-project-'));
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-choice-root-'));
    try {
      const registry = await fetch(`${app.backendUrl}/api/relay/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: [project], discoveryRoot: emptyRoot }),
      });
      assert.equal(registry.status, 200);

      const threadId = 'https://muse.ai/chat/e2e-choices';
      const importMuse = async (item: Record<string, unknown>): Promise<void> => {
        const response = await fetch(`${app.backendUrl}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ provider: 'muse', url: threadId, ...item }] }),
        });
        assert.equal(response.status, 200);
      };
      const waitForOutbox = async (match: (text: string) => boolean): Promise<string> => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const data = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
            items?: Array<{ text?: string; threadId?: string }>;
          };
          const hit = (data.items ?? []).find((item) => item.threadId === threadId && item.text && match(item.text));
          if (hit?.text) return hit.text;
          await page.waitForTimeout(250);
        }
        throw new Error('The relay did not queue the expected choice reply.');
      };

      await importMuse({ role: 'user', text: 'E2E choices baseline.', sourceId: 'e2e-choice-base', ts: Date.now() });
      await page.waitForTimeout(200);

      await importMuse({ role: 'agent', text: '@opencode', sourceId: 'e2e-choice-projects', ts: Date.now() });
      const projectChoices = await waitForOutbox((text) => text.startsWith('blibs choices') && text.includes('OpenCode projects:'));
      assert.match(projectChoices, /OpenCode projects:/);
      assert.ok(!projectChoices.includes(project), 'The project list omits the path.');
      const tokenMatch = /- \$([^\s]+)/.exec(projectChoices);
      assert.ok(tokenMatch, 'The project choice has one token.');
      const token = tokenMatch[1];

      await importMuse({ role: 'agent', text: `@opencode $sessions $${token}`, sourceId: 'e2e-choice-sessions', ts: Date.now() });
      const sessionChoices = await waitForOutbox((text) => text.startsWith('blibs choices') && text.includes(`$${token}-ses_e2e`));
      assert.match(sessionChoices, /Sessions for/);
      assert.match(sessionChoices, /E2E session/);

      await importMuse({
        role: 'agent',
        text: `@opencode $${token}-ses_e2e Do the chosen work`,
        sourceId: 'e2e-choice-run',
        ts: Date.now(),
      });
      const header = "Sent from user's harness (OpenCode).";
      const reply = await waitForOutbox((text) => text.startsWith(header) && text.includes('harness reply: Do the chosen work'));
      assert.ok(reply.includes('harness reply: Do the chosen work'));

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
      await selectAgent(page, 'Muse');
      const choiceBubble = page.locator('.msg.agent', { hasText: 'blibs choices' }).first();
      await choiceBubble.waitFor({ state: 'visible', timeout: 20_000 });
      await choiceBubble.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      assertImage(await app.screenshot('project-session-choices.png'));
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  },
);

test(
  'an @opencode request routes through the relay and asks when unclear',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    // Two projects make one task ambiguous, so the routing agent must ask. The
    // stubbed routing run decides; no work run starts.
    const projA = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-alpha-'));
    const projB = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-beta-'));
    const emptyRoot = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-empty-'));
    try {
      const registry = await fetch(`${app.backendUrl}/api/relay/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: [projA, projB], discoveryRoot: emptyRoot }),
      });
      assert.equal(registry.status, 200);
      const status = (await registry.json()) as { projects?: string[] };
      assert.equal(status.projects?.length, 2);

      const threadId = 'https://muse.ai/chat/e2e-routing';
      const baseline = await fetch(`${app.backendUrl}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            provider: 'muse',
            role: 'user',
            sourceId: 'e2e-routing-base',
            threadId,
            text: 'E2E routing baseline.',
            ts: Date.now(),
          }],
        }),
      });
      assert.equal(baseline.status, 200);
      await page.waitForTimeout(300);

      const task = await fetch(`${app.backendUrl}/api/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            provider: 'muse',
            role: 'agent',
            sourceId: 'e2e-routing-task',
            threadId,
            text: '@opencode Do the e2e thing',
            ts: Date.now(),
          }],
        }),
      });
      assert.equal(task.status, 200);

      // The routing agent asks once and no work run starts.
      let clarification = '';
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const outbox = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
          items?: Array<{ provider?: string; text?: string; threadId?: string }>;
        };
        const hit = (outbox.items ?? []).find((item) => item.text?.includes('Which project'));
        if (hit) {
          clarification = hit.text ?? '';
          assert.equal(hit.provider, 'muse');
          assert.equal(hit.threadId, threadId);
          break;
        }
        await page.waitForTimeout(250);
      }
      assert.ok(clarification.includes('Which project'), 'The relay asks for the project.');
      assert.ok(!clarification.includes('@opencode'), 'The question never retriggers.');

      // The panel shows the imported @opencode request in the Muse thread.
      await completeOnboarding(page);
      await seedChats(page);
      await selectAgent(page, 'Muse');
      const trigger = page.getByText('@opencode Do the e2e thing');
      await trigger.first().waitFor({ timeout: 20_000 });
      assert.ok((await trigger.count()) >= 1);
      await trigger.first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      assertImage(await app.screenshot('relay-routing.png'));
    } finally {
      rmSync(projA, { recursive: true, force: true });
      rmSync(projB, { recursive: true, force: true });
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  },
);
