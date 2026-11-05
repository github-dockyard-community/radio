import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchChangelogArticles, fetchAndSaveChangelog, mergeChangelogArticles } from './fetch-changelog.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionFile = path.join(root, '.github', 'extensions', 'changelog-reader', 'extension.mjs');
const appFile = path.join(path.dirname(extensionFile), 'static', 'app.js');
const month = new Date().toISOString().slice(0, 7);
const original = {
  id: 'test-update', title: 'Test update', titleJa: '', date: `${month}-10`,
  translated: false, category: 'Actions',
  blocks: [{ id: 'b_0', tag: 'p', en: '<p>Test content</p>', enText: 'Test content', ja: '' }]
};
const item = `<item><title>Test update</title><link>https://github.blog/changelog/test-update/</link>
<pubDate>${new Date().toUTCString()}</pubDate>
<content:encoded><![CDATA[<p>Test content</p>]]></content:encoded></item>`;
const feed = (items = item) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const response = body => new Response(body, { headers: { 'Content-Type': 'application/rss+xml' } });
const tick = () => new Promise(setImmediate);
const silentConsole = { log() {}, info() {}, error() {}, warn() {} };
const put = (directory, name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data));

// Run the actual extension, substituting only its SDK, network, and repository data paths.
async function harness(t, { fetchFeed = () => response(feed()), articles = [original], overrides = {}, send } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-api-'));
  put(directory, 'changelog-storage.json', { version: 1, format: 'monthly' });
  const grouped = Map.groupBy(articles, value => value.date.slice(0, 7));
  for (const [ym, rows] of grouped) put(directory, `${ym}.json`, rows);
  const sourceData = path.join(root, 'data');
  const sourceTasks = path.join(path.dirname(extensionFile), '.tasks');
  const mapPath = value => {
    if (typeof value !== 'string') return value;
    for (const [from, to] of [[sourceData, directory], [sourceTasks, path.join(directory, 'tasks')]]) {
      if (value === from || value.startsWith(`${from}${path.sep}`)) return path.join(to, path.relative(from, value));
    }
    return value;
  };
  const mappedFs = { ...fs, promises: { ...fs.promises, readFile: (file, ...args) => fs.promises.readFile(mapPath(file), ...args) } };
  for (const name of ['existsSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'unlinkSync', 'rmdirSync',
    'openSync', 'realpathSync', 'statSync', 'accessSync', 'readdirSync']) {
    mappedFs[name] = (file, ...args) => fs[name](mapPath(file), ...args);
  }
  mappedFs.renameSync = (from, to) => fs.renameSync(mapPath(from), mapPath(to));
  Object.assign(mappedFs, overrides);
  let registration, server;
  const sent = [], timers = new Map(), modules = new Map();
  const context = vm.createContext({
    URL, Buffer, structuredClone, setImmediate, console: silentConsole,
    setTimeout(callback, delay, ...args) {
      const timer = setTimeout(callback, delay, ...args);
      if (delay === 300000) timers.set(timer, callback);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    process: { ...process, env: { ...process.env, COPILOT_HOME: path.join(directory, '.copilot') } },
    fetch: url => fetchFeed(url)
  });
  const sdk = {
    createCanvas: value => value,
    joinSession: async value => {
      registration = value;
      return { setModel: async () => {}, send: async value => { sent.push(value); await send?.(value); } };
    }
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
      const exports = id === '@github/copilot-sdk/extension' ? sdk : id === 'node:fs'
        ? { ...mappedFs, default: mappedFs } : await import(id);
      module = new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
      }, { context, identifier: id });
      modules.set(id, module);
    }
    return module;
  }
  const extension = await load(pathToFileURL(extensionFile).href);
  await extension.evaluate();
  const { url } = await registration.canvases[0].open({ instanceId: 'test' });
  const html = await (await fetch(url)).text();
  server = { url, token: html.match(/name="csrf-token" content="([^"]+)"/)[1] };
  const h = {
    directory, sent, html, url,
    async get(endpoint) { return fetch(`${url}${endpoint}`); },
    async state() { return (await this.get('api/storage')).json(); },
    async post(endpoint, body = {}, bind = true) {
      const state = bind ? await this.state() : {};
      return fetch(`${url}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': server.token },
        body: JSON.stringify({ storageGeneration: state.storageGeneration, dataRevision: state.dataRevision, ...body })
      });
    },
    async job(initial) {
      let value = await initial.json();
      for (let count = 0; count < 2000 && value.status === 'running'; count++) {
        await tick();
        value = await (await this.get(`api/storage/jobs/${value.id}`)).json();
      }
      assert.equal(value.status, 'completed', value.error);
      return value.result;
    },
    async detail(id = original.id) { return (await (await this.get(`api/articles/${id}`)).json()).article; },
    requestId(index = sent.length - 1) { return sent[index].prompt.match(/requestId="([^"]+)"/)[1]; },
    save(requestId = this.requestId(), args = {}) {
      return registration.tools[0].handler({
        requestId, articleId: original.id, titleJa: 'Translated title',
        blocks: [{ id: 'b_0', ja: 'Translated content' }], ...args
      });
    },
    async expire() {
      for (const [timer, callback] of timers) { clearTimeout(timer); timers.delete(timer); callback(); }
      await tick();
    }
  };
  t.after(async () => {
    await h.post('api/queue/clear');
    for (const timer of timers.keys()) clearTimeout(timer);
    await registration.canvases[0].onClose({ instanceId: 'test' });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (let count = 0; count < 2000; count++) {
    if (!(await h.state()).progress) break;
    await tick();
  }
  return h;
}

for (const [name, respond, expected] of [
  ['HTTP 404', () => new Response('Not found', { status: 404 }), /HTTP 404/],
  ['HTTP 503', () => new Response('<html>Unavailable</html>', { status: 503 }), /HTTP 503/],
  ['HTML', () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }), /RSS XML/],
  ['text', () => new Response('Not RSS'), /RSS XML/],
  ['JSON', () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }), /RSS XML/],
  ['non-RSS XML', () => response('<error>blocked</error>'), /RSS XML/],
  ['empty RSS', () => response(feed('')), /記事がありません/],
  ['truncated XML', () => response(feed(item.replace('</item>', ''))), /記事XMLが不正/],
  ['invalid date', () => response(feed(item.replace(/<pubDate>.*?<\/pubDate>/, '<pubDate>invalid</pubDate>'))), /有効な日付/],
  ['missing body', () => response(feed(item.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, ''))), /記事本文/],
  ['network error', () => { throw new Error('offline'); }, /offline/],
  ['body read error', () => ({ ok: true, status: 200, text: async () => { throw new Error('disconnected'); } }), /disconnected/]
]) {
  test(`RSS ${name} surfaces its cause`, async t => {
    t.mock.method(globalThis, 'fetch', respond);
    await assert.rejects(fetchChangelogArticles(), expected);
  });
}

test('RSS parser deduplicates overlapping pages and accepts later 404 only as terminator', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => ++calls <= 2 ? response(feed()) : new Response('', { status: 404 }));
  const articles = await fetchChangelogArticles();
  assert.equal(articles.length, 1);
  assert.equal(calls, 3);
});

test('changed original invalidates only the matching block translation and preserves history', () => {
  const translated = { ...original, translated: true, titleJa: 'Translated', blocks: [{ ...original.blocks[0], ja: 'Existing' }] };
  const archived = { ...translated, id: 'archived', date: '2000-01-01' };
  const changed = { ...original, blocks: [{ ...original.blocks[0], enText: 'Changed' }] };
  const merged = mergeChangelogArticles([translated, archived], [changed]);
  assert.equal(merged.find(value => value.id === original.id).translated, false);
  assert.equal(merged.find(value => value.id === original.id).blocks[0].ja, '');
  assert.equal(merged.find(value => value.id === 'archived').blocks[0].ja, 'Existing');
});

test('CLI writes monthly data in the explicit directory and leaves global settings alone', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => response(feed()));
  const state = await fetchAndSaveChangelog({ dataDirectory: directory, maxPages: 1 });
  assert.equal(state.summary.articleCount, 1);
  assert.equal(fs.existsSync(path.join(directory, `${month}.json`)), true);
  assert.equal(fs.existsSync(path.join(directory, '.changelog-cache', 'cli-settings-unused.json')), false);
});

test('API state and summary pages never contain bodies, detail is separate, GET never fetches RSS', async t => {
  let fetched = 0;
  const h = await harness(t, { fetchFeed: () => { fetched++; throw new Error('No implicit RSS'); } });
  const state = await h.state();
  assert.equal(state.apiVersion, 3);
  assert.equal(Object.hasOwn(state, 'articles'), false);
  const page = await (await h.get('api/articles?period=all-time')).json();
  assert.equal(page.articles.length, 1);
  assert.equal(Object.hasOwn(page.articles[0], 'blocks'), false);
  assert.equal((await h.detail()).blocks.length, 1);
  assert.equal(fetched, 0);
});

test('refresh enforces CSRF, validates version, and unknown routes are explicit errors', async t => {
  const h = await harness(t);
  assert.equal((await fetch(`${h.url}api/articles/refresh`, { method: 'POST' })).status, 403);
  const refreshed = await h.post('api/articles/refresh');
  assert.equal(refreshed.status, 200);
  const result = await refreshed.json();
  assert.equal(result.apiVersion, 3);
  assert.equal(Array.isArray(result.months), true);
  assert.equal(Object.hasOwn(result, 'articles'), false);
  assert.equal((await h.get('api/unknown')).status, 404);
});

test('second-page RSS errors and external edits preserve stored files', async t => {
  let calls = 0;
  const h = await harness(t, { fetchFeed: () => ++calls === 1 ? response(feed()) : new Response('', { status: 500 }) });
  const file = path.join(h.directory, `${month}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const result = await h.post('api/articles/refresh');
  assert.equal(result.status, 502);
  assert.match((await result.json()).error, /2.*HTTP 500/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('external changes made during RSS fetching are rejected without overwriting them', async t => {
  let directory, calls = 0;
  const h = await harness(t, { fetchFeed: () => {
    if (++calls > 1) return new Response('', { status: 404 });
    fs.appendFileSync(path.join(directory, `${month}.json`), '\n');
    return response(feed());
  } });
  directory = h.directory;
  const result = await h.post('api/articles/refresh');
  assert.equal(result.status, 409);
  assert.match((await result.json()).error, /外部で更新/);
  assert.equal(fs.readFileSync(path.join(directory, `${month}.json`), 'utf8').endsWith('\n'), true);
});

test('batch preview counts the entire period, fixes ordering, and blocks switching while paused', async t => {
  const articles = Array.from({ length: 60 }, (_, index) => ({ ...original, id: `id-${String(index).padStart(2, '0')}` }));
  const h = await harness(t, { articles });
  const page = await (await h.get('api/articles?period=all-time')).json();
  assert.equal(page.articles.length, 50);
  await h.post('api/queue/pause');
  const preview = await (await h.post('api/queue/preview-batch', { period: 'all-time', order: 'oldest' })).json();
  assert.equal(preview.count, 60);
  const queued = await (await h.post('api/queue/enqueue-batch', { token: preview.token })).json();
  assert.equal(queued.status.queueLength, 60);
  assert.equal(queued.status.queue[0].articleId, 'id-59');
  const target = path.join(h.directory, 'target');
  fs.mkdirSync(target);
  assert.equal((await h.post('api/storage/preview', { dataDirectory: target })).status, 409);
  assert.equal((await h.post('api/storage/reload')).status, 409);
});

test('canceled and timed-out results are rejected, even after re-requesting the same article', async t => {
  const h = await harness(t);
  await h.post(`api/articles/${original.id}/request-translate`);
  const old = h.requestId();
  await h.post('api/queue/clear');
  await h.post(`api/articles/${original.id}/request-translate`);
  const next = h.requestId();
  assert.notEqual(old, next);
  assert.equal((await h.save(old)).resultType, 'failure');
  await h.expire();
  assert.equal((await h.save(next)).resultType, 'failure');
  await h.post(`api/articles/${original.id}/request-translate`);
  assert.match(await h.save(), /Successfully/);
  await tick();
  assert.equal((await h.detail()).translated, true);
  assert.equal((await (await h.get('api/queue/status')).json()).completedCount, 1);
});

test('translation completion requires full valid blocks and durable write', async t => {
  let fail = false;
  const h = await harness(t, { overrides: {
    renameSync(from, to) {
      if (fail && to.endsWith(`${month}.json`)) throw new Error('write denied');
      fs.renameSync(from, to);
    }
  } });
  await h.post(`api/articles/${original.id}/request-translate`);
  assert.equal((await h.save(undefined, { blocks: [] })).resultType, 'failure');
  fail = true;
  assert.equal((await h.save()).resultType, 'failure');
  assert.equal((await h.detail()).translated, false);
  assert.equal((await (await h.get('api/queue/status')).json()).completedCount, 0);
  fail = false;
  assert.match(await h.save(), /Successfully/);
});

test('send failure surfaces in queue status without saving a translation', async t => {
  const h = await harness(t, { send: () => { throw new Error('disconnected'); } });
  await h.post(`api/articles/${original.id}/request-translate`);
  await tick();
  const status = await (await h.get('api/queue/status')).json();
  assert.equal(status.failedCount, 1);
  assert.match(status.lastError, /disconnected/);
  assert.equal((await h.detail()).translated, false);
});

test('RSS pins the connection while preserving a legitimate translation completed during fetch', async t => {
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const h = await harness(t, { fetchFeed: async () => {
    if (++calls > 1) return new Response('', { status: 404 });
    started();
    await pending;
    return response(feed());
  } });
  const target = path.join(h.directory, 'target');
  fs.mkdirSync(target);
  const preview = await h.job(await h.post('api/storage/preview', { dataDirectory: target }));
  await h.post(`api/articles/${original.id}/request-translate`);
  const refreshing = h.post('api/articles/refresh');
  await began;
  assert.equal((await h.post('api/storage/switch', { token: preview.token, choice: 'overwrite' })).status, 409);
  assert.match(await h.save(), /Successfully/);
  release();
  assert.equal((await refreshing).status, 200);
  assert.equal((await h.detail()).blocks[0].ja, 'Translated content');
});

test('switch replaces UI context immediately and rejects old-generation mutations', async t => {
  const h = await harness(t);
  const before = await h.state();
  const target = path.join(h.directory, 'target');
  fs.mkdirSync(target);
  const preview = await h.job(await h.post('api/storage/preview', { dataDirectory: target }));
  const switched = await h.post('api/storage/switch', { token: preview.token, choice: 'use-destination' });
  const state = await switched.json();
  assert.equal(state.summary.articleCount, 0);
  assert.notEqual(state.storageGeneration, before.storageGeneration);
  for (const endpoint of ['api/articles/refresh', 'api/queue/enqueue-batch', `api/articles/${original.id}/request-translate`, 'api/settings', 'api/search/cancel']) {
    assert.equal((await h.post(endpoint, before, false)).status, 409);
  }
  assert.equal(fs.existsSync(path.join(target, 'changelog-storage.json')), false);
});

function uiHarness(fetchImpl = async () => { throw new Error('Unexpected request'); }) {
  const elements = new Map(), drawn = [];
  const node = () => ({
    value: '', hidden: false, disabled: false, textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, appendChild() {}, querySelectorAll: () => [], querySelector: () => node(),
    scrollIntoView() {}, focus() {}, setAttribute() {}, addEventListener() {}
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
    querySelector: selector => selector === 'meta[name="csrf-token"]' ? { getAttribute: () => 'token' } : node(),
    querySelectorAll: () => [], createElement: node, addEventListener() {}, documentElement: node(), body: node()
  };
  const context = vm.createContext({
    document, URLSearchParams, console: silentConsole, setTimeout, clearTimeout, fetch: fetchImpl,
    localStorage: { getItem() { return null; }, setItem() {} }, window: { matchMedia: () => ({ matches: false }) },
    drawn, alert() {}, confirm: () => true
  });
  vm.runInContext(fs.readFileSync(appFile, 'utf8').split('// Init')[0], context);
  vm.runInContext('renderArticle = article => drawn.push(article);', context);
  elements.get('period-selector').value = 'all-time';
  elements.get('category-filter').value = 'all';
  elements.get('status-filter').value = 'all';
  return { context, elements, drawn };
}
const uiState = (extra = {}) => ({
  apiVersion: 3, storageGeneration: 'gen', sequence: 0, dataRevision: 'rev', dataDirectory: 'C:\\data',
  useAutoEfficiency: true, months: [], format: 'monthly', progress: null,
  summary: { file: 'C:\\data', exists: true, articleCount: 0, translatedCount: 0, oldestDate: null, newestDate: null },
  ...extra
});

test('UI rejects old API and invalid shapes without assigning undefined storage paths', async () => {
  const h = uiHarness();
  h.context.input = { apiVersion: 2, articles: [] };
  await assert.rejects(vm.runInContext('applyStorageState(input, dataEpoch, ++dataRequestSequence)', h.context), /restart-session/);
  h.context.input = { apiVersion: 3 };
  await assert.rejects(vm.runInContext('applyStorageState(input, dataEpoch, ++dataRequestSequence)', h.context), /不正/);
  assert.notEqual(h.elements.get('storage-directory').value, undefined);
});

test('UI detail races discard older selections and the body cache stays at three articles', async () => {
  const resolvers = new Map();
  const h = uiHarness(url => new Promise(resolve => { resolvers.set(url, resolve); }));
  h.context.input = uiState();
  vm.runInContext(`storageState = input; filteredArticles = Array.from({length: 5}, (_, i) => ({id: String(i), title: String(i), titleJa: ''})); listTotal = 5;`, h.context);
  const first = vm.runInContext('selectArticle(0)', h.context);
  const second = vm.runInContext('selectArticle(1)', h.context);
  const finish = id => resolvers.get(`/api/articles/${id}`)(new Response(JSON.stringify({ ...uiState(), article: { id } })));
  finish('1'); await second;
  finish('0'); await first;
  assert.deepEqual(h.drawn.map(value => value.id), ['1']);
  for (const id of ['2', '3', '4']) {
    const request = vm.runInContext(`selectArticle(${id})`, h.context);
    finish(id); await request;
  }
  assert.equal(vm.runInContext('detailCache.size', h.context), 3);
});

test('UI data refresh keeps the selected article when it no longer matches the list filter', async () => {
  const h = uiHarness(async () => new Response(JSON.stringify({
    ...uiState({ dataRevision: 'next-rev', sequence: 1 }),
    articles: [{ id: 'newest', title: 'Newest', titleJa: '' }],
    total: 1, totalInPeriod: 1, translatedInPeriod: 0, nextCursor: null
  })));
  h.context.oldState = uiState({ dataRevision: 'old-rev' });
  vm.runInContext(`
    storageState = oldState;
    filteredArticles = [{ id: 'selected', title: 'Selected', titleJa: '' }];
    currentArticleIndex = 0;
    currentArticleId = 'selected';
  `, h.context);
  h.context.input = uiState({ dataRevision: 'next-rev', sequence: 1 });

  await vm.runInContext('applyStorageState(input, dataEpoch, ++dataRequestSequence)', h.context);

  assert.equal(vm.runInContext('currentArticleId', h.context), 'selected');
  assert.equal(vm.runInContext('currentArticleIndex', h.context), -1);
  assert.equal(h.drawn.length, 0);
});

test('UI data refresh keeps loaded pages and re-renders the open article in place', async () => {
  const requests = [];
  const pages = { first: ['a0', 'a1'], second: ['a2', 'a3'] };
  const summary = id => ({ id, title: id, titleJa: '' });
  const h = uiHarness(async url => {
    requests.push(url);
    if (url.startsWith('/api/articles/')) {
      return new Response(JSON.stringify({ ...uiState({ dataRevision: 'next-rev' }), article: { id: 'a3', translated: true } }));
    }
    const second = url.includes('cursor=c2');
    return new Response(JSON.stringify({
      ...uiState({ dataRevision: 'next-rev' }),
      articles: (second ? pages.second : pages.first).map(summary),
      total: 4, totalInPeriod: 4, translatedInPeriod: 1, nextCursor: second ? null : 'c2'
    }));
  });
  h.context.oldState = uiState({ dataRevision: 'old-rev' });
  h.context.articles = ['a0', 'a1', 'a2', 'a3'].map(summary);
  vm.runInContext(`
    storageState = oldState; filteredArticles = allArticles = articles;
    currentArticleIndex = 3; currentArticleId = 'a3'; articleBodyWrapper.scrollTop = 120;
  `, h.context);
  h.context.input = uiState({ dataRevision: 'next-rev', sequence: 1 });

  await vm.runInContext('applyStorageState(input, dataEpoch, ++dataRequestSequence)', h.context);

  assert.equal(vm.runInContext('filteredArticles.length', h.context), 4);
  assert.equal(vm.runInContext('currentArticleIndex', h.context), 3);
  assert.equal(vm.runInContext('articleBodyWrapper.scrollTop', h.context), 120);
  assert.deepEqual(h.drawn, [{ id: 'a3', translated: true }]);
});

test('UI search is explicit and refuses mutations before loading versioned state', async () => {
  const h = uiHarness();
  const source = fs.readFileSync(appFile, 'utf8');
  assert.doesNotMatch(source, /searchInput\.oninput/);
  assert.match(source, /searchInput\.onkeydown/);
  await assert.rejects(vm.runInContext("postApi('/api/settings')", h.context), /restart-session/);
});

test('UI delayed pages cannot restore the previous generation or overwrite a newer revision', async () => {
  const pending = [];
  const h = uiHarness(() => new Promise(resolve => pending.push(resolve)));
  h.context.first = uiState();
  const first = vm.runInContext('applyStorageState(first, dataEpoch, ++dataRequestSequence)', h.context);
  h.context.second = uiState({ storageGeneration: 'next', dataRevision: 'next-rev', sequence: 1, dataDirectory: 'C:\\next' });
  const second = vm.runInContext('applyStorageState(second, dataEpoch, ++dataRequestSequence)', h.context);
  const page = state => ({ ...state, articles: [], total: 0, totalInPeriod: 0, translatedInPeriod: 0, nextCursor: null });
  pending[1](new Response(JSON.stringify(page(h.context.second))));
  assert.equal(await second, true);
  pending[0](new Response(JSON.stringify(page(h.context.first))));
  assert.equal(await first, false);
  assert.equal(h.elements.get('storage-directory').value, 'C:\\next');
  h.context.third = uiState({ sequence: 0 });
  assert.equal(await vm.runInContext('applyStorageState(third, dataEpoch, ++dataRequestSequence)', h.context), false);
});
