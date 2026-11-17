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
  displayAvailable,
  launch,
  NO_DISPLAY_MESSAGE,
  seedChats,
  selectAgent,
  selectTheme,
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
  'theme control follows the system preference and persists the choice',
  { skip: displayAvailable() ? false : NO_DISPLAY_MESSAGE },
  async () => {
    assert.ok(app, 'The E2E app must start.');
    const { page } = app;

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => localStorage.removeItem('blibs-theme-v1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.shell').waitFor({ state: 'visible' });
    assert.equal(await page.locator('select[aria-label="Theme"]').inputValue(), 'system');
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
    assert.equal(await page.locator('select[aria-label="Theme"]').inputValue(), 'dark');
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
