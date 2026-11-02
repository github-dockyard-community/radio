import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

export class StorageError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export function validateStorageSettings(settings) {
  const dataDirectory = typeof settings.dataDirectory === "string" ? settings.dataDirectory.trim() : "";
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) {
    throw new StorageError("対訳データの保存先には既存ディレクトリの絶対パスを入力してください。", 400);
  }
  return { useAutoEfficiency: settings.useAutoEfficiency !== false, dataDirectory };
}

export function validateArticles(articles) {
  if (!Array.isArray(articles)) throw new StorageError("記事一覧が配列ではありません。", 422);
  const ids = new Set();
  for (const article of articles) {
    if (!article || typeof article.id !== "string" || !article.id ||
        typeof article.title !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(article.date) ||
        !Number.isFinite(Date.parse(article.date)) ||
        new Date(article.date).toISOString().slice(0, 10) !== article.date ||
        !Array.isArray(article.blocks) ||
        ["titleJa", "category", "link", "pubDate", "yearMonth"].some(key =>
          article[key] !== undefined && typeof article[key] !== "string") ||
        (article.translated !== undefined && typeof article.translated !== "boolean") ||
        (article.categories !== undefined && (!Array.isArray(article.categories) ||
          article.categories.some(category => typeof category !== "string")))) {
      throw new StorageError("記事のID・タイトル・日付・ブロックが不正です。", 422);
    }
    if (ids.has(article.id)) throw new StorageError(`重複した記事IDがあります: ${article.id}`, 422);
    ids.add(article.id);
    const blockIds = new Set();
    for (const block of article.blocks) {
      if (!block || typeof block.id !== "string" || !block.id ||
          typeof block.enText !== "string" || typeof block.ja !== "string" ||
          ["en", "tag"].some(key => block[key] !== undefined && typeof block[key] !== "string")) {
        throw new StorageError(`記事 ${article.id} のブロックが不正です。`, 422);
      }
      if (blockIds.has(block.id)) throw new StorageError(`記事 ${article.id} のブロックIDが重複しています: ${block.id}`, 422);
      blockIds.add(block.id);
    }
  }
  return articles;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileRevision(file) {
  try { return hash(fs.readFileSync(file)); }
  catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

export function existingDirectory(directory) {
  try {
    const normalized = fs.realpathSync(directory);
    if (!fs.statSync(normalized).isDirectory()) throw new StorageError("保存先がディレクトリではありません。", 400);
    fs.accessSync(normalized, fs.constants.R_OK | fs.constants.W_OK);
    return normalized;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(`保存先ディレクトリを利用できません (${directory}): ${error.message}`, 400);
  }
}

export function readSnapshot(file) {
  let bytes;
  try { bytes = fs.readFileSync(file); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { file, exists: false, dataRevision: "missing", articles: [] };
  }
  try {
    return { file, exists: true, dataRevision: hash(bytes), articles: validateArticles(JSON.parse(bytes.toString("utf8"))) };
  } catch (error) {
    throw new StorageError(`対訳データを読み込めません (${file}): ${error.message}`, 422);
  }
}

export function withLocks(files, operation) {
  const locks = [];
  try {
    for (const file of [...new Set(files.map(file => path.resolve(file)))].sort()) {
      const lockFile = `${file}.lock`;
      let fd;
      try { fd = fs.openSync(lockFile, "wx"); }
      catch (error) {
        if (error.code === "EEXIST") throw new StorageError(`別の処理が保存先を使用中です (${lockFile})。異常終了後の場合は利用中のアプリを確認してから残存ロックを削除してください。`);
        throw error;
      }
      const owner = JSON.stringify({ pid: process.pid, owner: randomUUID() });
      locks.push({ lockFile, fd, owner });
      fs.writeFileSync(fd, owner);
    }
    return operation();
  } finally {
    const errors = [];
    for (const { lockFile, fd, owner } of locks.reverse()) {
      fs.closeSync(fd);
      try {
        if (fs.readFileSync(lockFile, "utf8") !== owner) throw new StorageError(`排他ファイルの所有者が変わりました: ${lockFile}`);
        fs.unlinkSync(lockFile);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new StorageError(`排他の解除に失敗しました: ${errors.map(error => error.message).join("; ")}`, 500);
  }
}

export function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx");
    try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function sourceFingerprint(article) {
  return hash(JSON.stringify({ title: article.title, blocks: article.blocks.map(b => ({ id: b.id, enText: b.enText })) }));
}
