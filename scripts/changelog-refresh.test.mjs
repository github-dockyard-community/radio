import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptFile = path.join(root, 'scripts', 'fetch-changelog.mjs');
const extensionFile = path.join(root, '.github', 'extensions', 'changelog-reader', 'extension.mjs');
const appFile = path.join(root, '.github', 'extensions', 'changelog-reader', 'static', 'app.js');
const silentConsole = { log() {}, info() {}, error() {}, warn() {} };

const article = {
  id: 'test-update', title: 'Test update', titleJa: 'test translation',
  date: new Date().toISOString().slice(0, 10), translated: true,
  blocks: [{ id: 'b_0', tag: 'p', en: 'Test content', enText: 'Test content', ja: 'translated content' }]
};
const archived = { ...article, id: 'archived', date: '2000-01-01' };
const item = `<item><title>Test update</title><link>https://github.blog/changelog/test-update/</link>
<pubDate>${new Date().toUTCString()}</pubDate>
<content:encoded><![CDATA[<p>Test content</p>]]></content:encoded></item>`;
const feed = (items = item) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const rssResponse = body => new Response(body, { headers: { 'Content-Type': 'application/rss+xml' } });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});

// Evaluate the real modules with only SDK and cache I/O substituted; no user data is touched.
async function harness(t, fetchFeed, cache = JSON.stringify([article, archived]), overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-refresh-'));
  const cacheFile = path.join(directory, 'changelog-all.json');
  if (cache !== null) fs.writeFileSync(cacheFile, cache);
  const dataDirectory = path.join(root, 'data');
  const mapPath = value => typeof value === 'string' && value.startsWith(`${dataDirectory}${path.sep}`)
    ? path.join(directory, path.relative(dataDirectory, value)) : value;
  const mappedFs = { ...fs };
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'unlinkSync']) {
    mappedFs[name] = (file, ...args) => fs[name](mapPath(file), ...args);
  }
  mappedFs.renameSync = (from, to) => fs.renameSync(mapPath(from), mapPath(to));
  Object.assign(mappedFs, overrides);
  let registration;
  const context = vm.createContext({
    URL, Buffer, setTimeout, clearTimeout, setImmediate, process,
    console: silentConsole, fetch: url => fetchFeed(url, cacheFile)
  });
  const modules = new Map();
  const sdk = {
    createCanvas: value => value,
    joinSession: async value => { registration = value; return {}; }
  };
  async function load(specifier, referencing) {
    const id = specifier.startsWith('.') ? new URL(specifier, referencing.identifier).href : specifier;
    if (modules.has(id)) return modules.get(id);
    let module;
    if (id.startsWith('file:')) {
      module = new vm.SourceTextModule(fs.readFileSync(fileURLToPath(id), 'utf8'), {
        context, identifier: id, initializeImportMeta(meta) { meta.url = id; }
      });
      modules.set(id, module);
      await module.link(load);
    } else {
      const exports = id === '@github/copilot-sdk/extension' ? sdk
        : id === 'node:fs' ? { ...mappedFs, default: mappedFs } : await import(id);
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context, identifier: id });
      modules.set(id, module);
    }
    return module;
  }
  const script = await load(pathToFileURL(scriptFile).href);
  await script.evaluate();
  t.after(async () => {
    if (registration) await registration.canvases[0].onClose({ instanceId: 'test' });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    cacheFile, directory,
    fetchArticles: script.namespace.fetchAndSaveChangelog,
    async openServer() {
      const extension = await load(pathToFileURL(extensionFile).href);
      await extension.evaluate();
      const { url } = await registration.canvases[0].open({ instanceId: 'test' });
      const html = await (await fetch(url)).text();
      const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
      return { url, token };
    }
  };
}

test('valid RSS merges articles, keeps history and translations, and accepts later 404 as end', async t => {
  let calls = 0;
  const h = await harness(t, () => ++calls === 1 ? rssResponse(feed()) : new Response('404 Not Found', { status: 404 }));
  const result = await h.fetchArticles();
  assert.equal(calls, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].titleJa, article.titleJa);
  assert.equal(result[0].blocks[0].ja, article.blocks[0].ja);
  assert.equal(result[0].translated, true);
  assert.equal(result[1].id, archived.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.cacheFile, 'utf8')), JSON.parse(JSON.stringify(result)));
  assert.equal(fs.existsSync(`${h.cacheFile}.tmp`), false);
});

test('translation completed during RSS fetching is retained', async t => {
  const h = await harness(t, (_url, cacheFile) => {
    fs.writeFileSync(cacheFile, JSON.stringify([{ ...article, titleJa: 'new translation' }, archived]));
    return rssResponse(feed());
  });
  assert.equal((await h.fetchArticles({ maxPages: 1 }))[0].titleJa, 'new translation');
});

test('legacy cache is migrated without losing translations', async t => {
  const h = await harness(t, () => rssResponse(feed()), null);
  fs.writeFileSync(path.join(h.directory, 'changelog-2026-09.json'), JSON.stringify([article, archived]));
  const result = await h.fetchArticles({ maxPages: 1 });
  assert.equal(result[0].blocks[0].ja, article.blocks[0].ja);
  assert.equal(result.length, 2);
});

test('changed original text invalidates only its matching translation', async t => {
  const h = await harness(t, () => rssResponse(feed(item.replace('Test content', 'Changed content'))));
  const result = await h.fetchArticles({ maxPages: 1 });
  assert.equal(result[0].titleJa, article.titleJa);
  assert.equal(result[0].blocks[0].ja, '');
  assert.equal(result[0].translated, false);
  assert.equal(result[1].blocks[0].ja, archived.blocks[0].ja);
});

const failures = [
  ['first page HTTP 404', () => new Response('404 Not Found', { status: 404 }), /HTTP 404/],
  ['HTTP 503 HTML', () => new Response('<html>Unavailable</html>', { status: 503 }), /HTTP 503/],
  ['HTTP 200 HTML', () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }), /RSS XML.*text\/html/],
  ['HTTP 200 text', () => new Response('404 Not Found'), /RSS XML/],
  ['HTTP 200 JSON', () => jsonResponse({ error: 'blocked' }), /RSS XML.*application\/json/],
  ['non-RSS XML', () => rssResponse('<error>blocked</error>'), /RSS XML/],
  ['empty RSS', () => rssResponse(feed('')), /記事がありません/],
  ['truncated item', () => rssResponse(feed(item.replace('</item>', ''))), /記事XMLが不正/],
  ['invalid date', () => rssResponse(feed(item.replace(/<pubDate>.*?<\/pubDate>/, '<pubDate>invalid</pubDate>'))), /有効な日付/],
  ['missing content', () => rssResponse(feed(item.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, ''))), /記事本文/],
  ['network failure', () => { throw new Error('offline'); }, /offline/],
  ['body read failure', () => ({ ok: true, status: 200, text: async () => { throw new Error('disconnected'); } }), /本文.*disconnected/]
];
for (const [name, respond, expected] of failures) {
  test(`${name} reports cause and preserves cache bytes`, async t => {
    const h = await harness(t, respond);
    const before = fs.readFileSync(h.cacheFile, 'utf8');
    await assert.rejects(h.fetchArticles(), expected);
    assert.equal(fs.readFileSync(h.cacheFile, 'utf8'), before);
  });
}

test('second page failure discards partial refresh', async t => {
  let calls = 0;
  const h = await harness(t, () => ++calls === 1 ? rssResponse(feed()) : new Response('failure', { status: 500 }));
  const before = fs.readFileSync(h.cacheFile, 'utf8');
  await assert.rejects(h.fetchArticles(), /2.*HTTP 500/);
  assert.equal(fs.readFileSync(h.cacheFile, 'utf8'), before);
});

for (const cache of ['broken JSON', '{}']) {
  test(`invalid cache (${cache}) is not overwritten`, async t => {
    let fetched = false;
    const h = await harness(t, () => { fetched = true; return rssResponse(feed()); }, cache);
    await assert.rejects(h.fetchArticles(), /既存キャッシュ/);
    assert.equal(fetched, false);
    assert.equal(fs.readFileSync(h.cacheFile, 'utf8'), cache);
  });
}

test('failed atomic replacement preserves original cache', async t => {
  const h = await harness(t, () => rssResponse(feed()), undefined, {
    renameSync() { throw new Error('write denied'); }
  });
  const before = fs.readFileSync(h.cacheFile, 'utf8');
  await assert.rejects(h.fetchArticles({ maxPages: 1 }), /write denied/);
  assert.equal(fs.readFileSync(h.cacheFile, 'utf8'), before);
  assert.equal(fs.existsSync(`${h.cacheFile}.tmp`), false);
});

test('loopback refresh API returns JSON, enforces CSRF and reports unknown routes', async t => {
  let calls = 0;
  const h = await harness(t, () => ++calls === 1 ? rssResponse(feed()) : new Response('', { status: 404 }));
  const { url, token } = await h.openServer();
  const forbidden = await fetch(`${url}api/articles/refresh`, { method: 'POST' });
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json()).error, /CSRF/);
  assert.equal(calls, 0);
  const res = await fetch(`${url}api/articles/refresh`, { method: 'POST', headers: { 'X-CSRF-Token': token } });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.totalArticles, 2);
  assert.equal(result.addedCount, 0);
  assert.equal(result.articles[0].blocks[0].ja, article.blocks[0].ja);
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
  const unknown = await fetch(`${url}api/unknown`);
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /API/);
});

for (const cache of [undefined, 'broken JSON']) {
  test(`loopback refresh returns JSON 502 on ${cache ? 'cache' : 'RSS'} failure`, async t => {
    const h = await harness(t, () => new Response('failure', { status: 503 }), cache);
    const before = fs.readFileSync(h.cacheFile, 'utf8');
    const { url, token } = await h.openServer();
    const res = await fetch(`${url}api/articles/refresh`, { method: 'POST', headers: { 'X-CSRF-Token': token } });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, cache ? /既存キャッシュ/ : /HTTP 503/);
    assert.equal(fs.readFileSync(h.cacheFile, 'utf8'), before);
  });
}

async function runUi(response) {
  const button = { disabled: false };
  const status = { classList: { add() {}, remove() {} } };
  let request;
  const context = vm.createContext({
    console: silentConsole,
    document: {
      getElementById: id => id === 'btn-refresh-articles' ? button : id === 'refresh-status' ? status : null,
      querySelector: () => ({ getAttribute: () => 'csrf-test' })
    },
    fetch: async (url, options) => { request = { url, ...options }; return response; }
  });
  const source = fs.readFileSync(appFile, 'utf8').split(/\/\/ Init\r?\n/)[0];
  vm.runInContext(source, context);
  vm.runInContext(`allArticles = [{ id: 'cached', titleJa: 'keep translation' }];
    populateMonthSelector = () => {};
    applyPeriodFilter = () => {};`, context);
  await context.refreshArticles();
  assert.equal(button.disabled, false);
  assert.equal(request.url, '/api/articles/refresh');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-CSRF-Token'], 'csrf-test');
  return { status: status.textContent, articles: JSON.parse(vm.runInContext('JSON.stringify(allArticles)', context)) };
}

const uiFailures = [
  ['old server 404', () => new Response('404 Not Found', { status: 404 }), /HTTP 404.*再読み込み/],
  ['HTML HTTP error', () => new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }), /HTTP 502.*text\/html/],
  ['XML response', () => rssResponse(feed()), /JSON.*application\/rss\+xml/],
  ['invalid JSON', () => new Response('{"broken"', { headers: { 'Content-Type': 'application/json' } }), /不正なJSON/],
  ['structured API failure', () => jsonResponse({ error: 'RSS HTTP 503' }, 502), /RSS HTTP 503/],
  ['invalid success shape', () => jsonResponse(null), /記事一覧がありません/]
];
for (const [name, response, expected] of uiFailures) {
  test(`UI ${name} displays actionable error and keeps current articles`, async () => {
    const result = await runUi(response());
    assert.match(result.status, expected);
    assert.doesNotMatch(result.status, /Unexpected non-whitespace/);
    assert.deepEqual(result.articles, [{ id: 'cached', titleJa: 'keep translation' }]);
  });
}

test('UI success replaces list and displays counts without starting translation', async () => {
  const result = await runUi(jsonResponse({
    articles: [article], addedCount: 1, totalArticles: 1, updatedAt: new Date().toISOString()
  }));
  assert.match(result.status, /新着 1 件 \/ 全 1 件.*翻訳は未開始/);
  assert.deepEqual(result.articles, [article]);
});
