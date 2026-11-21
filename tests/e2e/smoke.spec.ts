// Smoke spec for the real Electron app.
//
// This spec uses no vendor login. It loads the panel with mock chats, checks
// the backend health through the panel proxy and directly, selects a sidebar
// chat, checks the message layout, exercises the theme control, and writes
// screenshots to the ignored artifact directory.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
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
      await page.locator('.context').getByText('Unsupported', { exact: true }).count(),
      3,
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
    const switchControl = page.getByRole('checkbox', { name: 'OpenCode for Muse' });
    await switchControl.waitFor();
    assert.equal(await switchControl.isChecked(), true);
    assert.equal(await page.locator('.connections-matrix input[type="checkbox"]').count(), 1);
    assert.equal(await page.locator('.connections-matrix').getByText('Unsupported', { exact: true }).count(), 8);
    const folder = page.locator('.connections-folder-path');
    const previousFolder = await folder.innerText();
    assert.equal(statSync(previousFolder).isDirectory(), true);
    assert.equal(await page.getByRole('button', { name: 'Change folder' }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Connect another assistant' }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Start chatting' }).isVisible(), true);
    assertImage(await app.screenshot('onboarding-dark.png'));
    await setTheme(page, 'light');
    assertImage(await app.screenshot('onboarding-light.png'));
    await setTheme(page, 'dark');

    await switchControl.focus();
    await page.keyboard.press('Space');
    await page.locator('.connections-matrix input:not(:checked):enabled').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await switchControl.waitFor();
    assert.equal(await switchControl.isChecked(), false);
    await switchControl.click();
    await page.locator('.connections-matrix input:checked:enabled').waitFor();

    await page.getByRole('button', { name: 'Change folder' }).click();
    const filePath = path.join(previousFolder, 'not-a-directory.txt');
    writeFileSync(filePath, '');
    await page.getByLabel('Shared folder path').fill(filePath);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Could not save the projects folder' }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await folder.innerText(), previousFolder);

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
      await page.locator('.context').getByText('Unsupported', { exact: true }).count(),
      3,
    );
    assert.equal(await page.locator('.context-empty').isVisible(), true);
    assertImage(await app.screenshot('chat-setup-light.png'));

    // Copy writes the connect link.
    await page.getByRole('button', { name: 'Copy the Grok connect link' }).click();
    await page.waitForFunction(
      () => document.querySelector('.setup-card [role="status"]')?.textContent === 'Copied',
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

    const projectsDir = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-intro-projects-'));
    mkdirSync(path.join(projectsDir, 'alpha'));
    try {
      await completeOnboarding(page);
      await seedConnections(page, mockConnections({ setup: { muse: 'connected' } }));
      await page.getByRole('button', { name: 'Connections', exact: true }).click();
      await page.getByRole('button', { name: 'Change folder' }).click();
      await page.getByLabel('Shared folder path').fill(projectsDir);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.connections-folder-path').filter({ hasText: realpathSync(projectsDir) }).waitFor();
      await page.getByRole('button', { name: 'Back to chats' }).click();

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
      assert.match(introText, /Available harnesses: OpenCode\./);
      assert.match(introText, /Enabled for this assistant: OpenCode\./);
      assert.match(introText, /How tagging works:/);
      assert.match(introText, /sends that task to OpenCode/);
      assert.ok(introText.includes('@opencode $<project> <task>'));
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
        text: '@opencode $alpha hi',
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
      rmSync(projectsDir, { recursive: true, force: true });
    }
  },
);

test(
  'the relay asks Muse to choose a project and runs the selected task',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-projects-'));
    const alpha = path.join(projectsDir, 'alpha');
    const beta = path.join(projectsDir, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
    try {
      const configured = await fetch(app.backendUrl + '/api/relay/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoveryRoot: projectsDir }),
      });
      assert.equal(configured.status, 200);

      const threadId = 'https://muse.ai/chat/e2e-project-choice';
      let ts = Date.now();
      const importMuse = async (role: string, text: string, sourceId: string): Promise<void> => {
        ts += 1000;
        const response = await fetch(app.backendUrl + '/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ provider: 'muse', role, text, url: threadId, sourceId, ts }] }),
        });
        assert.equal(response.status, 200);
      };
      const waitForOutbox = async (match: (text: string) => boolean): Promise<string> => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const data = await (await fetch(app.backendUrl + '/api/outbox')).json() as {
            items?: Array<{ text?: string; threadId?: string }>;
          };
          const hit = (data.items ?? []).find((item) => item.threadId === threadId && item.text && match(item.text));
          if (hit?.text) return hit.text;
          await page.waitForTimeout(250);
        }
        throw new Error('The relay did not queue the expected reply.');
      };

      await importMuse('user', 'Project choice baseline.', 'e2e-project-base');
      await page.waitForTimeout(200);
      await importMuse('agent', '@opencode Build a small app', 'e2e-project-list');
      const projectList = await waitForOutbox((text) => text.startsWith('blibs choices') && text.includes('Pick a project for your task:'));
      assert.match(projectList, /Pick a project for your task:/);
      assert.match(projectList, /- \$alpha/);
      assert.match(projectList, /- \$beta/);
      assert.ok(projectList.includes('@opencode $<project> <task>'));
      const requestId = projectList.match(/\/select ([a-f0-9]{12})/)?.[1];
      assert.ok(requestId);
      assert.ok(!projectList.includes(projectsDir), 'The project list does not expose filesystem paths.');

      await importMuse('agent', `@opencode /select ${requestId} $alpha`, 'e2e-project-run');
      const reply = await waitForOutbox((text) => text.startsWith("Sent from user's harness (OpenCode)."));
      assert.match(reply, /harness reply: Build a small app/);

      await completeOnboarding(page);
      await seedChats(page);
      await selectAgent(page, 'Muse');
      const choiceBubble = page.locator('.msg.agent', { hasText: 'blibs choices' }).first();
      await choiceBubble.waitFor({ state: 'visible', timeout: 20_000 });
      await choiceBubble.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      assertImage(await app.screenshot('project-selection.png'));
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  },
);

test(
  'scripted Muse creates a file in the requested project from the composer',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async (t) => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-composer-projects-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    const beta = path.join(projectsDir, 'beta');
    mkdirSync(alpha);
    mkdirSync(beta);
    const content = 'Hello from blibs.';
    const task = 'Create hello.txt with exactly ' + content;
    const request = 'Use OpenCode to create hello.txt. Write exactly: ' + content;
    const museChatHtml = `<!doctype html>
      <main>
        <div role="log"></div>
        <button id="choose" disabled>Choose alpha</button>
        <form><textarea aria-label="Message"></textarea><button type="submit">Send</button></form>
      </main>
      <script>
        const log = document.querySelector('[role="log"]');
        const composer = document.querySelector('textarea');
        function append(role, text) {
          const row = document.createElement('div');
          row.dataset.messageAuthorRole = role;
          row.style.whiteSpace = 'pre-wrap';
          row.textContent = text;
          log.append(row);
        }
        const choose = document.querySelector('#choose');
        choose.addEventListener('click', () => {
          append('assistant', '@opencode /select ' + choose.dataset.requestId + ' $alpha');
          choose.disabled = true;
        });
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          const text = composer.value;
          composer.value = '';
          append('user', text);
          if (text === ${JSON.stringify(request)}) append('assistant', '@opencode ' + ${JSON.stringify(task)});
          if (text.startsWith('blibs choices') && text.includes('- $alpha') && text.includes('- $beta')) {
            choose.dataset.requestId = text.split('/select ')[1].split(' ')[0];
            choose.disabled = false;
          }
        });
      </script>`;
    const testApp = await launch({ projectsDir, museChatHtml });
    try {
      const deadline = Date.now() + 15_000;
      let muse: Page | undefined;
      while (!muse && Date.now() < deadline) {
        muse = testApp.browser.contexts().flatMap((context) => context.pages())
          .find((page) => page.url() === 'https://muse.ai/');
        if (!muse) await delay(100);
      }
      assert.ok(muse, 'The Muse vendor view must start.');
      const threadUrl = 'https://muse.ai/chat/e2e-project-file';
      await muse.goto(threadUrl);
      const baseline = await fetch(testApp.backendUrl + '/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{
          provider: 'muse', role: 'user', text: 'Project file test baseline.',
          url: threadUrl, sourceId: 'project-file-baseline', ts: Date.now(),
        }] }),
      });
      assert.equal(baseline.status, 200);
      await muse.getByRole('textbox', { name: 'Message' }).fill(request);
      await muse.getByRole('button', { name: 'Send' }).click();
      const log = muse.getByRole('log');
      await log.getByText('Pick a project for your task:', { exact: false }).waitFor({ timeout: 30_000 });
      assert.deepEqual(readdirSync(alpha), []);
      assert.deepEqual(readdirSync(beta), []);
      await muse.getByRole('button', { name: 'Choose alpha' }).click();
      await log.getByText(/^@opencode \/select [a-f0-9]{12} \$alpha$/).waitFor({ timeout: 30_000 });
      await log.getByText("Sent from user's harness (OpenCode).", { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(muse.url(), threadUrl);
      assert.deepEqual(readFileSync(path.join(alpha, 'hello.txt')), Buffer.from(content));
      assert.deepEqual(readdirSync(beta), []);
    } finally {
      await testApp.close();
    }
  },
);

test(
  'Connections applies the saved folder and harness setting to Muse requests',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page, backendUrl } = app;
    const root = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-connections-'));
    const oldFolder = path.join(root, 'old');
    const newFolder = path.join(root, 'new');
    const oldFile = path.join(oldFolder, 'alpha', 'hello.txt');
    const newFile = path.join(newFolder, 'alpha', 'hello.txt');
    mkdirSync(path.dirname(oldFile), { recursive: true });
    mkdirSync(path.dirname(newFile), { recursive: true });
    const threadId = 'https://muse.ai/chat/e2e-connections';
    const prompt = 'Create hello.txt in alpha with exactly Hello from blibs.';
    const task = '$alpha Create hello.txt with exactly Hello from blibs.';
    const status = async () => await (await fetch(backendUrl + '/api/relay')).json() as {
      lastRun: unknown;
      watermark: number;
    };
    let timestamp = Math.max(Date.now(), (await status()).watermark);
    const post = async (route: string, body: unknown): Promise<void> => {
      const response = await fetch(backendUrl + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
    };
    const importTurn = (provider: string, role: string, text: string, sourceId: string) =>
      post('/api/import', { items: [{
        provider, role, text, sourceId, ts: ++timestamp,
        url: provider === 'muse' ? threadId : 'https://grok.com/chat/e2e-connections',
      }] });
    const waitForQueuedText = async (text: string, thread?: string, count = 1): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const data = await (await fetch(backendUrl + '/api/outbox')).json() as {
          items: Array<{ text: string; threadId?: string }>;
        };
        const matches = data.items.filter((item) =>
          item.text.includes(text) && (!thread || item.threadId === thread));
        if (matches.length >= count) return;
        await delay(50);
      }
      assert.fail(`The relay did not queue the expected text: ${text}`);
    };
    const sendRequest = async (sourceId: string, count: number): Promise<void> => {
      await page.getByLabel('Message Muse').fill(prompt);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await waitForQueuedText(prompt, undefined, count);
      await importTurn('muse', 'user', prompt, sourceId);
    };
    const openConnections = () => page.getByRole('button', { name: 'Connections', exact: true }).click();
    const back = () => page.getByRole('button', { name: 'Back to chats' }).click();
    const openCode = page.getByRole('checkbox', { name: 'OpenCode for Muse' });

    try {
      await post('/api/relay/projects', { discoveryRoot: oldFolder });
      await seedConnections(page, mockConnections({ setup: { muse: 'connected' } }));
      await selectAgent(page, 'Muse');
      await openConnections();
      await page.locator('.connections-folder-path').filter({ hasText: realpathSync(oldFolder) }).waitFor();
      await page.getByRole('button', { name: 'Change folder' }).click();
      await page.getByLabel('Shared folder path').fill(newFolder);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.locator('.connections-folder-path').filter({ hasText: realpathSync(newFolder) }).waitFor();

      await openCode.click();
      await page.locator('.connections-matrix input:not(:checked):enabled').waitFor();
      await back();
      const previousRun = (await status()).lastRun;
      await sendRequest('connections-user-disabled', 1);
      await importTurn('muse', 'user', '@blibs Which tools can you use?', 'connections-intro-disabled');
      await waitForQueuedText('Enabled for this assistant: no harness yet.', threadId);
      await importTurn('muse', 'agent', '@opencode ' + task, 'connections-disabled');
      await waitForQueuedText('OpenCode harness is disabled', threadId);
      assert.deepEqual((await status()).lastRun, previousRun);
      assert.equal(existsSync(newFile), false);
      assert.equal(existsSync(oldFile), false);

      await openConnections();
      await openCode.click();
      await page.locator('.connections-matrix input:checked:enabled').waitFor();
      await back();
      await sendRequest('connections-user-enabled', 2);
      await importTurn('grok', 'user', prompt, 'connections-grok-user');
      await importTurn('grok', 'agent', '@opencode ' + task, 'connections-grok-opencode');
      await importTurn('muse', 'agent', '@codex ' + task, 'connections-muse-codex');
      assert.deepEqual((await status()).lastRun, previousRun);
      assert.equal(existsSync(newFile), false);
      assert.equal(existsSync(oldFile), false);

      await importTurn('muse', 'agent', '@opencode ' + task, 'connections-enabled');
      await waitForQueuedText("Sent from user's harness (OpenCode).", threadId);
      assert.equal(readFileSync(newFile, 'utf8'), 'Hello from blibs.');
      assert.equal(existsSync(oldFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
