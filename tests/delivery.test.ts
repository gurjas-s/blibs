import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

async function sendInPage(accept: boolean) {
  class Editor {
    tagName = 'TEXTAREA';
    isContentEditable = false;
    private text = 'old draft';
    get value() { return this.text; }
    set value(value: string) { this.text = value; }
    focus() {}
    dispatchEvent() {}
    getBoundingClientRect() { return { width: 200, height: 40 }; }
  }
  const editor = new Editor();
  const button = { disabled: false, getBoundingClientRect: () => ({ width: 40, height: 40 }), click() { if (accept) editor.value = ''; } };
  let listener: (_event: unknown, message: { reqId: string; text: string }) => Promise<void>;
  let outcome: { ok: boolean; reason?: string } | undefined;
  vm.runInNewContext(readFileSync(new URL('../build/preload/agent.js', import.meta.url), 'utf8'), {
    exports: {}, location: { pathname: '/', hostname: 'chatgpt.com' },
    require: () => ({ ipcRenderer: {
      on(channel: string, callback: typeof listener) { if (channel === 'blibs:send') listener = callback; },
      send(channel: string, message: typeof outcome) { if (channel === 'blibs:send-result') outcome = message; },
    } }),
    document: {
      documentElement: {},
      querySelectorAll(selector: string) {
        if (selector.includes('contenteditable')) return [editor];
        if (selector === 'button[aria-label*="send" i]') return [button];
        return [];
      },
    },
    HTMLTextAreaElement: Editor,
    Event: class {}, InputEvent: class {},
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout(callback: () => void, delay: number) { if (delay === 100) queueMicrotask(callback); },
    setInterval() {}, MutationObserver: class { observe() {} },
  });
  await listener!(undefined, { reqId: 'test', text: 'new message' });
  return { outcome, editor };
}

test('delivery is acknowledged after the vendor clears its composer', async () => {
  const { outcome, editor } = await sendInPage(true);
  assert.equal(outcome?.ok, true);
  assert.equal(editor.value, '');
});

test('an ignored send action reports failure instead of a false Sent receipt', async () => {
  const { outcome, editor } = await sendInPage(false);
  assert.equal(outcome?.ok, false);
  assert.match(outcome?.reason || '', /did not accept/);
  assert.equal(editor.value, 'new message', 'the old draft was replaced');
});
