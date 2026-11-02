import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MonthlyStorage } from '../.github/extensions/changelog-reader/monthly-storage.mjs';
import { directoryGate, transact, recover, pendingOperation, MARKER } from '../.github/extensions/changelog-reader/monthly-transactions.mjs';
import { fileRevision, sourceFingerprint } from '../.github/extensions/changelog-reader/storage.mjs';
import { mergeChangelogArticles, fetchAndSaveChangelog } from './fetch-changelog.mjs';

const article = (month, id = month, extra = {}) => ({
  id, date: `${month}-10`, title: `Title ${id}`, titleJa: '', category: 'Actions',
  translated: false, blocks: [{ id: 'b_0', en: '<p>English</p>', enText: 'English', ja: '' }], ...extra
});
const write = (directory, name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const marker = directory => write(directory, MARKER, { version: 1, format: 'monthly' });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-monthly-'));
  const directory = path.join(root, 'data');
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const settingsPath = path.join(root, 'settings.json');
  const store = (options = {}) => new MonthlyStorage({ defaultDirectory: directory, settingsPath, ...options });
  return { root, directory, settingsPath, store };
}
async function jobResult(store, job) {
  for (let count = 0; count < 2000; count++) {
    const state = store.jobStatus(job.id);
    if (state.status !== 'running') {
      if (state.status !== 'completed') throw new Error(state.error || state.status);
      return state.result;
    }
    await new Promise(setImmediate);
  }
  throw new Error('Job did not finish');
}
async function migrate(store, dataDirectory) {
  const context = store.responseContext();
  const preview = await jobResult(store, store.previewMigration({ ...context, dataDirectory }));
  return jobResult(store, store.migrate({ ...context, token: preview.token }));
}
const translate = (store, month, id = month) => store.saveTranslation({
  articleId: id, titleJa: 'Japanese title', blocks: [{ id: 'b_0', ja: 'Japanese content' }]
}, { storageGeneration: store.storageGeneration, month, fingerprint: sourceFingerprint(store.article(id).article) });

test('120-month indexed startup, polling, summaries and pagination read no month bodies', async t => {
  const f = fixture(t);
  marker(f.directory);
  for (let index = 0; index < 120; index++) {
    const month = `${2017 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
    write(f.directory, `${month}.json`, [article(month)]);
  }
  const initial = f.store();
  await initial.init();
  const read = fs.readFileSync;
  const reads = [];
  fs.readFileSync = (file, ...args) => {
    if (/^\d{4}-\d{2}\.json$/.test(path.basename(String(file)))) reads.push(file);
    return read(file, ...args);
  };
  try {
    const store = f.store();
    await store.init();
    assert.equal(store.state().months.length, 120);
    for (let index = 0; index < 5; index++) store.state();
    const first = store.list({ period: 'all-time' });
    assert.equal(first.articles.length, 50);
    assert.equal(first.total, 120);
    assert.ok(first.articles.every(value => !Object.hasOwn(value, 'blocks')));
    const second = store.list({ period: 'all-time', cursor: first.nextCursor });
    const third = store.list({ period: 'all-time', cursor: second.nextCursor });
    assert.equal(third.articles.length, 20);
    assert.equal(new Set([...first.articles, ...second.articles, ...third.articles].map(value => value.id)).size, 120);
    assert.deepEqual(reads, []);
    store.article('2026-12');
    assert.deepEqual(reads.map(value => path.basename(value)), ['2026-12.json']);
    for (const month of ['2026-11', '2026-10', '2026-09']) store.article(month);
    assert.equal(store.bodies.size, 3);
    assert.equal(store.bodies.has('2026-12'), false);
  } finally { fs.readFileSync = read; }
});

test('missing or corrupt index is regenerated from monthly source', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', [article('2026-09')]);
  const store = f.store();
  await store.init();
  fs.writeFileSync(path.join(f.directory, '.changelog-cache', 'index.json'), 'broken');
  const reopened = f.store();
  await reopened.init();
  assert.equal(reopened.metadata().length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '.changelog-cache', 'index.json'))).version, 1);
});

test('migration requires preview, preserves complete articles and exact archived bytes', async t => {
  const f = fixture(t);
  const originals = [article('2026-09', 'slug-with-a-different-date', {
    translated: true, titleJa: '日本語', blocks: [{ id: 'b_0', en: '<p>Text</p>', enText: 'Text', ja: '訳文' }]
  }), article('2025-01')];
  const bytes = JSON.stringify(originals, null, 4) + '\n';
  fs.writeFileSync(path.join(f.directory, 'changelog-all.json'), bytes);
  const store = f.store();
  await store.init();
  assert.equal(store.state().format, 'legacy');
  assert.throws(() => store.list(), /移行/);
  assert.throws(() => store.migrate(store.responseContext()), /確認/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'changelog-all.json'), 'utf8'), bytes);
  await migrate(store);
  assert.equal(store.state().format, 'monthly');
  assert.deepEqual(store.article(originals[0].id).article, originals[0]);
  assert.equal(fs.existsSync(path.join(f.directory, 'changelog-all.json')), false);
  const archives = fs.readdirSync(path.join(f.directory, '.changelog-legacy'));
  assert.equal(fs.readFileSync(path.join(f.directory, '.changelog-legacy', archives[0]), 'utf8'), bytes);
  assert.equal(store.state().summary.monthCount, 2);
});

for (const [name, files, pattern] of [
  ['duplicate IDs across months', { '2026-09.json': [article('2026-09', 'same')], '2026-10.json': [article('2026-10', 'same')] }, /重複/],
  ['invalid month assignment', { '2026-09.json': [article('2026-10')] }, /一致/],
  ['sync conflict filenames', { '2026-09-conflict.json': [] }, /競合/],
  ['invalid dates', { '2026-09.json': [article('2026-09', 'bad', { date: '2026-09-31' })] }, /不正/],
]) {
  test(`${name} are rejected without repair or writes`, async t => {
    const f = fixture(t);
    marker(f.directory);
    for (const [file, value] of Object.entries(files)) write(f.directory, file, value);
    const before = fs.readdirSync(f.directory);
    await assert.rejects(f.store().init(), pattern);
    assert.deepEqual(fs.readdirSync(f.directory), before);
  });
}

test('single-month translation leaves other files byte-identical and rejects stale source/generation', async t => {
  const f = fixture(t);
  marker(f.directory);
  for (const month of ['2026-09', '2026-10']) write(f.directory, `${month}.json`, [article(month)]);
  const store = f.store();
  await store.init();
  const before = fs.readFileSync(path.join(f.directory, '2026-09.json'), 'utf8');
  const originalGeneration = store.storageGeneration;
  translate(store, '2026-10');
  assert.equal(fs.readFileSync(path.join(f.directory, '2026-09.json'), 'utf8'), before);
  assert.equal(store.article('2026-10').article.blocks[0].ja, 'Japanese content');
  assert.throws(() => store.saveTranslation({ articleId: '2026-10' }, {
    month: '2026-10', fingerprint: 'bad', storageGeneration: originalGeneration
  }), /原文/);
  await store.reload();
  assert.throws(() => store.saveTranslation({}, { storageGeneration: originalGeneration }), /保存先/);
});

test('unrelated external month changes remain detectable after an in-process save', async t => {
  const f = fixture(t);
  marker(f.directory);
  for (const month of ['2026-09', '2026-10']) write(f.directory, `${month}.json`, [article(month)]);
  const store = f.store();
  await store.init();
  fs.appendFileSync(path.join(f.directory, '2026-09.json'), '\n');
  translate(store, '2026-10');
  assert.equal(store.state().externallyChanged, true);
  assert.throws(() => store.list(), /外部/);
  fs.appendFileSync(path.join(f.directory, '2026-10.json'), '\n');
  assert.throws(() => translate(store, '2026-10'), /外部/);
});

test('RSS updates affected months only, preserves translations, and moves IDs across months', async t => {
  const f = fixture(t);
  marker(f.directory);
  const original = article('2026-09', 'moving', { translated: true, titleJa: 'Existing', blocks: [{ id: 'b_0', enText: 'English', ja: 'Existing' }] });
  write(f.directory, '2026-09.json', [original]);
  write(f.directory, '2025-01.json', [article('2025-01')]);
  const store = f.store();
  await store.init();
  const untouched = fileRevision(path.join(f.directory, '2025-01.json'));
  store.mergeRefreshed([article('2026-10', 'moving', { title: original.title })], mergeChangelogArticles);
  assert.equal(store.article('moving').article.blocks[0].ja, 'Existing');
  assert.equal(store.article('moving').article.date, '2026-10-10');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, '2026-09.json'))).length, 0);
  assert.equal(fileRevision(path.join(f.directory, '2025-01.json')), untouched);
  store.mergeRefreshed([article('2024-01')], mergeChangelogArticles);
  assert.equal(store.state().externallyChanged, false);
  assert.equal(store.list({ period: 'all-time' }).total, 3);
});

test('explicit search finds unvisited Japanese body text, supports cancel, and invalidates changes', async t => {
  const f = fixture(t);
  marker(f.directory);
  for (let month = 1; month <= 12; month++) {
    const ym = `2026-${String(month).padStart(2, '0')}`;
    write(f.directory, `${ym}.json`, [article(ym, ym, { blocks: [{ id: 'b_0', enText: 'English', ja: month === 1 ? '未訪問の訳文' : '' }] })]);
  }
  const store = f.store();
  await store.init();
  const first = store.startSearch({ ...store.responseContext(), query: '未訪問', period: 'all-time' });
  while (store.searchStatus(first.id).status === 'running') await new Promise(setImmediate);
  assert.equal(store.searchStatus(first.id).status, 'completed');
  assert.deepEqual(store.list({ period: 'all-time', searchId: first.id }).articles.map(value => value.id), ['2026-01']);
  assert.equal(store.bodies.size, 0);
  const canceled = store.startSearch({ ...store.responseContext(), query: 'English', period: 'all-time' });
  store.cancelSearch();
  await new Promise(setImmediate);
  assert.equal(store.searchStatus(canceled.id).status, 'canceled');
  const changed = store.startSearch({ ...store.responseContext(), query: 'English', period: 'all-time' });
  fs.appendFileSync(path.join(f.directory, '2026-01.json'), '\n');
  while (store.searchStatus(changed.id).status === 'running') await new Promise(setImmediate);
  assert.equal(store.searchStatus(changed.id).status, 'error');
});

test('full replacement removes destination-only months but preserves source and unrelated files', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', [article('2026-09')]);
  const target = path.join(f.root, 'target');
  fs.mkdirSync(target);
  marker(target);
  write(target, '2025-01.json', [article('2025-01')]);
  write(target, 'notes.json', { keep: true });
  const store = f.store();
  await store.init();
  const original = fileRevision(path.join(f.directory, '2026-09.json'));
  const preview = await jobResult(store, store.preview({ ...store.responseContext(), dataDirectory: target }));
  const result = await store.switch({ token: preview.token, choice: 'overwrite' });
  assert.equal(result.dataDirectory, fs.realpathSync(target));
  assert.equal(fs.existsSync(path.join(target, '2025-01.json')), false);
  assert.equal(fileRevision(path.join(target, '2026-09.json')), original);
  assert.equal(fileRevision(path.join(f.directory, '2026-09.json')), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'notes.json'))), { keep: true });
  assert.equal(JSON.parse(fs.readFileSync(f.settingsPath)).dataDirectory, fs.realpathSync(target));
});

test('comparison revalidation and busy gate reject outdated or active switches', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', [article('2026-09')]);
  const target = path.join(f.root, 'target');
  fs.mkdirSync(target);
  let busy = false;
  const store = f.store({ isBusy: () => busy });
  await store.init();
  const request = { ...store.responseContext(), dataDirectory: target };
  busy = true;
  assert.throws(() => store.preview(request), /処理中/);
  await assert.rejects(store.reload(), /処理中/);
  busy = false;
  const preview = await jobResult(store, store.preview(request));
  fs.appendFileSync(path.join(f.directory, '2026-09.json'), '\n');
  await assert.rejects(store.switch({ token: preview.token, choice: 'overwrite' }), /比較後/);
  assert.equal(fs.existsSync(path.join(target, '2026-09.json')), false);
});

for (const direction of ['forward', 'rollback']) {
  for (const failedName of ['2026-01.json', '2026-02.json', MARKER]) {
    test(`interrupted transaction at ${failedName} restarts safely via ${direction}`, t => {
      const f = fixture(t);
      const before = JSON.stringify([article('2026-01')]);
      fs.writeFileSync(path.join(f.directory, '2026-01.json'), before);
      const changes = [
        { name: '2026-01.json', expected: fileRevision(path.join(f.directory, '2026-01.json')), content: '[]' },
        { name: '2026-02.json', expected: 'missing', content: JSON.stringify([article('2026-02')]) },
        { name: MARKER, expected: 'missing', content: JSON.stringify({ version: 1, format: 'monthly' }) }
      ];
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to === path.join(f.directory, failedName)) throw new Error('simulated crash');
        return rename(from, to);
      };
      try { assert.throws(() => directoryGate(f.directory, () => transact(f.directory, changes, 'test')), /未完了/); }
      finally { fs.renameSync = rename; }
      const record = pendingOperation(f.directory);
      assert.ok(record);
      recover(f.directory, record.id, direction);
      assert.equal(pendingOperation(f.directory), null);
      assert.equal(fs.readFileSync(path.join(f.directory, '2026-01.json'), 'utf8'), direction === 'forward' ? '[]' : before);
      assert.equal(fs.existsSync(path.join(f.directory, '2026-02.json')), direction === 'forward');
      assert.equal(fs.existsSync(path.join(f.directory, MARKER)), direction === 'forward');
    });
  }
}

test('recovery refuses unknown external edits, including untouched months', t => {
  const f = fixture(t);
  for (const month of ['2026-01', '2026-02']) write(f.directory, `${month}.json`, [article(month)]);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.directory, MARKER)) throw new Error('crash');
    return rename(from, to);
  };
  try {
    assert.throws(() => directoryGate(f.directory, () => transact(f.directory, [
      { name: MARKER, expected: 'missing', content: '{}' }
    ], 'test')));
  } finally { fs.renameSync = rename; }
  fs.appendFileSync(path.join(f.directory, '2026-02.json'), '\n');
  const record = pendingOperation(f.directory);
  assert.throws(() => recover(f.directory, record.id, 'forward'), /対象外/);
  assert.throws(() => recover(f.directory, record.id, 'rollback'), /対象外/);
  assert.ok(pendingOperation(f.directory));
});

test('CLI refuses legacy data without implicit migration', async t => {
  const f = fixture(t);
  write(f.directory, 'changelog-all.json', [article('2026-09')]);
  await assert.rejects(fetchAndSaveChangelog({ dataDirectory: f.directory }), /移行/);
  assert.equal(fs.existsSync(path.join(f.directory, MARKER)), false);
});

test('a stale migration preview cannot overwrite changed originals', async t => {
  const f = fixture(t);
  write(f.directory, 'changelog-all.json', [article('2026-09')]);
  const store = f.store();
  await store.init();
  const preview = await jobResult(store, store.previewMigration(store.responseContext()));
  fs.appendFileSync(path.join(f.directory, 'changelog-all.json'), '\n');
  await assert.rejects(jobResult(store, store.migrate({ ...store.responseContext(), token: preview.token })), /比較後/);
  assert.equal(fs.existsSync(path.join(f.directory, '2026-09.json')), false);
});

test('destination legacy migration is explicit and does not change the active connection', async t => {
  const f = fixture(t);
  const target = path.join(f.root, 'legacy');
  fs.mkdirSync(target);
  write(target, 'changelog-all.json', [article('2026-01')]);
  const store = f.store();
  await store.init();
  const generation = store.storageGeneration;
  await migrate(store, target);
  assert.equal(store.directory(), fs.realpathSync(f.directory));
  assert.equal(store.storageGeneration, generation);
  assert.equal(fs.existsSync(path.join(target, '2026-01.json')), true);
  const preview = await jobResult(store, store.preview({ ...store.responseContext(), dataDirectory: target }));
  await store.switch({ token: preview.token, choice: 'use-destination' });
  assert.equal(store.metadata().length, 1);
});

test('settings failure after replacing data preserves the old connection and a switch journal', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', [article('2026-09')]);
  const target = path.join(f.root, 'target');
  fs.mkdirSync(target);
  const store = f.store();
  await store.init();
  const preview = await jobResult(store, store.preview({ ...store.responseContext(), dataDirectory: target }));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.settingsPath) throw new Error('settings denied');
    return rename(from, to);
  };
  try { await assert.rejects(store.switch({ token: preview.token, choice: 'overwrite' }), /処理は完了.*設定保存/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.directory(), fs.realpathSync(f.directory));
  assert.equal(fs.existsSync(path.join(target, '2026-09.json')), true);
  const journal = store.state().switchRecovery;
  assert.equal(journal.stage, 'data-complete');
  assert.throws(() => store.assertRequest(store.responseContext()), /未完了/);
  store.acknowledgeSwitch(journal.id);
  assert.equal(store.state().restartRequired, true);
  assert.throws(() => store.assertRequest(store.responseContext()), /再起動/);
});

test('pending transactions survive initialization and block normal reads', async t => {
  const f = fixture(t);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.directory, MARKER)) throw new Error('interrupted');
    return rename(from, to);
  };
  try {
    assert.throws(() => directoryGate(f.directory, () => transact(f.directory, [
      { name: '2026-09.json', expected: 'missing', content: JSON.stringify([article('2026-09')]) },
      { name: MARKER, expected: 'missing', content: '{}' }
    ], 'migration')), /未完了/);
  } finally { fs.renameSync = rename; }
  const reopened = f.store();
  await reopened.init();
  assert.equal(reopened.state().format, 'recovery');
  assert.throws(() => reopened.list(), /未完了/);
  const record = reopened.state().recovery;
  const material = path.join(f.directory, '.changelog-transactions', record.id, '0.after');
  fs.writeFileSync(material, 'corrupted');
  await assert.rejects(reopened.recover({ storageGeneration: reopened.storageGeneration, id: record.id, direction: 'forward' }), /復旧用/);
});

test('index write failures do not misreport a durable translation as failed', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', [article('2026-09')]);
  const store = f.store();
  await store.init();
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.directory, '.changelog-cache', 'index.json')) throw new Error('index denied');
    return rename(from, to);
  };
  try { translate(store, '2026-09'); }
  finally { fs.renameSync = rename; }
  assert.equal(store.article('2026-09').article.translated, true);
  assert.match(store.state().indexWarning, /索引の保存に失敗/);
});

test('pagination tokens expire on data changes and settings changes never redirect existing sessions', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', Array.from({ length: 60 }, (_, index) => article('2026-09', String(index))));
  const store = f.store();
  await store.init();
  const cursor = store.list({ period: 'all-time' }).nextCursor;
  translate(store, '2026-09', '0');
  assert.throws(() => store.list({ period: 'all-time', cursor }), /先頭/);
  const target = path.join(f.root, 'other');
  fs.mkdirSync(target);
  write(f.root, 'settings.json', { dataDirectory: target });
  assert.equal(store.state().dataDirectory, fs.realpathSync(f.directory));
  assert.throws(() => store.setModelPreference(false), /別セッション/);
});

test('malformed operation records are explicit errors, not an empty store', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.directory, '.changelog-transactions'));
  const record = path.join(f.directory, '.changelog-transactions', 'current.json');
  for (const value of ['broken', 'null', JSON.stringify({
    version: 1, id: 'test', entries: [null], kind: 'test', applied: 0, stage: 'prepared'
  })]) {
    fs.writeFileSync(record, value);
    await assert.rejects(f.store().init(), /操作記録|操作対象/);
    assert.equal(fs.readFileSync(record, 'utf8'), value);
  }
});

test('concurrent initialization requests share a single catalog rebuild during reload', async t => {
  const f = fixture(t);
  marker(f.directory);
  write(f.directory, '2026-09.json', [article('2026-09')]);
  write(f.directory, '2026-10.json', [article('2026-10')]);
  const store = f.store();
  await store.init();
  let initializations = 0;
  const initialize = store.initialize.bind(store);
  store.initialize = () => { initializations++; return initialize(); };
  await Promise.all([store.reload(), store.init(), store.init()]);
  assert.equal(initializations, 1);
  assert.equal(store.metadata().length, 2);
});
