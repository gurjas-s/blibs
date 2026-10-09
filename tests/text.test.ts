import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanImportText } from '../src/renderer/text.ts';

test('cleanImportText removes vendor labels, widget tokens, and extra whitespace', () => {
  assert.equal(cleanImportText(' Assistant message: Hello\n\n [[hatch_widget:42]] world  '), 'Hello world');
  assert.equal(cleanImportText('USER MESSAGE:  Hi'), 'Hi');
  assert.equal(cleanImportText('You: hello'), 'hello');
});

test('cleanImportText keeps labels within a message and handles empty content', () => {
  assert.equal(cleanImportText('Tell me what you: think'), 'Tell me what you: think');
  assert.equal(cleanImportText(' [[widget]] '), '');
  assert.equal(cleanImportText(''), '');
});
