import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comboFromEvent, formatCombo } from './commands.ts';

const key = (k: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

test('shortcuts are shown with the Mac symbols on a Mac', () => {
  assert.equal(formatCombo('Ctrl+S', false), 'Ctrl+S');
  assert.equal(formatCombo('Ctrl+S', true), '⌘S');
  assert.equal(formatCombo('Alt+Shift+ArrowLeft', true), '⌥⇧←');
  assert.equal(formatCombo('Ctrl++', true), '⌘+');
  assert.equal(formatCombo('Ctrl++', false), 'Ctrl++');
});

test('Cmd counts as Ctrl, and Option+letter is the letter on a Mac', () => {
  assert.equal(comboFromEvent(key('s', 'KeyS', { metaKey: true }), true), 'Ctrl+S');
  assert.equal(comboFromEvent(key('π', 'KeyP', { altKey: true }), true), 'Alt+P');
  assert.equal(comboFromEvent(key('π', 'KeyP', { altKey: true }), false), 'Alt+Π');
  assert.equal(comboFromEvent(key('ArrowLeft', 'ArrowLeft', { altKey: true }), true), 'Alt+ArrowLeft');
});
