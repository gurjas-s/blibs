import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanImportText, dedupeReplyMessages, isChoicesText, isHarnessReplyText, isIntroText } from '../src/renderer/text.ts';

test('cleanImportText removes vendor labels, widget tokens, and extra whitespace', () => {
  assert.equal(cleanImportText(' Assistant message: Hello\n\n [[hatch_widget:42]] world  '), 'Hello world');
  assert.equal(cleanImportText('USER MESSAGE:  Hi'), 'Hi');
  assert.equal(cleanImportText('You: hello'), 'hello');
  assert.equal(cleanImportText('Agent message: hi'), 'hi', 'the panel strips the same labels as the relay');
});

test('cleanImportText keeps labels within a message and handles empty content', () => {
  assert.equal(cleanImportText('Tell me what you: think'), 'Tell me what you: think');
  assert.equal(cleanImportText(' [[widget]] '), '');
  assert.equal(cleanImportText(''), '');
});

test('cleanImportText keeps the line breaks in a choice reply', () => {
  const text = cleanImportText('You:\n\nblibs choices\n\nOpenCode projects:\n- $alpha — /projects/alpha\n');
  assert.equal(text, 'blibs choices\n\nOpenCode projects:\n- $alpha — /projects/alpha');
});

test('cleanImportText keeps the line breaks in the introduction', () => {
  const text = cleanImportText('Assistant message: blibs introduction\n\nHow tagging works:\n- @opencode lists projects.');
  assert.equal(text, 'blibs introduction\n\nHow tagging works:\n- @opencode lists projects.');
});

test('isChoicesText finds the generated choice reply', () => {
  assert.equal(isChoicesText('blibs choices\n\nOpenCode projects:'), true);
  assert.equal(isChoicesText('  blibs choices'), true);
  assert.equal(isChoicesText('You:\n\nblibs choices'), true);
  assert.equal(isChoicesText('Muse choices'), false);
  assert.equal(isChoicesText(''), false);
});

test('isIntroText finds the generated blibs introduction', () => {
  assert.equal(isIntroText('blibs introduction blibs is a desktop control panel'), true);
  assert.equal(isIntroText('  blibs introduction'), true);
  assert.equal(isIntroText('Muse introduction'), false);
  assert.equal(isIntroText(''), false);
});

test('isHarnessReplyText finds the harness header', () => {
  assert.equal(isHarnessReplyText("Sent from user's harness (OpenCode).\n\ndone"), true);
  assert.equal(isHarnessReplyText("You:\n\nSent from user's harness (OpenCode).\n\ndone"), true);
  assert.equal(isHarnessReplyText('A normal message'), false);
});

test('dedupeReplyMessages removes repeated blibs and harness replies', () => {
  const items = [
    { role: 'agent', text: 'blibs introduction\n\nblibs is a desktop control panel' },
    { role: 'agent', text: 'You:\n\nblibs introduction\n\nblibs is a desktop control panel' },
    { role: 'agent', text: 'blibs choices\n\nOpenCode projects:\n- $alpha' },
    { role: 'agent', text: 'You:\n\nblibs choices\n\nOpenCode projects:\n- $alpha' },
    { role: 'agent', text: "Sent from user's harness (OpenCode).\n\ndone" },
    { role: 'agent', text: "You:\n\nSent from user's harness (OpenCode).\n\ndone" },
    { role: 'user', text: 'done' },
    { role: 'agent', text: 'A normal assistant message' },
  ];
  assert.deepEqual(
    dedupeReplyMessages(items).map((item) => item.text),
    [
      'blibs introduction\n\nblibs is a desktop control panel',
      'blibs choices\n\nOpenCode projects:\n- $alpha',
      "Sent from user's harness (OpenCode).\n\ndone",
      'done',
      'A normal assistant message',
    ],
  );
});
