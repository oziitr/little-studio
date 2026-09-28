import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, storyPrompt, sceneCountFor } from '../core.mjs';

test('projects require story or title and constrain scenes', () => {
  assert.throws(() => validateProject({ title: ' ', idea: '' }));
  const p = validateProject({ title: 'Milo', language: 'bad', age: 'bad', scenes: Array(30).fill({ visual: 'tree', duration: 999 }), madeForKids: false });
  assert.equal(p.scenes.length, 12);
  assert.equal(p.language, 'en');
  assert.equal(p.age, '6-8');
  assert.equal(p.madeForKids, true);
  assert.equal(p.scenes[0].duration, 8);
});

test('idea alone derives a title', () => {
  const p = validateProject({ idea: 'A curious fox named Milo looks for his star.' });
  assert.match(p.title, /curious fox|Milo/i);
  assert.equal(p.length, 'short');
  assert.equal(p.sceneCount, 3);
});

test('short and long map to 3 and 6 scenes', () => {
  assert.equal(sceneCountFor('short'), 3);
  assert.equal(sceneCountFor('long'), 6);
  assert.equal(validateProject({ title: 'T', length: 'short' }).sceneCount, 3);
  assert.equal(validateProject({ title: 'T', length: 'long' }).sceneCount, 6);
  assert.equal(validateProject({ title: 'T', sceneCount: 99 }).sceneCount, 12);
  assert.equal(validateProject({ title: 'T', sceneCount: 1 }).sceneCount, 3);
});

test('story prompt includes language, character and exact scene count', () => {
  const prompt = storyPrompt(validateProject({ title: 'Test', language: 'tr', character: 'Milo', age: '3-5', length: 'long' }));
  assert.match(prompt, /Turkish/i);
  assert.match(prompt, /Milo/);
  assert.match(prompt, /ages 3-5/);
  assert.match(prompt, /exactly 6 scenes/i);
  assert.doesNotMatch(prompt, /Yalnızca ham JSON/);
  const en = storyPrompt(validateProject({ title: 'Test', language: 'en', length: 'short' }));
  assert.match(en, /English only/i);
  assert.match(en, /exactly 3 scenes/i);
});
