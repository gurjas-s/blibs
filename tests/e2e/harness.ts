// End-to-end harness for the real Electron app.
//
// The harness starts Electron with a remote debugging port, connects
// playwright-core over the Chrome DevTools Protocol (CDP), waits for the panel,
// and exposes screenshot and interaction helpers. It does not download a
// browser: playwright-core uses the Chromium engine inside Electron.
//
// Run it with `npm run e2e`. The command builds the app first.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const electronPath = require('electron') as unknown as string;

/** Directory for screenshots. The repository ignores this directory. */
export const ARTIFACT_DIR = path.join(repoRoot, 'tests', 'e2e', 'artifacts');

/** Message for a machine that has no display server. */
export const NO_DISPLAY_MESSAGE =
  'No display found. Run this check on a desktop, or use xvfb-run on Linux.';

export interface LaunchOptions {
  /** Maximum time to wait for the panel, in milliseconds. */
  timeoutMs?: number;
  /**
   * Use the deterministic in-app sign-in steps. Defaults to true. The live Muse
   * check sets this to false to load the provider website.
   */
  mockLogin?: boolean;
  /** Serve a scripted chat document from the Muse partition. */
  museChatHtml?: string;
  /**
   * Use an existing Electron profile for an authenticated check.
   */
  profileDir?: string;
  /**
   * Harness command for the relay. Defaults to the fake harness. A live relay
   * check sets null to use the configured harness, for example OpenCode.
   */
  relayCommand?: string | null;
  /**
   * Projects directory. Defaults to a temporary directory.
   * A live relay check sets null to use the real home folder.
   */
  projectsDir?: string | null;
}

export interface E2EApp {
  /** Playwright connection to the Electron browser. */
  browser: Browser;
  /** Default browser context of the Electron app. */
  context: BrowserContext;
  /** Panel page that the main window loaded. */
  page: Page;
  /** `http://127.0.0.1:<panel port>` */
  panelUrl: string;
  /** `http://127.0.0.1:<backend port>` */
  backendUrl: string;
  /** `http://127.0.0.1:<CDP port>` */
  cdpUrl: string;
  /** Temporary projects directory created for the test. */
  projectsDir: string;
  /** Take a PNG screenshot into the ignored artifact directory. */
  screenshot(name: string): Promise<string>;
  /** Stop Electron and remove the temporary profile and history. */
  close(): Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Return true when the operating system has a display server. */
export function displayAvailable(): boolean {
  if (process.platform !== 'linux') return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

async function freePorts(count: number): Promise<number[]> {
  const servers: net.Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not reserve a TCP port.');
      return address.port;
    });
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

function collectOutput(child: ChildProcess): string[] {
  const lines: string[] = [];
  const debug = process.env.BLIBS_E2E_DEBUG === '1';
  const record = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      if (debug) process.stderr.write(`[electron] ${line}\n`);
    }
    if (lines.length > 40) lines.splice(0, lines.length - 40);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  return lines;
}

async function waitForCdp(
  cdpUrl: string,
  child: ChildProcess,
  output: string[],
  timeoutMs: number,
  getSpawnError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`Could not start Electron: ${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`Electron exited with code ${child.exitCode} before CDP started.\n${output.join('\n')}`);
    }
    try {
      const res = await fetch(`${cdpUrl}/json/version`);
      if (res.ok) return;
    } catch {
      // The debugging endpoint is not open yet.
    }
    await delay(100);
  }
  throw new Error(`CDP did not start at ${cdpUrl} within ${timeoutMs} ms.\n${output.join('\n')}`);
}

/** Wait for the Electron main window and its panel content. */
export async function waitForPanel(
  context: BrowserContext,
  panelUrl: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = context.pages().find((candidate) => candidate.url().startsWith(panelUrl));
    if (page) {
      await page.waitForSelector('.shell, .onboarding-screen', {
        timeout: Math.max(1_000, deadline - Date.now()),
      });
      return page;
    }
    await delay(100);
  }
  const urls = context.pages().map((page) => page.url()).join(', ') || 'none';
  throw new Error(`The blibs panel did not load at ${panelUrl}. Open pages: ${urls}`);
}

/** Save a PNG screenshot and return its absolute path. */
export async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name.endsWith('.png') ? name : `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** Apply the light or dark token set on the panel root element. */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.dataset.theme = value;
  }, theme);
  // Let color transitions settle before a screenshot.
  await page.waitForTimeout(200);
}

/** Open the Settings view from the sidebar gear. */
export async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor({ timeout: 5_000 });
}

/** Choose a theme with the panel control and wait for the token set. */
export async function selectTheme(
  page: Page,
  preference: 'system' | 'light' | 'dark',
): Promise<void> {
  const theme = page.getByLabel('Theme');
  const opened = !(await theme.isVisible().catch(() => false));
  if (opened) await openSettings(page);
  await theme.selectOption(preference);
  if (preference === 'system') {
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === 'light'
        || document.documentElement.dataset.theme === 'dark',
    );
  } else {
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      preference,
    );
  }
  if (opened) {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
  }
  await page.waitForTimeout(200);
}

/** Storage key that the panel uses for its message map. */
export const MESSAGES_STORAGE_KEY = 'blibs-messages-v2';

/** Storage key that marks the first-run flow as complete. */
export const ONBOARDING_STORAGE_KEY = 'blibs-onboarding-v1';

/** Storage key that the panel uses for the connection state. */
export const CONNECTIONS_STORAGE_KEY = 'blibs-connections-v1';

/** Remove the saved onboarding result and load the first-run screen. */
export async function resetOnboarding(page: Page): Promise<void> {
  await page.evaluate((key) => localStorage.removeItem(key), ONBOARDING_STORAGE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.onboarding-screen').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Open the chat shell from the connections screen. */
export async function completeOnboarding(page: Page): Promise<void> {
  const screen = page.locator('.onboarding-screen');
  if (await screen.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Start chatting', exact: true }).click();
  }
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
}

export interface MockChatMessage {
  id: string;
  agentId: string;
  role: 'user' | 'agent';
  text: string;
  ts: number;
  source: 'mock';
  action?: {
    harness: 'claude-code' | 'codex' | 'opencode';
    status: 'completed' | 'running' | 'failed';
    detail: string;
  };
}

export type MockChats = Record<string, MockChatMessage[]>;

/** Deterministic sample chats for screenshots and UI checks. */
export function mockChats(now = Date.now()): MockChats {
  const minute = 60_000;
  return {
    muse: [
      {
        id: 'mock-muse-1',
        agentId: 'muse',
        role: 'agent',
        text: 'Your grocery order arrives between 6 and 7 p.m. I moved the drop-off to the side door.',
        ts: now - 52 * minute,
        source: 'mock',
      },
      {
        id: 'mock-muse-2',
        agentId: 'muse',
        role: 'user',
        text: 'Add oat milk if the store has it.',
        ts: now - 48 * minute,
        source: 'mock',
      },
      {
        id: 'mock-muse-3',
        agentId: 'muse',
        role: 'agent',
        text: 'Added oat milk. The total is $42.18 and the order stays on the same delivery window.',
        ts: now - 47 * minute,
        source: 'mock',
      },
      {
        id: 'mock-muse-4',
        agentId: 'muse',
        role: 'agent',
        text: '',
        ts: now - 46 * minute,
        source: 'mock',
        action: {
          harness: 'claude-code',
          status: 'completed',
          detail: 'Updated the login handler and ran 12 tests in ~/Projects/blibs.',
        },
      },
    ],
    dots: [
      {
        id: 'mock-dots-1',
        agentId: 'dots',
        role: 'user',
        text: 'Summarize the invoice thread from this morning.',
        ts: now - 33 * minute,
        source: 'mock',
      },
      {
        id: 'mock-dots-2',
        agentId: 'dots',
        role: 'agent',
        text: 'Three invoices are due Friday. Two match their purchase orders. The third one needs a corrected billing address.',
        ts: now - 31 * minute,
        source: 'mock',
      },
    ],
    grok: [
      {
        id: 'mock-grok-1',
        agentId: 'grok',
        role: 'agent',
        text: 'The deploy finished at 09:12. Health checks are green on both regions.',
        ts: now - 18 * minute,
        source: 'mock',
      },
      {
        id: 'mock-grok-2',
        agentId: 'grok',
        role: 'user',
        text: 'Keep the old cluster up until Monday.',
        ts: now - 16 * minute,
        source: 'mock',
      },
      {
        id: 'mock-grok-3',
        agentId: 'grok',
        role: 'agent',
        text: `Scheduled. I will hold the old cluster and remove it on Monday at 10:00. Reference: https://example.com/runs/atlas-migration/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa — the runbook has the rollback steps.`,
        ts: now - 15 * minute,
        source: 'mock',
      },
    ],
  };
}

/** Write mock chats into the panel store and reload the window. */
export async function seedChats(
  page: Page,
  chats: MockChats = mockChats(),
  connections: MockConnections = mockConnections(),
): Promise<void> {
  await page.evaluate(
    ({ messageKey, messages, connectionKey, connectionState }) => {
      localStorage.setItem(messageKey, JSON.stringify(messages));
      localStorage.setItem(connectionKey, JSON.stringify(connectionState));
    },
    {
      messageKey: MESSAGES_STORAGE_KEY,
      messages: chats,
      connectionKey: CONNECTIONS_STORAGE_KEY,
      connectionState: connections,
    },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
}

export type MockAssistantId = 'muse' | 'dots' | 'grok';
export type MockHarnessId = 'claude-code' | 'codex' | 'opencode';
export type MockSetup = 'connected' | 'setup';

export interface MockAction {
  id: string;
  assistantId: MockAssistantId;
  harness: MockHarnessId;
  title: string;
  detail: string;
  status: 'completed' | 'running' | 'failed';
  at: number;
}

export interface MockConnections {
  folder: string;
  assistants: Record<MockAssistantId, {
    setup: MockSetup;
    harnesses: Record<MockHarnessId, boolean>;
  }>;
  activity: MockAction[];
}

export interface MockConnectionsOptions {
  folder?: string;
  /** Connection state per assistant. Defaults to connected. */
  setup?: Partial<Record<MockAssistantId, MockSetup>>;
  /** Harness enablement per assistant. */
  harnesses?: Partial<Record<MockAssistantId, Partial<Record<MockHarnessId, boolean>>>>;
  activity?: MockAction[];
}

/** Deterministic connection state for screenshots and UI checks. */
export function mockConnections(options: MockConnectionsOptions = {}): MockConnections {
  const now = Date.now();
  const harnesses: MockConnections['assistants'] = {
    muse: { setup: 'connected', harnesses: { 'claude-code': true, codex: false, opencode: true } },
    dots: { setup: 'connected', harnesses: { 'claude-code': false, codex: true, opencode: true } },
    grok: { setup: 'connected', harnesses: { 'claude-code': true, codex: true, opencode: false } },
  };
  for (const id of Object.keys(harnesses) as MockAssistantId[]) {
    const setup = options.setup?.[id];
    if (setup) harnesses[id].setup = setup;
    const enabled = options.harnesses?.[id];
    if (enabled) Object.assign(harnesses[id].harnesses, enabled);
  }
  return {
    folder: options.folder ?? '~/Projects',
    assistants: harnesses,
    activity: options.activity ?? [
      {
        id: 'mock-action-1',
        assistantId: 'muse',
        harness: 'claude-code',
        title: 'Fixed login button',
        detail: 'Updated the login handler and ran 12 tests in ~/Projects/blibs.',
        status: 'completed',
        at: now - 10 * 60_000,
      },
      {
        id: 'mock-action-2',
        assistantId: 'muse',
        harness: 'codex',
        title: 'Reviewed README',
        detail: 'Checked the setup steps in ~/Projects/blibs/README.md.',
        status: 'completed',
        at: now - 120 * 60_000,
      },
    ],
  };
}

/** Write mock connection state into the panel store and reload the window. */
export async function seedConnections(
  page: Page,
  connections: MockConnections = mockConnections(),
): Promise<void> {
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: CONNECTIONS_STORAGE_KEY, value: connections },
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.shell').waitFor({ state: 'visible', timeout: 15_000 });
}

/** Select an assistant in the sidebar. */
export async function selectAgent(page: Page, name: string): Promise<void> {
  const assistant = page.locator('.agent-main', { hasText: name }).first();
  await assistant.click();
  await assistant.and(page.locator('[aria-current="page"]')).waitFor();
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    delay(5_000).then(() => false),
  ]);
  if (exited || child.exitCode !== null) return;
  child.kill('SIGKILL');
  await once(child, 'exit').catch(() => undefined);
}

/**
 * Build is a separate step. Launch Electron on free ports with a temporary
 * profile, connect Playwright over CDP, and wait for the panel.
 */
export async function launch(options: LaunchOptions = {}): Promise<E2EApp> {
  if (!displayAvailable()) throw new Error(NO_DISPLAY_MESSAGE);

  const timeoutMs = options.timeoutMs ?? 45_000;
  const [cdpPort, panelPort, backendPort] = await freePorts(3);
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const panelUrl = `http://127.0.0.1:${panelPort}`;
  const backendUrl = `http://127.0.0.1:${backendPort}`;

  const tempDir = mkdtempSync(path.join(tmpdir(), 'blibs-e2e-'));
  const profileDir = options.profileDir ?? path.join(tempDir, 'profile');
  const dataDir = path.join(tempDir, 'history');
  const projectsDir = path.join(tempDir, 'projects');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  // The relay runs the harness only after it matches a project.
  const fakeHarness = path.join(tempDir, 'fake-harness.mjs');
  writeFileSync(fakeHarness, `import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prompt = args.at(-1) || '';
if (prompt.endsWith('Create hello.txt with exactly Hello from blibs.')) {
  writeFileSync('hello.txt', 'Hello from blibs.');
}
const fileTask = /^Write (first|second)[.]txt with exactly (.+)$/.exec(prompt);
if (fileTask) {
  writeFileSync(fileTask[1] + '.txt', fileTask[2]);
  appendFileSync('session-runs.jsonl', JSON.stringify(args[args.indexOf('--session') + 1]) + '\\n');
}
process.stdout.write('harness reply: ' + (prompt.split('\\n').at(-1) || '') + '\\n');
`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BLIBS_DATA_DIR: dataDir,
    BLIBS_LEGACY_DIR: tempDir,
    BLIBS_NODE_PATH: process.execPath,
    BLIBS_RELAY_COMMAND: JSON.stringify([process.execPath, fakeHarness]),
    BLIBS_RELAY_PROJECTS_DIR: projectsDir,
    BLIBS_UI_PORT: String(panelPort),
    PROXY_PORT: String(backendPort),
  };
  if (options.relayCommand === null) {
    delete env.BLIBS_RELAY_COMMAND;
  } else if (options.relayCommand !== undefined) {
    env.BLIBS_RELAY_COMMAND = options.relayCommand;
  }
  if (options.projectsDir === null) delete env.BLIBS_RELAY_PROJECTS_DIR;
  else if (options.projectsDir !== undefined) env.BLIBS_RELAY_PROJECTS_DIR = options.projectsDir;
  if (options.mockLogin === false) delete env.BLIBS_MOCK_LOGIN;
  else env.BLIBS_MOCK_LOGIN = '1';
  delete env.BLIBS_NO_AUTOSTART;
  delete env.ELECTRON_RUN_AS_NODE;

  let appEntry = repoRoot;
  if (options.museChatHtml !== undefined) {
    appEntry = path.join(tempDir, 'mock-muse.cjs');
    writeFileSync(appEntry, `const { app, session } = require('electron');
const html = ${JSON.stringify(options.museChatHtml)};
app.whenReady().then(() => {
  session.fromPartition('persist:muse').protocol.handle('https', (request) => {
    if (new URL(request.url).hostname !== 'muse.ai') return new Response(null, { status: 404 });
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  require(${JSON.stringify(path.join(repoRoot, 'build', 'main', 'index.js'))});
});
`);
  }

  const child = spawn(
    electronPath,
    [appEntry, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const output = collectOutput(child);
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });

  let browser: Browser | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (browser) await browser.close().catch(() => undefined);
    await stopChild(child);
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Electron can hold cache files briefly on Windows.
    }
  };

  try {
    await waitForCdp(cdpUrl, child, output, timeoutMs, () => spawnError);
    browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Playwright connected to Electron, but found no browser context.');
    const page = await waitForPanel(context, panelUrl, timeoutMs);
    return {
      browser,
      context,
      page,
      panelUrl,
      backendUrl,
      cdpUrl,
      projectsDir,
      screenshot: (name: string) => screenshot(page, name),
      close,
    };
  } catch (error) {
    await close();
    const detail = output.length ? `\nElectron output:\n${output.join('\n')}` : '';
    throw new Error(`${(error as Error).message}${detail}`, { cause: error });
  }
}
