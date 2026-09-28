import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleProvider } from '../lib/google.mjs';

function mockFetch(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = original; });
}
const okJson = data => ({ ok: true, status: 200, json: async () => data });

test('text() posts to the model endpoint with API key and parses JSON', async t => {
  let seen;
  mockFetch(t, async (url, opts) => { seen = { url, opts }; return okJson({ candidates: [{ content: { parts: [{ text: '{"safe":true}' }] } }] }); });
  const g = new GoogleProvider('secret-key');
  assert.deepEqual(await g.text('gemini-2.5-flash', 'hello'), { safe: true });
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(seen.opts.headers['x-goog-api-key'], 'secret-key');
  assert.match(seen.opts.body, /hello/);
});

test('text() rejects API errors and empty responses', async t => {
  mockFetch(t, async () => ({ ok: false, status: 403 }));
  await assert.rejects(new GoogleProvider('k').text('m', 'p'), /Google API 403/);
  globalThis.fetch = async () => okJson({ candidates: [] });
  await assert.rejects(new GoogleProvider('k').text('m', 'p'), /boş veya engellendi/);
});

test('startVideo validates the operation name before trusting it', async t => {
  mockFetch(t, async () => okJson({ name: 'models/veo-3.1-fast-generate-preview/operations/abc-123' }));
  assert.equal(await new GoogleProvider('k').startVideo('veo-3.1-fast-generate-preview', 'p', { mimeType: 'image/png', data: 'AA==' }), 'models/veo-3.1-fast-generate-preview/operations/abc-123');
  globalThis.fetch = async () => okJson({ name: 'https://evil.example/steal?key=' });
  await assert.rejects(new GoogleProvider('k').startVideo('m', 'p', { mimeType: 'image/png', data: 'AA==' }), /işlem kimliği alınamadı/);
});

test('operation() refuses malformed IDs without calling the network', async t => {
  mockFetch(t, async () => { throw Error('network must not be called'); });
  await assert.rejects(new GoogleProvider('k').operation('//evil.example'), /Geçersiz işlem kimliği/);
});

test('modelInfo maps 404 to false and other failures to errors', async t => {
  mockFetch(t, async url => ({ ok: !url.includes('missing'), status: url.includes('missing') ? 404 : 200 }));
  const g = new GoogleProvider('k');
  assert.equal(await g.modelInfo('gemini-2.5-flash'), true);
  assert.equal(await g.modelInfo('missing-model'), false);
  await assert.rejects(g.modelInfo('../escape'), /Model adı geçersiz/);
  globalThis.fetch = async () => ({ ok: false, status: 400 });
  await assert.rejects(new GoogleProvider('k').modelInfo('m'), /Google API 400/);
});

test('download refuses redirects to non-Google hosts', async t => {
  mockFetch(t, async () => ({ status: 302, ok: false, headers: { get: () => 'https://evil.example/file.mp4' } }));
  await assert.rejects(new GoogleProvider('k').download('https://generativelanguage.googleapis.com/x', '/tmp/out.mp4'), /reddedildi/);
});
