import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanImportText, messageParts, normalizeMessageText } from '../src/renderer/text.ts';

test('cleanImportText removes vendor labels and widgets without flattening formatting', () => {
  assert.equal(cleanImportText(' Assistant message: Hello\n\nworld  '), 'Hello\n\nworld');
  assert.equal(normalizeMessageText(' Assistant message: Hello\n\n [[hatch_widget:42]] world  '), 'hello world');
  assert.equal(cleanImportText('USER MESSAGE:  Hi'), 'Hi');
  assert.equal(cleanImportText('You: hello'), 'hello');
});

test('fenced code retains indentation and HTML stays plain message text', () => {
  const parts = messageParts('Example:\n```js\n  const x = "<script>";\n```\nDone.');
  assert.deepEqual(parts, [
    { kind: 'text', text: 'Example:\n' },
    { kind: 'code', language: 'js', text: '  const x = "<script>";' },
    { kind: 'text', text: 'Done.' },
  ]);
  assert.deepEqual(messageParts('```unfinished'), [{ kind: 'text', text: '```unfinished' }]);
});

test('cleanImportText keeps labels within a message and handles empty content', () => {
  assert.equal(cleanImportText('Tell me what you: think'), 'Tell me what you: think');
  assert.equal(cleanImportText(' [[widget]] '), '');
  assert.equal(cleanImportText(''), '');
});
