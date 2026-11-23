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
  MESSAGES_STORAGE_KEY,
  completeOnboarding,
  displayAvailable,
  launch,
  mockConnections,
  NO_DISPLAY_MESSAGE,
  openSettings,
  resetOnboarding,
  screenshot,
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

async function mockWebsite(app: E2EApp, name: string): Promise<Page> {
  const title = encodeURIComponent(`<title>${name}</title>`);
  const deadline = Date.now() + 5_000;
  do {
    const website = app.context.pages().find((candidate) => candidate.url().includes(title));
    if (website) {
      await website.getByLabel('Message').waitFor();
      return website;
    }
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`The ${name} website did not open.`);
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
  'panel shows the selected assistant website as the only middle pane view',
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
    const pane = page.locator('.provider-pane');
    await pane.waitFor({ timeout: 5_000 });
    assert.deepEqual(await pane.boundingBox(), await page.locator('main').boundingBox());
    assert.equal(await page.locator('.thread, .composer, .chat-head').count(), 0);

    await selectAgent(page, 'Grok');
    const grok = await mockWebsite(app, 'Grok');
    await grok.getByLabel('Message').fill('Draft for Grok');
    const selected = page.locator('.agent-main', { hasText: 'Grok' }).first();
    assert.equal(await selected.getAttribute('aria-current'), 'page');
    const other = page.locator('.agent-main', { hasText: 'Muse' }).first();
    assert.equal(await other.getAttribute('aria-current'), null);

    await page.setViewportSize({ width: 1024, height: 800 });
    assert.ok(await horizontalOverflow(page) <= 1, 'The 1024 px layout must not scroll sideways.');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(
      await page.locator('.context').isVisible(),
      false,
      'The context column collapses at 1024 px.',
    );
    const contextButton = page.locator('.context-toggle');
    const searchBounds = await page.locator('.search').boundingBox();
    const contextBounds = await contextButton.boundingBox();
    assert.ok(searchBounds && contextBounds && searchBounds.x + searchBounds.width <= contextBounds.x);

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
    assert.equal(await contextButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await pane.isVisible(), false);
    assert.equal(
      await page.locator('.context').getByText('Unsupported', { exact: true }).count(),
      3,
    );
    await page.getByRole('button', { name: 'Close context' }).click();
    assert.equal(await page.locator('.context').isVisible(), false);
    await pane.waitFor();

    await page.setViewportSize({ width: 1440, height: 900 });
    assert.ok(await horizontalOverflow(page) <= 1, 'The 1440 px layout must not scroll sideways.');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    assert.equal(await page.locator('.context').isVisible(), true);
    assert.equal(await page.locator('.context-toggle').isVisible(), false);

    // The website and context stay available in both themes.
    await selectAgent(page, 'Muse');
    await selectTheme(page, 'dark');
    const muse = await mockWebsite(app, 'Muse');
    assertImage(await screenshot(muse, 'mock-provider-page.png'));
    assertImage(await app.screenshot('assistant-website-dark.png'));
    await selectTheme(page, 'light');
    assertImage(await app.screenshot('assistant-website-light.png'));
    await selectAgent(page, 'Grok');
    assert.equal(await grok.getByLabel('Message').inputValue(), 'Draft for Grok');
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
    await page.locator('.provider-pane').waitFor();
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
            url: 'https://muse.ai/atlas',
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
    assert.equal(await page.locator('.provider-pane').isVisible(), true);

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
    assert.equal(await page.locator('.provider-pane').count(), 0);
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
    await page.locator('.provider-pane').waitFor();
    assert.equal(await input.inputValue(), '');

    // Enter runs the search immediately.
    await input.fill('backups');
    await input.press('Enter');
    await page.locator('.history-result').first().waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.history-result').count(), 1);

    // Clearing the bar returns to the open chat.
    await input.fill('');
    await page.locator('.provider-pane').waitFor();
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

    await page.getByRole('link', { name: 'Open thread', exact: true }).click();
    await page.getByRole('button', { name: 'Back to results' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.history-result').length === 3);
    assert.equal(await input.inputValue(), 'Atlas storage');

    // Selecting an agent returns to the open chat and clears the bar.
    await page.locator('.agent-main', { hasText: 'Muse' }).first().click();
    await page.locator('.provider-pane').waitFor();
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
      'Connect your AI assistants to this computer',
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

    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('picker-test');
    assertImage(await app.screenshot('new-project-dark.png'));
    await setTheme(page, 'light');
    assertImage(await app.screenshot('new-project-light.png'));
    await setTheme(page, 'dark');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByRole('textbox', { name: 'Project name' }).fill('picker-test');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.locator('option[value="picker-test"]').waitFor({ state: 'attached' });
    assert.equal(await page.getByRole('combobox', { name: 'Project', exact: true }).inputValue(), 'picker-test');
    assert.deepEqual(readdirSync(path.join(previousFolder, 'picker-test')), []);

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
    await page.getByText(/mobile verification code in the Muse website/).waitFor({ timeout: 10_000 });
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
    await page.getByText(/mobile verification code in the Muse website/).waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Check Muse sign-in again' }).click();
    await page.getByText(/Signed in to Muse/).waitFor({ timeout: 10_000 });

    // Escape always returns to the home screen.
    await page.keyboard.press('Escape');
    await page.locator('.login-screen').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.provider-pane').isVisible(), true);
    await selectTheme(page, 'dark');
    assertImage(await app.screenshot('home-after-login-dark.png'));
    await selectTheme(page, 'light');
    assertImage(await app.screenshot('home-after-login-light.png'));

    // The website opens after sign-in and supports system clipboard shortcuts.
    const website = await mockWebsite(app, 'Muse');
    const message = website.getByLabel('Message');
    await message.fill('Text to copy');
    await message.press('ControlOrMeta+a');
    await message.press('ControlOrMeta+c');
    await message.fill('');
    await message.press('ControlOrMeta+v');
    assert.equal(await message.inputValue(), 'Text to copy');
    assertImage(await app.screenshot('provider-controls.png'));
    await message.press('Escape');
    assert.equal(await page.locator('.provider-pane').isVisible(), true);
    assert.equal(await message.inputValue(), 'Text to copy');

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

    // Checking the connection opens the website in place of the setup card.
    await page.getByRole('button', { name: 'Check connection' }).click();
    await page.locator('.provider-pane').waitFor({ timeout: 10_000 });
    await mockWebsite(app, 'Grok');
    assert.equal(await page.locator('.setup-card, .composer').count(), 0);

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

      const savedMessages = () => page.evaluate((key) => JSON.parse(
        localStorage.getItem(key) ?? '{}',
      ).muse as Array<{ text: string }> | undefined, MESSAGES_STORAGE_KEY);
      const waitForSavedMessage = async (prefix: string): Promise<void> => {
        await page.waitForFunction(({ key, text }) => {
          const messages = JSON.parse(localStorage.getItem(key) ?? '{}');
          return messages.muse?.some((message: { text: string }) => message.text.startsWith(text));
        }, { key: MESSAGES_STORAGE_KEY, text: prefix }, { timeout: 20_000 });
      };
      await waitForSavedMessage('blibs introduction');
      const introText = (await savedMessages())?.find((item) => item.text.startsWith('blibs introduction'))?.text;
      assert.ok(introText);
      assert.match(introText, /Available harnesses: OpenCode\./);
      assert.match(introText, /Enabled for this assistant: OpenCode\./);
      assert.match(introText, /How tagging works:/);
      assert.match(introText, /sends that task to OpenCode/);
      assert.ok(introText.includes('@opencode /new $<project> <name> <task>'));

      const introOutbox = (await (await fetch(`${app.backendUrl}/api/outbox`)).json()) as {
        items?: Array<{ text?: string }>;
      };
      const sentIntro = (introOutbox.items ?? []).find((item) => item.text?.startsWith('blibs introduction'));
      assert.ok(sentIntro?.text, 'The introduction is queued for the vendor chat.');
      await importMuse({
        role: 'user',
        text: `You:\n\n${sentIntro.text}`,
        sourceId: 'e2e-intro-echo',
        ts: Date.now(),
      });
      const pull = page.waitForResponse((response) => response.url().includes('/api/imports'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await pull;
      await waitForSavedMessage('blibs introduction');
      assert.equal(
        (await savedMessages())?.filter((item) => item.text.includes('blibs introduction')).length,
        1,
      );

      // Muse tags OpenCode. The one project resolves and the harness replies.
      await importMuse({
        role: 'agent',
        text: '@opencode /new $alpha greeting hi',
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

      await importMuse({
        role: 'agent',
        text: reply,
        sourceId: 'e2e-intro-reply',
        ts: Date.now(),
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForSavedMessage(header);
    } finally {
      rmSync(projectsDir, { recursive: true, force: true });
    }
  },
);

test(
  'scripted Muse creates a project and writes a file from the composer',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async (t) => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-composer-projects-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    const content = 'Hello from blibs.';
    const task = 'Create hello.txt with exactly ' + content;
    const request = 'Create a project named alpha and use OpenCode to create hello.txt. Write exactly: ' + content;
    const museChatHtml = `<!doctype html>
      <main>
        <div role="log"></div>
        <button id="create" disabled>Create alpha</button>
        <button id="repeat" disabled>Redeliver creation</button>
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
        const create = document.querySelector('#create');
        const repeat = document.querySelector('#repeat');
        let created = false;
        create.addEventListener('click', () => {
          append('assistant', '@opencode /new-project alpha');
          created = true;
          create.disabled = true;
        });
        repeat.addEventListener('click', () => {
          append('assistant', '@opencode /new-project alpha');
          repeat.disabled = true;
        });
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
          if (created && text.startsWith("Sent from user's harness")) repeat.disabled = false;
          if (text === ${JSON.stringify(request)}) append('assistant', '@opencode ' + ${JSON.stringify(task)});
          if (text.startsWith('blibs choices') && text.includes('No sessions for $alpha')) {
            append('assistant', '@opencode /new $alpha hello ' + ${JSON.stringify(task)});
          }
          if (text.startsWith('blibs choices') && text.includes('No projects are available')) create.disabled = false;
          if (text.startsWith('blibs choices') && text.includes('Project created. Project ID: $alpha.')) {
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
      await log.getByText('No projects are available', { exact: false }).waitFor({ timeout: 30_000 });
      assert.deepEqual(readdirSync(projectsDir), []);
      await muse.getByRole('button', { name: 'Create alpha' }).click();
      await log.getByText('Project created. Project ID: $alpha.', { exact: false }).waitFor({ timeout: 30_000 });
      assert.deepEqual(readdirSync(alpha), []);
      await muse.getByRole('button', { name: 'Choose alpha' }).click();
      await log.getByText(/^@opencode \/select [a-f0-9]{12} \$alpha$/).waitFor({ timeout: 30_000 });
      await log.getByText("Sent from user's harness (OpenCode).", { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(muse.url(), threadUrl);
      assert.deepEqual(readFileSync(path.join(alpha, 'hello.txt')), Buffer.from(content));
      await muse.getByRole('button', { name: 'Redeliver creation' }).click();
      await log.getByText('A file or folder with that name already exists.', { exact: false }).waitFor({ timeout: 30_000 });
      assert.deepEqual(readdirSync(projectsDir), ['alpha']);
      assert.deepEqual(readFileSync(path.join(alpha, 'hello.txt')), Buffer.from(content));
    } catch (error) {
      const response = await fetch(testApp.backendUrl + '/api/outbox');
      const outbox = await response.text();
      throw new Error(`${String(error)}\nMock Muse outbox: ${outbox}`, { cause: error });
    } finally {
      await testApp.close();
    }
  },
);

test(
  'scripted Muse starts two sessions and resumes the first from the composer',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async (t) => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-sessions-'));
    t.after(() => rmSync(projectsDir, { recursive: true, force: true }));
    const alpha = path.join(projectsDir, 'alpha');
    mkdirSync(alpha);
    const first = 'Start a session named first in alpha and write first.txt.';
    const second = 'Start a session named second in alpha and write second.txt.';
    const resume = 'Continue the same session that created first.txt and update it.';
    const museChatHtml = `<!doctype html>
      <div role="log"></div>
      <form><textarea aria-label="Message"></textarea><button type="submit">Send</button></form>
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
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          const text = composer.value;
          composer.value = '';
          append('user', text);
          if (text === ${JSON.stringify(first)}) append('assistant', '@opencode /new $alpha first Write first.txt with exactly initial');
          if (text === ${JSON.stringify(second)}) append('assistant', '@opencode /new $alpha second Write second.txt with exactly separate');
          if (text === ${JSON.stringify(resume)}) append('assistant', '@opencode /resume $alpha first Write first.txt with exactly updated');
        });
      </script>`;
    const testApp = await launch({ projectsDir, museChatHtml });
    try {
      let muse: Page | undefined;
      const deadline = Date.now() + 15_000;
      while (!muse && Date.now() < deadline) {
        muse = testApp.context.pages().find((page) => page.url() === 'https://muse.ai/');
        if (!muse) await delay(100);
      }
      assert.ok(muse, 'The Muse vendor view must start.');
      const threadUrl = 'https://muse.ai/chat/e2e-sessions';
      await muse.goto(threadUrl);
      const baseline = await fetch(testApp.backendUrl + '/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{
          provider: 'muse', role: 'user', text: 'Session test baseline.',
          url: threadUrl, sourceId: 'session-baseline', ts: Date.now(),
        }] }),
      });
      assert.equal(baseline.status, 200);
      const log = muse.getByRole('log');
      const composer = muse.getByRole('textbox', { name: 'Message' });
      const send = muse.getByRole('button', { name: 'Send' });
      for (const [request, name] of [[first, 'first'], [second, 'second'], [resume, 'first']]) {
        const replies = log.getByText("Sent from user's harness (OpenCode).", { exact: false });
        const count = await replies.count();
        const notices = log.getByText(`Active session for $alpha: ${name}.`, { exact: false });
        const noticeCount = await notices.count();
        await composer.fill(request);
        await send.click();
        await notices.nth(noticeCount).waitFor({ timeout: 45_000 });
        await replies.nth(count).waitFor({ timeout: 45_000 });
        if (request === first) assert.equal(readFileSync(path.join(alpha, 'first.txt'), 'utf8'), 'initial');
      }
      const ids = readFileSync(path.join(alpha, 'session-runs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(ids.length, 3);
      assert.ok(ids.every((id) => typeof id === 'string' && id.startsWith('ses_')));
      assert.notEqual(ids[0], ids[1]);
      assert.equal(ids[0], ids[2]);
      assert.equal(readFileSync(path.join(alpha, 'first.txt'), 'utf8'), 'updated');
      assert.equal(readFileSync(path.join(alpha, 'second.txt'), 'utf8'), 'separate');
      assertImage(await screenshot(muse, 'named-sessions.png'));
    } catch (error) {
      const outbox = await (await fetch(testApp.backendUrl + '/api/outbox')).text();
      throw new Error(`${String(error)}\nMock Muse outbox: ${outbox}`, { cause: error });
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
    const task = '/new $alpha greeting Create hello.txt with exactly Hello from blibs.';
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
      await importTurn('muse', 'user', prompt, 'connections-user-disabled');
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
      await importTurn('muse', 'user', prompt, 'connections-user-enabled');
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
