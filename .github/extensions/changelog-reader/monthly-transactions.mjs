import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWrite, fileRevision, StorageError, withLocks } from "./storage.mjs";

export const MARKER = "changelog-storage.json";
export const MONTH_FILE = /^\d{4}-(0[1-9]|1[0-2])\.json$/;
export const digest = value => createHash("sha256").update(value).digest("hex");
const operationsPath = directory => path.join(directory, ".changelog-transactions");
const recordPath = directory => path.join(operationsPath(directory), "current.json");

export function directoryGate(directory, operation) {
  return withLocks([path.join(directory, ".changelog-store")], operation);
}

export function pendingOperation(directory) {
  const file = recordPath(directory);
  if (!fs.existsSync(file)) return null;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new StorageError(`操作記録を読み込めません (${file}): ${error.message}`, 422); }
  if (!record || record.version !== 1 || !/^[a-zA-Z0-9-]+$/.test(record.id) ||
      !Array.isArray(record.entries) || typeof record.kind !== "string" ||
      !["prepared", "applying", "committed", "rolled-back", "recovering-forward", "recovering-rollback"].includes(record.stage) ||
      !Number.isInteger(record.applied) || record.applied < 0 || record.applied > record.entries.length) {
    throw new StorageError(`操作記録が不正です: ${file}`, 422);
  }
  for (const entry of record.entries) {
    if (!entry || !safeTarget(entry.name) || !["before", "after"].every(side =>
      entry[side] === "missing" || /^[a-f0-9]{64}$/.test(entry[side]))) throw new StorageError(`操作対象が不正です: ${file}`, 422);
  }
  if (!Array.isArray(record.monthsBefore) || record.monthsBefore.some(name => !MONTH_FILE.test(name)) ||
      new Set(record.entries.map(entry => entry.name)).size !== record.entries.length ||
      Object.entries(record.untouched || {}).some(([name, hash]) => !MONTH_FILE.test(name) || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new StorageError(`操作記録の月情報が不正です: ${file}`, 422);
  }
  return record;
}

function safeTarget(name) {
  return typeof name === "string" && (MONTH_FILE.test(name) || name === MARKER ||
    name === "changelog-all.json" || name === "changelog-2026-09.json" ||
    /^\.changelog-legacy[/\\][a-zA-Z0-9._-]+\.json$/.test(name));
}

function materialPath(directory, record, index, side) {
  return path.join(operationsPath(directory), record.id, `${index}.${side}`);
}

function assertMaterial(directory, record, index, side) {
  const entry = record.entries[index];
  if (entry[side] === "missing") return;
  if (fileRevision(materialPath(directory, record, index, side)) !== entry[side]) {
    throw new StorageError(`復旧用データがありません、または変更されています: ${entry.name}`, 422);
  }
}

function writeRecord(directory, record) {
  atomicWrite(recordPath(directory), JSON.stringify(record, null, 2));
}

function finish(directory, record) {
  const folder = path.join(operationsPath(directory), record.id);
  for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
  fs.rmdirSync(folder);
  fs.unlinkSync(recordPath(directory));
}

function applyEntry(directory, record, index, side) {
  const entry = record.entries[index];
  const file = path.join(directory, entry.name);
  const actual = fileRevision(file);
  if (actual !== entry.before && actual !== entry.after) throw new StorageError(`適用前に外部変更されました: ${entry.name}`);
  if (entry[side] === "missing") {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } else {
    assertMaterial(directory, record, index, side);
    if (entry.name.startsWith(".changelog-legacy")) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    atomicWrite(file, fs.readFileSync(materialPath(directory, record, index, side), "utf8"));
  }
}

function assertRecoverable(directory, record) {
  for (const [name, revision] of Object.entries(record.untouched || {})) {
    if (fileRevision(path.join(directory, name)) !== revision) throw new StorageError(`操作対象外の月が変更されました: ${name}`);
  }
  const expectedNames = new Set(record.monthsBefore);
  for (const entry of record.entries) if (MONTH_FILE.test(entry.name)) expectedNames.add(entry.name);
  const actual = fs.readdirSync(directory).filter(name => MONTH_FILE.test(name));
  if (actual.some(name => !expectedNames.has(name)) ||
      record.monthsBefore.some(name => !actual.includes(name) && !record.entries.some(entry => entry.name === name))) {
    throw new StorageError("操作開始後に対象外の月が追加・削除されました。手動で確認してください。");
  }
  for (let index = 0; index < record.entries.length; index++) {
    const entry = record.entries[index];
    const revision = fileRevision(path.join(directory, entry.name));
    if (revision !== entry.before && revision !== entry.after) {
      throw new StorageError(`外部で変更されたため復旧できません: ${entry.name}`);
    }
    assertMaterial(directory, record, index, "before");
    assertMaterial(directory, record, index, "after");
  }
}

// Call under directoryGate. Stages only one payload at a time; callers may provide a reader.
export function transact(directory, changes, kind) {
  if (pendingOperation(directory)) throw new StorageError("未完了の月別データ操作があります。復旧してください。");
  const id = randomUUID();
  const folder = path.join(operationsPath(directory), id);
  fs.mkdirSync(folder, { recursive: true });
  const record = {
    version: 1, id, kind, stage: "prepared", applied: 0,
    monthsBefore: fs.readdirSync(directory).filter(name => MONTH_FILE.test(name)).sort(),
    entries: [],
    untouched: {}
  };
  let published = false;
  try {
    const names = new Set();
    for (const change of changes) {
      if (!safeTarget(change.name) || names.has(change.name)) throw new StorageError("操作対象が不正または重複しています。", 422);
      names.add(change.name);
      const file = path.join(directory, change.name);
      const before = fileRevision(file);
      if (before !== change.expected) throw new StorageError(`操作前に変更されました: ${change.name}`);
      const index = record.entries.length;
      if (before !== "missing") {
        const content = fs.readFileSync(file, "utf8");
        if (digest(content) !== before) throw new StorageError(`退避中に変更されました: ${change.name}`);
        atomicWrite(materialPath(directory, record, index, "before"), content);
      }
      const content = change.read ? change.read() : change.content;
      const after = content === null ? "missing" : digest(content);
      if (change.sourceRevision && after !== change.sourceRevision) throw new StorageError(`コピー元が変更されました: ${change.name}`);
      if (content !== null) atomicWrite(materialPath(directory, record, index, "after"), content);
      record.entries.push({ name: change.name, before, after });
    }
    // Revalidate after staging; no public data has changed yet.
    for (const name of record.monthsBefore) {
      if (!names.has(name)) record.untouched[name] = fileRevision(path.join(directory, name));
    }
    for (const entry of record.entries) {
      if (fileRevision(path.join(directory, entry.name)) !== entry.before) {
        throw new StorageError(`準備中に変更されました: ${entry.name}`);
      }
    }
    writeRecord(directory, record);
    published = true;
    for (let index = 0; index < record.entries.length; index++) {
      applyEntry(directory, record, index, "after");
      record.applied = index + 1;
      record.stage = "applying";
      writeRecord(directory, record);
    }
    record.stage = "committed";
    writeRecord(directory, record);
    finish(directory, record);
  } catch (error) {
    if (!published) {
      for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
      fs.rmdirSync(folder);
      throw error;
    }
    throw new StorageError(`月別データ操作が未完了です。復旧画面で確認してください (${kind}): ${error.message}`, 500);
  }
}

export function recover(directory, id, direction) {
  return directoryGate(directory, () => {
    const record = pendingOperation(directory);
    if (!record || record.id !== id || !["forward", "rollback"].includes(direction)) {
      throw new StorageError("復旧対象または方法が不正です。");
    }
    if ((record.stage === "committed" && direction === "forward") || (record.stage === "rolled-back" && direction === "rollback")) {
      const side = direction === "forward" ? "after" : "before";
      for (const entry of record.entries) {
        if (fileRevision(path.join(directory, entry.name)) !== entry[side]) throw new StorageError(`完了後に変更されました: ${entry.name}`);
      }
      const folder = path.join(operationsPath(directory), record.id);
      if (fs.existsSync(folder)) {
        for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
        fs.rmdirSync(folder);
      }
      fs.unlinkSync(recordPath(directory));
      return { direction, kind: record.kind };
    }
    assertRecoverable(directory, record);
    const side = direction === "forward" ? "after" : "before";
    const order = record.entries.map((_, index) => index);
    if (side === "before") order.reverse();
    for (const index of order) {
      applyEntry(directory, record, index, side);
      record.stage = `recovering-${direction}`;
      writeRecord(directory, record);
    }
    for (const entry of record.entries) {
      if (fileRevision(path.join(directory, entry.name)) !== entry[side]) {
        throw new StorageError(`復旧後の内容が一致しません: ${entry.name}`);
      }
    }
    record.stage = direction === "forward" ? "committed" : "rolled-back";
    writeRecord(directory, record);
    finish(directory, record);
    return { direction, kind: record.kind };
  });
}
