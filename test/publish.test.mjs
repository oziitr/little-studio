import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { defaults } from '../lib/config.mjs';
import { YouTube } from '../lib/youtube.mjs';
import { publishTick, normalizePublishSchedule } from '../lib/publish.mjs';
import { validateProject } from '../core.mjs';

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-pub-'));
  const store = openStore(dir);
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test('normalizePublishSchedule clamps interval and mode', () => {
  assert.equal(normalizePublishSchedule({ intervalHours: 0 }).intervalHours, 2);
  assert.equal(normalizePublishSchedule({ intervalHours: 0.4 }).intervalHours, 1);
  assert.equal(normalizePublishSchedule({ mode: 'per_account' }).mode, 'per_account');
  assert.equal(normalizePublishSchedule({ mode: 'x' }).mode, 'global');
});

test('publishTick global queues one ready video and advances nextAt', async t => {
  const s = fixture(t);
  s.setSetting('config', {
    ...defaults,
    publishSchedule: { enabled: true, mode: 'global', intervalHours: 2, maxRuns: 3, runsDone: 0, nextAt: new Date(Date.now() - 1000).toISOString(), privacy: 'private' }
  });
  s.setSetting('youtubeAccounts', [{ id: 'acc1', label: 'A', tokens: { refresh_token: 'r' }, active: true, schedule: { enabled: false, intervalHours: 2, maxRuns: 0, runsDone: 0, nextAt: null } }]);
  const id = 'a'.repeat(24);
  const p = validateProject({ title: 'Hazır', idea: 'x', scenes: [{ visual: 'a', motion: 'b' }] });
  p.output = { file: 'r/output.mp4', bytes: 3 };
  p.pool = { status: 'ready' };
  s.save(id, p);
  const media = path.join(s.directory, 'media', id, 'r');
  mkdirSync(media, { recursive: true });
  writeFileSync(path.join(media, 'output.mp4'), 'abc');

  const yt = new YouTube(s);
  const queued = [];
  const enqueue = (project, kind, input) => { queued.push({ id: project.id, kind, input }); return { id: 'job1' }; };
  const r = await publishTick(s, yt, enqueue);
  assert.equal(r.queued, 1);
  assert.equal(queued[0].kind, 'upload');
  const c = s.setting('config');
  assert.equal(c.publishSchedule.runsDone, 1);
  assert.ok(new Date(c.publishSchedule.nextAt).getTime() > Date.now());
});

test('publishTick per_account uses account schedule and saves it', async t => {
  const s = fixture(t);
  s.setSetting('config', {
    ...defaults,
    publishSchedule: { enabled: true, mode: 'per_account', intervalHours: 2, maxRuns: 0, runsDone: 0, nextAt: null, privacy: 'private' }
  });
  s.setSetting('youtubeAccounts', [{
    id: 'acc9', label: 'B', tokens: { refresh_token: 'r' }, active: true,
    schedule: { enabled: true, intervalHours: 1, maxRuns: 2, runsDone: 0, nextAt: new Date(Date.now() - 1000).toISOString() }
  }]);
  const id = 'b'.repeat(24);
  const p = validateProject({ title: 'Hazır2', idea: 'y', scenes: [{ visual: 'a', motion: 'b' }] });
  p.output = { file: 'r/output.mp4', bytes: 3 };
  p.pool = { status: 'ready' };
  s.save(id, p);

  const yt = new YouTube(s);
  const queued = [];
  const enqueue = (project, kind, input) => { queued.push({ project: project.id, kind, account: input.account }); return {}; };
  const r = await publishTick(s, yt, enqueue);
  assert.equal(r.queued, 1);
  assert.equal(queued[0].account, 'acc9');
  const acc = yt.accounts()[0];
  assert.equal(acc.schedule.runsDone, 1);
  assert.ok(acc.schedule.nextAt);
});
