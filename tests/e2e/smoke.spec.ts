// Smoke spec for the real Electron app.
//
// This spec uses no vendor login. It loads the panel with mock chats, checks
// the backend health through the panel proxy and directly, selects a sidebar
// chat, checks the message layout, exercises the theme control, and writes
// screenshots to the ignored artifact directory.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import type { Page } from 'playwright-core';
import {
  completeOnboarding,
  displayAvailable,
  launch,
  NO_DISPLAY_MESSAGE,
  openSettings,
  resetOnboarding,
  seedChats,
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
    await page.locator('.thread-head h1', { hasText: 'Muse' }).waitFor({ timeout: 5_000 });

    await selectAgent(page, 'Grok');
    assert.equal((await page.locator('.thread-head h1').innerText()).trim(), 'Grok');
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

    await page.setViewportSize({ width: 800, height: 800 });
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    const toggle = page.locator('.sidebar-toggle');
    assert.equal(await toggle.isVisible(), true);
    await toggle.click();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await toggle.click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);

    await page.setViewportSize({ width: 1440, height: 900 });
    assert.ok(await horizontalOverflow(page) <= 1, 'The 1440 px layout must not scroll sideways.');
    assert.equal(await page.locator('.sidebar').isVisible(), true);
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
  'first run shows onboarding steps and does not reappear',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    await resetOnboarding(page);
    await setTheme(page, 'dark');

    assert.match(
      await page.locator('#onboarding-title').innerText(),
      /One window for your personal agents/,
    );
    assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Skip', exact: true }).isVisible(), true);
    assertImage(await app.screenshot('onboarding-dark.png'));
    await setTheme(page, 'light');
    assertImage(await app.screenshot('onboarding-light.png'));
    await setTheme(page, 'dark');

    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await page.locator('#onboarding-title').innerText(), 'Connect a vendor');
    assert.equal(await page.getByRole('combobox', { name: 'Vendor' }).isVisible(), true);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(
      await page.locator('#onboarding-title').innerText(),
      'One window for your personal agents',
    );

    await page.getByRole('button', { name: 'Skip', exact: true }).click();
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
    assert.equal(await page.locator('.thread-head h1').isVisible(), true);
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
