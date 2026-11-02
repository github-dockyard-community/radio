import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateStorageSettings, validateArticles, readSnapshot, fileRevision,
  existingDirectory, withLocks, atomicWrite, sourceFingerprint
} from '../.github/extensions/changelog-reader/storage.mjs';

const row = { id: 'id', title: 'Title', date: '2026-09-10', blocks: [{ id: 'b_0', enText: 'English', ja: '' }] };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-primitives-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'test.json');
  fs.writeFileSync(file, JSON.stringify([row]));
  return { directory, file };
}

test('settings require an absolute directory and preserve only supported preferences', () => {
  assert.throws(() => validateStorageSettings({ dataDirectory: 'relative' }), /絶対パス/);
  assert.throws(() => validateStorageSettings({}), /絶対パス/);
  assert.deepEqual(validateStorageSettings({ dataDirectory: path.resolve('data'), useAutoEfficiency: false, repository: 'old' }), {
    dataDirectory: path.resolve('data'), useAutoEfficiency: false
  });
});
test('snapshot distinguishes missing from empty and refuses corrupt JSON or structure', t => {
  const { directory, file } = fixture(t);
  const missing = readSnapshot(path.join(directory, 'missing.json'));
  assert.equal(missing.exists, false);
  assert.equal(missing.dataRevision, 'missing');
  for (const invalid of ['', 'broken', '{}', JSON.stringify([{ ...row, date: '2026-02-31' }])]) {
    fs.writeFileSync(file, invalid);
    assert.throws(() => readSnapshot(file), /対訳データ/);
    assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  }
  fs.writeFileSync(file, '[]');
  assert.equal(readSnapshot(file).exists, true);
});
test('duplicate articles and blocks, invalid field types are not silently repaired', () => {
  assert.throws(() => validateArticles([row, row]), /重複/);
  assert.throws(() => validateArticles([{ ...row, blocks: [row.blocks[0], row.blocks[0]] }]), /重複/);
  assert.throws(() => validateArticles([{ ...row, titleJa: 1 }]), /不正/);
  assert.throws(() => validateArticles([{ ...row, blocks: [{ id: 'b', enText: 'Text' }] }]), /不正/);
});
test('existing directories are resolved but never created or replaced', t => {
  const { directory, file } = fixture(t);
  assert.equal(existingDirectory(directory), fs.realpathSync(directory));
  assert.throws(() => existingDirectory(file), /ディレクトリ/);
  const absent = path.join(directory, 'absent');
  assert.throws(() => existingDirectory(absent), /利用できません/);
  assert.equal(fs.existsSync(absent), false);
});
test('cooperative locks exclude another process and never steal a residual lock', t => {
  const { file } = fixture(t);
  withLocks([file], () => {
    const child = spawnSync(process.execPath, ['-e',
      'try { require("fs").openSync(process.argv[1],"wx"); process.exit(1); } catch(e) { process.exit(e.code === "EEXIST" ? 0 : 2); }', `${file}.lock`]);
    assert.equal(child.status, 0);
    assert.throws(() => withLocks([file], () => {}), /使用中/);
  });
  assert.equal(fs.existsSync(`${file}.lock`), false);
  fs.writeFileSync(`${file}.lock`, 'residual');
  assert.throws(() => withLocks([file], () => {}), /残存ロック/);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'residual');
});
for (const stage of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`atomic ${stage} failure preserves original bytes and removes temporary material`, t => {
    const { directory, file } = fixture(t);
    const before = fileRevision(file), original = fs[stage];
    fs[stage] = () => { throw new Error('injected failure'); };
    try { assert.throws(() => atomicWrite(file, '[]'), /injected/); }
    finally { fs[stage] = original; }
    assert.equal(fileRevision(file), before);
    assert.deepEqual(fs.readdirSync(directory), ['test.json']);
  });
}
test('source fingerprints ignore translation changes, not English or title changes', () => {
  assert.equal(sourceFingerprint(row), sourceFingerprint({ ...row, titleJa: '訳', translated: true, blocks: [{ ...row.blocks[0], ja: '訳' }] }));
  assert.notEqual(sourceFingerprint(row), sourceFingerprint({ ...row, title: 'Changed' }));
  assert.notEqual(sourceFingerprint(row), sourceFingerprint({ ...row, blocks: [{ ...row.blocks[0], enText: 'Changed' }] }));
});
