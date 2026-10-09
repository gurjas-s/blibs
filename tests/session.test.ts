import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import type { SessionReport } from '../src/preload/agent.ts';

function sessionPage({ pathname = '/', hostname = 'chatgpt.com', composer = false, login = false, account = false, hidden = false } = {}) {
  const element = {
    textContent: '',
    getBoundingClientRect: () => ({ width: hidden ? 0 : 100, height: hidden ? 0 : 30 }),
  };
  const exports: { detectSession?: () => SessionReport } = {};
  vm.runInNewContext(readFileSync(new URL('../build/preload/agent.js', import.meta.url), 'utf8'), {
    exports,
    require: () => ({ ipcRenderer: { on() {}, send() {} } }),
    location: { pathname, hostname },
    document: {
      documentElement: {},
      querySelectorAll(selector: string) {
        if (selector.includes('profile-button') && account) return [element];
        if (selector.includes('login-button') && login) return [element];
        if (selector.includes('contenteditable') && composer) return [element];
        return [];
      },
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout() {}, setInterval() {},
    MutationObserver: class { observe() {} },
  });
  return exports.detectSession!();
}

test('explicit login redirects and walls require sign-in, including guest composers', () => {
  assert.equal(sessionPage({ pathname: '/auth/login' }).state, 'signed-out');
  assert.equal(sessionPage({ hostname: 'auth.openai.com' }).state, 'signed-out');
  assert.equal(sessionPage({ login: true, composer: true }).state, 'signed-out');
});

test('saved sessions resume and empty or hidden pages stay pending', () => {
  assert.equal(sessionPage({ composer: true }).state, 'ready');
  assert.equal(sessionPage({ account: true, login: true }).state, 'ready');
  assert.equal(sessionPage().state, 'loading');
  assert.equal(sessionPage({ composer: true, hidden: true }).state, 'loading');
  assert.equal(sessionPage({ hostname: 'fakechatgpt.com', composer: true }).state, 'error');
});
