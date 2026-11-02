import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  StorageError, atomicWrite, existingDirectory, fileRevision, readSnapshot,
  sourceFingerprint, validateArticles, validateStorageSettings, withLocks
} from "./storage.mjs";
import {
  MARKER, MONTH_FILE, digest, directoryGate, pendingOperation, recover, transact
} from "./monthly-transactions.mjs";

export const API_VERSION = 3;
const FORMAT = JSON.stringify({ version: 1, format: "monthly" }, null, 2);
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const cachePath = directory => path.join(directory, ".changelog-cache", "index.json");
const monthOf = article => article.date.slice(0, 7);
const signature = file => {
  const stat = fs.statSync(file);
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
};
const identity = directory => process.platform === "win32" ? directory.toLowerCase() : directory;
const sameInventory = (left, right) => Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([month, revision]) => right[month] === revision);

function inventory(directory) {
  const result = {};
  for (const name of fs.readdirSync(directory).sort()) {
    if (MONTH_FILE.test(name)) result[name.slice(0, 7)] = signature(path.join(directory, name));
    else if (/^\d{4}-\d{2}.*\.json$/i.test(name)) {
      throw new StorageError(`月別ファイル名または同期競合ファイルを確認してください: ${name}`, 422);
    }
  }
  return result;
}

function formatOf(directory) {
  if (pendingOperation(directory)) return "recovery";
  const files = inventory(directory);
  const marker = path.join(directory, MARKER);
  const legacy = ["changelog-all.json", "changelog-2026-09.json"].filter(name => fs.existsSync(path.join(directory, name)));
  if (fs.existsSync(marker)) {
    let value;
    try { value = JSON.parse(fs.readFileSync(marker, "utf8")); }
    catch (error) { throw new StorageError(`保存形式ファイルが不正です: ${error.message}`, 422); }
    if (value.version !== 1 || value.format !== "monthly") throw new StorageError("未対応の保存形式です。", 422);
    if (legacy.length) throw new StorageError("月別形式と旧全件ファイルが混在しています。ファイルを確認してください。", 422);
    return "monthly";
  }
  if (legacy.length) {
    if (Object.keys(files).length) throw new StorageError("旧全件ファイルと月別ファイルが混在しています。自動統合しません。", 422);
    if (legacy.length !== 1) throw new StorageError("旧全件ファイルが複数あります。利用するファイルを確認してください。", 422);
    return "legacy";
  }
  return Object.keys(files).length ? "unmanaged" : "empty";
}

function summaryArticle(article, month) {
  return {
    id: article.id, month, date: article.date, title: article.title,
    titleJa: article.titleJa || "", category: article.category || "",
    translated: Boolean(article.translated), fingerprint: sourceFingerprint(article)
  };
}

function validateMonth(articles, month) {
  validateArticles(articles);
  if (articles.some(article => monthOf(article) !== month ||
      (article.yearMonth !== undefined && article.yearMonth !== month))) {
    throw new StorageError(`記事の日付と所属月が一致しません: ${month}`, 422);
  }
  return articles;
}

function summarize(directory, months, format) {
  const rows = Object.values(months).flatMap(month => month.articles);
  const dates = rows.map(article => article.date).sort();
  return {
    file: directory, exists: format !== "empty", format,
    monthCount: Object.keys(months).length, articleCount: rows.length,
    translatedCount: rows.filter(article => article.translated).length,
    oldestDate: dates[0] || null, newestDate: dates.at(-1) || null
  };
}

function catalogRevision(months) {
  return digest(JSON.stringify(Object.keys(months).sort().map(month => [month, months[month].revision])));
}

function assertUnique(months) {
  const ids = new Set();
  for (const month of Object.values(months)) {
    for (const article of month.articles) {
      if (ids.has(article.id)) throw new StorageError(`重複した記事IDがあります: ${article.id}`, 422);
      ids.add(article.id);
    }
  }
}

function validIndex(value) {
  return value?.version === 1 && value.months && typeof value.months === "object" &&
    !Array.isArray(value.months) &&
    Object.entries(value.months).every(([month, entry]) =>
      /^\d{4}-(0[1-9]|1[0-2])$/.test(month) &&
      entry && typeof entry.signature === "string" && /^[a-f0-9]{64}$/.test(entry.revision) &&
      Array.isArray(entry.articles) && entry.articles.every(article =>
        article && typeof article.id === "string" && article.id && article.month === month &&
        typeof article.title === "string" && typeof article.titleJa === "string" &&
        typeof article.date === "string" && article.date.startsWith(`${month}-`) &&
        /^\d{4}-\d{2}-\d{2}$/.test(article.date) && Number.isFinite(Date.parse(article.date)) &&
        new Date(article.date).toISOString().slice(0, 10) === article.date && typeof article.category === "string" &&
        typeof article.translated === "boolean" && /^[a-f0-9]{64}$/.test(article.fingerprint) &&
        !Object.hasOwn(article, "blocks")));
}

export class MonthlyStorage {
  constructor({ settingsPath, defaultDirectory, isBusy = () => false }) {
    this.settingsPath = settingsPath;
    this.settingsRevision = settingsPath ? fileRevision(settingsPath) : "missing";
    const saved = this.settingsRevision === "missing" ? {} : JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!saved.dataDirectory && saved.localPath && path.basename(saved.localPath) !== "changelog-all.json") {
      throw new StorageError(`旧保存先 ${saved.localPath} を確認し、保存先ディレクトリを指定してください。`, 422);
    }
    this.settings = validateStorageSettings({
      useAutoEfficiency: saved.useAutoEfficiency,
      dataDirectory: saved.dataDirectory || (saved.localPath ? path.dirname(saved.localPath) : defaultDirectory)
    });
    this.defaultDirectory = defaultDirectory;
    this.isBusy = isBusy;
    this.storageGeneration = randomUUID();
    this.sequence = 0;
    this.months = {};
    this.bodies = new Map();
    this.previews = new Map();
    this.jobs = new Map();
    this.search = null;
    this.ready = false;
    this.busy = null;
    this.indexWarning = null;
    this.external = false;
  }

  directory() {
    const current = existingDirectory(this.settings.dataDirectory);
    if (this.pinnedDirectory && identity(current) !== identity(this.pinnedDirectory)) {
      throw new StorageError("保存先の実ディレクトリが変わりました。セッションを再起動してください。");
    }
    this.pinnedDirectory = current;
    return current;
  }

  async init() {
    if (this.ready) return;
    if (this.initializing) return this.initializing;
    this.initializing = this.initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async initialize() {
    const directory = this.directory();
    this.format = formatOf(directory);
    const markerRevision = fileRevision(path.join(directory, MARKER));
    this.months = {};
    if (["monthly", "unmanaged"].includes(this.format)) {
      let cached;
      try { cached = JSON.parse(fs.readFileSync(cachePath(directory), "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") this.indexWarning = `索引を再構築します: ${error.message}`;
      }
      await this.buildCatalog(validIndex(cached) ? cached.months : {});
    }
    this.baseline = ["monthly", "unmanaged"].includes(this.format)
      ? Object.fromEntries(Object.entries(this.months).map(([month, entry]) => [month, entry.signature]))
      : inventory(directory);
    this.markerRevision = markerRevision;
    if (!sameInventory(this.baseline, inventory(directory)) ||
        markerRevision !== fileRevision(path.join(directory, MARKER))) {
      throw new StorageError("初期化中に保存先が変更されました。再読み込みしてください。");
    }
    this.ready = true;
  }

  async buildCatalog(cached = {}, force = false) {
    const directory = this.directory();
    const initial = inventory(directory);
    const months = {};
    this.busy = { kind: "index", completed: 0, total: Object.keys(initial).length };
    try {
      for (const [month, sig] of Object.entries(initial)) {
        const entry = cached[month];
        if (!force && entry?.signature === sig) months[month] = entry;
        else {
          const snapshot = directoryGate(directory, () => {
            this.assertNoOperation();
            return readSnapshot(path.join(directory, `${month}.json`));
          });
          validateMonth(snapshot.articles, month);
          months[month] = {
            signature: sig, revision: snapshot.dataRevision,
            articles: snapshot.articles.map(article => summaryArticle(article, month))
          };
        }
        this.busy.completed++;
        await yieldTurn();
      }
      if (!sameInventory(initial, inventory(directory))) {
        throw new StorageError("索引の構築中に月別データが変わりました。再読み込みしてください。");
      }
      assertUnique(months);
      this.months = months;
      this.saveIndex();
    } finally { this.busy = null; }
  }

  saveIndex() {
    try {
      const file = cachePath(this.directory());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWrite(file, JSON.stringify({ version: 1, months: this.months }));
      this.indexWarning = null;
    } catch (error) {
      this.indexWarning = `データは読み込み・保存済みですが、索引の保存に失敗しました。再構築が必要です: ${error.message}`;
    }
  }

  assertNoOperation() {
    if (pendingOperation(this.directory())) throw new StorageError("未完了の月別データ操作があります。復旧してください。");
  }

  assertReadable() {
    this.assertNoOperation();
    if (!this.ready || this.busy) throw new StorageError("保存先を準備中です。", 409);
    if (!["monthly", "empty"].includes(this.format)) throw new StorageError("先に月別形式への移行・形式採用を実行してください。", 409);
  }

  detectChanges() {
    if (!this.ready || this.busy || this.format === "recovery") return;
    if (!sameInventory(inventory(this.directory()), this.baseline) ||
        fileRevision(path.join(this.directory(), MARKER)) !== this.markerRevision) this.external = true;
  }

  state() {
    this.detectChanges();
    const switchRecovery = this.switchRecovery();
    const destinationRecovery = switchRecovery && identity(switchRecovery.destination) !== identity(this.directory()) &&
      fs.existsSync(switchRecovery.destination) ? pendingOperation(switchRecovery.destination) : null;
    return {
      apiVersion: API_VERSION, storageGeneration: this.storageGeneration, sequence: this.sequence,
      dataRevision: catalogRevision(this.months), dataDirectory: this.directory(),
      useAutoEfficiency: this.settings.useAutoEfficiency, format: this.format || "loading",
      summary: summarize(this.directory(), this.months, this.format),
      months: Object.entries(this.months).map(([month, entry]) => ({
        month, articleCount: entry.articles.length,
        translatedCount: entry.articles.filter(article => article.translated).length
      })).sort((a, b) => b.month.localeCompare(a.month)),
      busy: Boolean(this.busy || this.isBusy()), progress: this.busy,
      externallyChanged: this.external, indexWarning: this.indexWarning,
      recovery: pendingOperation(this.directory()),
      switchRecovery, destinationRecovery,
      restartRequired: this.restartRequired || false,
      defaultDirectory: identity(this.directory()) === identity(path.resolve(this.defaultDirectory))
    };
  }

  assertRequest(request, fullRevision = true) {
    this.assertReadable();
    this.detectChanges();
    if (this.external) throw new StorageError("保存先が外部で更新されました。保存先から再読み込みしてください。");
    if (request?.storageGeneration !== this.storageGeneration ||
        (fullRevision && request.dataRevision !== catalogRevision(this.months))) {
      throw new StorageError("画面のデータが古くなっています。もう一度取得してください。");
    }
    if (this.switchRecovery() || this.restartRequired) throw new StorageError("未完了の保存先切替を確認し再起動してください。");
  }

  assertIdle() {
    if (this.busy || this.isBusy()) throw new StorageError("翻訳・待機キュー・RSS・索引処理中は実行できません。");
  }

  metadata() {
    return Object.values(this.months).flatMap(month => month.articles);
  }

  periodRows(period = "recent", baseDate = new Date()) {
    const rows = this.metadata();
    if (period === "all-time") return rows;
    if (/^month:\d{4}-(0[1-9]|1[0-2])$/.test(period)) return this.months[period.slice(6)]?.articles || [];
    if (period !== "recent") throw new StorageError("表示期間が不正です。", 400);
    const year = baseDate.getFullYear(), month = baseDate.getMonth();
    const cutoff = baseDate.getDate() <= 15
      ? new Date(Date.UTC(year, month - 1, 15)) : new Date(Date.UTC(year, month, 0));
    return rows.filter(article => article.date >= cutoff.toISOString().slice(0, 10));
  }

  list({ period = "recent", category = "all", status = "all", cursor, searchId } = {}) {
    this.assertReadable();
    this.detectChanges();
    if (this.external) throw new StorageError("保存先が外部で更新されました。再読み込みしてください。");
    let rows = this.periodRows(period);
    const totalInPeriod = rows.length;
    const translatedInPeriod = rows.filter(article => article.translated).length;
    if (category !== "all") rows = rows.filter(article => article.category === category);
    if (status !== "all") rows = rows.filter(article => status === "translated" ? article.translated : !article.translated);
    if (searchId) {
      if (!this.search || this.search.id !== searchId || this.search.status !== "completed" ||
          this.search.revision !== catalogRevision(this.months)) throw new StorageError("検索結果が無効です。検索をやり直してください。");
      rows = rows.filter(article => this.search.results.has(article.id));
    }
    rows = [...rows].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
    const queryRevision = digest(JSON.stringify([catalogRevision(this.months), period, category, status, searchId]));
    let offset = 0;
    if (cursor) {
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new StorageError("ページ情報が不正です。", 400); }
      if (decoded.revision !== queryRevision || !Number.isInteger(decoded.offset) || decoded.offset < 0) {
        throw new StorageError("一覧が更新されました。先頭から取得してください。");
      }
      offset = decoded.offset;
    }
    const articles = rows.slice(offset, offset + 50);
    return {
      ...this.responseContext(), articles, total: rows.length, totalInPeriod, translatedInPeriod,
      nextCursor: offset + 50 < rows.length
        ? Buffer.from(JSON.stringify({ revision: queryRevision, offset: offset + 50 })).toString("base64url") : null
    };
  }

  responseContext() {
    return { apiVersion: API_VERSION, storageGeneration: this.storageGeneration, sequence: this.sequence, dataRevision: catalogRevision(this.months) };
  }

  readMonth(month) {
    this.assertReadable();
    const entry = this.months[month];
    if (!entry) throw new StorageError(`月が見つかりません: ${month}`, 404);
    const directory = this.directory();
    return directoryGate(directory, () => {
      this.assertNoOperation();
      const file = path.join(directory, `${month}.json`);
      const bytes = fs.readFileSync(file);
      if (digest(bytes) !== entry.revision) {
        this.external = true;
        throw new StorageError(`月別データが外部で更新されました: ${month}`);
      }
      let articles = this.bodies.get(month);
      if (!articles) articles = validateMonth(JSON.parse(bytes.toString("utf8")), month);
      this.bodies.delete(month);
      this.bodies.set(month, articles);
      while (this.bodies.size > 3) this.bodies.delete(this.bodies.keys().next().value);
      return structuredClone(articles);
    });
  }

  article(id) {
    const metadata = this.metadata().find(article => article.id === id);
    if (!metadata) throw new StorageError("記事が見つかりません。", 404);
    const article = this.readMonth(metadata.month).find(article => article.id === id);
    return { ...this.responseContext(), monthRevision: this.months[metadata.month].revision, article };
  }

  saveTranslation(args, task) {
    this.assertReadable();
    if (task.storageGeneration !== this.storageGeneration || this.switchRecovery() || this.restartRequired) throw new StorageError("翻訳要求の保存先が変わりました。");
    const articles = this.readMonth(task.month);
    const article = articles.find(item => item.id === args.articleId);
    if (!article || sourceFingerprint(article) !== task.fingerprint) throw new StorageError("翻訳要求後に原文が変わりました。");
    article.titleJa = args.titleJa;
    const translations = new Map(args.blocks.map(block => [block.id, block.ja]));
    article.blocks.forEach(block => { block.ja = translations.get(block.id); });
    article.translated = true;
    this.commitMonths(new Map([[task.month, articles]]), "translation");
    return this.responseContext();
  }

  commitMonths(changed, kind) {
    const directory = this.directory();
    directoryGate(directory, () => {
      this.assertNoOperation();
      if (fileRevision(path.join(directory, MARKER)) !== this.markerRevision) throw new StorageError("保存形式が外部で変更されました。");
      const changes = [];
      const next = { ...this.months };
      for (const [month, articles] of changed) {
        validateMonth(articles, month);
        const expected = this.months[month]?.revision || "missing";
        const file = path.join(directory, `${month}.json`);
        if (fileRevision(file) !== expected) throw new StorageError(`月別データが外部で更新されました: ${month}`);
        const content = JSON.stringify(articles, null, 2);
        changes.push({ name: `${month}.json`, expected, content });
        next[month] = { revision: digest(content), articles: articles.map(article => summaryArticle(article, month)) };
      }
      assertUnique(next);
      if (this.format === "empty") changes.push({ name: MARKER, expected: "missing", content: FORMAT });
      if (changes.length === 1) atomicWrite(path.join(directory, changes[0].name), changes[0].content);
      else transact(directory, changes, kind);
      for (const [month] of changed) {
        next[month].signature = signature(path.join(directory, `${month}.json`));
        this.bodies.delete(month);
      }
      this.months = next;
      this.format = "monthly";
      this.markerRevision = fileRevision(path.join(directory, MARKER));
      for (const [month] of changed) this.baseline[month] = next[month].signature;
      this.sequence++;
      this.cancelSearch();
      this.saveIndex();
    });
  }

  mergeRefreshed(refreshed, merge) {
    this.assertReadable();
    this.detectChanges();
    if (this.external) throw new StorageError("RSS取得中に保存先が外部で更新されました。再読み込みしてください。");
    const byId = new Map(this.metadata().map(article => [article.id, article]));
    const affected = new Set(refreshed.map(monthOf));
    for (const article of refreshed) {
      const previous = byId.get(article.id);
      if (previous) affected.add(previous.month);
    }
    const existing = new Map();
    for (const month of affected) existing.set(month, this.months[month] ? this.readMonth(month) : []);
    const originals = [...existing.values()].flat();
    const combined = merge(originals, refreshed);
    const changed = new Map([...affected].map(month => [month, []]));
    for (const article of combined) {
      const month = monthOf(article);
      changed.get(month).push({ ...article, yearMonth: month });
    }
    this.commitMonths(changed, "rss");
    return this.responseContext();
  }

  async reload() {
    this.assertIdle();
    this.cancelSearch();
    this.ready = false;
    this.bodies.clear();
    this.external = false;
    this.previews.clear();
    this.storageGeneration = randomUUID();
    this.sequence++;
    await this.init();
    return this.state();
  }

  cancelSearch() {
    if (this.search?.status === "running") this.search.status = "canceled";
  }

  startSearch(request) {
    this.assertRequest(request);
    if (typeof request.query !== "string" || !request.query.trim()) throw new StorageError("検索語を入力してください。", 400);
    this.cancelSearch();
    const rows = this.periodRows(request.period);
    const months = [...new Set(rows.map(article => article.month))].sort().reverse();
    const job = {
      id: randomUUID(), status: "running", completed: 0, total: months.length,
      results: new Set(), revision: catalogRevision(this.months), generation: this.storageGeneration,
      query: request.query.trim().toLowerCase()
    };
    this.search = job;
    void this.runSearch(job, months, new Set(rows.map(article => article.id)));
    return this.searchStatus(job.id);
  }

  async runSearch(job, months, allowed) {
    try {
      for (const month of months) {
        if (job.status !== "running" || job.generation !== this.storageGeneration) return;
        this.assertNoOperation();
        const file = path.join(this.directory(), `${month}.json`);
        const bytes = await fs.promises.readFile(file);
        if (digest(bytes) !== this.months[month]?.revision) throw new StorageError(`検索中に更新されました: ${month}`);
        const articles = validateMonth(JSON.parse(bytes.toString("utf8")), month);
        for (const article of articles) {
          if (allowed.has(article.id) && [article.title, article.titleJa, ...article.blocks.flatMap(block => [block.enText, block.ja])]
            .some(text => (text || "").toLowerCase().includes(job.query))) job.results.add(article.id);
        }
        job.completed++;
        await yieldTurn();
      }
      // Recheck every scanned month, including one changed after its turn.
      for (const month of months) {
        if (job.status !== "running") return;
        const bytes = await fs.promises.readFile(path.join(this.directory(), `${month}.json`));
        if (digest(bytes) !== this.months[month]?.revision) throw new StorageError(`検索中に更新されました: ${month}`);
        await yieldTurn();
      }
      this.detectChanges();
      this.assertNoOperation();
      if (job.status === "running" && job.revision === catalogRevision(this.months) &&
          sameInventory(inventory(this.directory()), this.baseline)) job.status = "completed";
      else if (job.status === "running") throw new StorageError("検索中に一覧が更新されました。");
    } catch (error) {
      if (job.status === "running") { job.status = "error"; job.error = error.message; }
    }
  }

  searchStatus(id) {
    if (!this.search || this.search.id !== id) throw new StorageError("検索が見つかりません。", 404);
    const { status, completed, total, error, results } = this.search;
    return { ...this.responseContext(), id, status, completed, total, error, matches: results.size };
  }

  startJob(kind, operation) {
    this.assertIdle();
    if ([...this.jobs.values()].some(job => job.status === "running")) throw new StorageError("別の操作が実行中です。");
    this.cancelSearch();
    this.jobs.clear();
    const job = { id: randomUUID(), kind, status: "running", completed: 0, total: 0, canceled: false };
    this.jobs.set(job.id, job);
    this.busy = job;
    void (async () => {
      try {
        job.result = await operation(job);
        job.status = job.canceled ? "canceled" : "completed";
      } catch (error) { job.status = job.canceled ? "canceled" : "error"; job.error = error.message; }
      finally { this.busy = null; }
    })();
    return this.jobStatus(job.id);
  }

  jobStatus(id) {
    const job = this.jobs.get(id);
    if (!job) throw new StorageError("操作が見つかりません。", 404);
    return { ...this.responseContext(), id, kind: job.kind, status: job.status, completed: job.completed, total: job.total, error: job.error, result: job.result };
  }

  async inspect(directory, job) {
    const format = formatOf(directory);
    if (format === "recovery") throw new StorageError("比較先に未完了の操作があります。先に復旧してください。");
    const months = {};
    const revisions = {};
    const files = format === "legacy"
      ? ["changelog-all.json", "changelog-2026-09.json"].filter(name => fs.existsSync(path.join(directory, name)))
      : Object.keys(inventory(directory)).map(month => `${month}.json`);
    const initial = inventory(directory);
    job.total += files.length;
    for (const name of files) {
      if (job.canceled) throw new StorageError("操作を中止しました。");
      const snapshot = directoryGate(directory, () => {
        if (pendingOperation(directory)) throw new StorageError("比較中にデータ操作が始まりました。");
        return readSnapshot(path.join(directory, name));
      });
      revisions[name] = snapshot.dataRevision;
      for (const article of snapshot.articles) {
        const month = monthOf(article);
        if (format !== "legacy" && `${month}.json` !== name) throw new StorageError(`記事の所属月が不正です: ${name}`, 422);
        months[month] ||= { articles: [] };
        months[month].articles.push(summaryArticle(article, month));
      }
      if (format !== "legacy") {
        const month = name.slice(0, 7);
        months[month] ||= { articles: [] };
        months[month].revision = snapshot.dataRevision;
      }
      job.completed++;
      await yieldTurn();
    }
    assertUnique(months);
    if (!sameInventory(initial, inventory(directory))) throw new StorageError("比較中に月が追加・削除されました。");
    revisions[MARKER] = fileRevision(path.join(directory, MARKER));
    return { directory, format, revisions, inventory: initial, summary: summarize(directory, months, format) };
  }

  preview(request) {
    this.assertRequest(request);
    const destination = existingDirectory(validateStorageSettings(request).dataDirectory);
    if (identity(destination) === identity(this.directory())) throw new StorageError("現在と同じ保存先です。", 400);
    if (this.settingsRevision !== fileRevision(this.settingsPath)) throw new StorageError("別セッションで設定が変わりました。再起動してください。");
    return this.startJob("preview", async job => {
      const source = await this.inspect(this.directory(), job);
      for (const [month, entry] of Object.entries(this.months)) {
        if (source.revisions[`${month}.json`] !== entry.revision) throw new StorageError(`現在のデータが外部で更新されました: ${month}`);
      }
      const target = await this.inspect(destination, job);
      const token = randomUUID();
      this.previews.clear();
      this.previews.set(token, {
        source, target, generation: this.storageGeneration, settingsRevision: this.settingsRevision,
        expires: Date.now() + 5 * 60 * 1000, requestedDirectory: request.dataDirectory.trim()
      });
      return { token, current: source.summary, destination: target.summary };
    });
  }

  verifyInspection(inspected) {
    if (!sameInventory(inventory(inspected.directory), inspected.inventory)) throw new StorageError("比較後に月が変わりました。");
    for (const [name, revision] of Object.entries(inspected.revisions)) {
      if (fileRevision(path.join(inspected.directory, name)) !== revision) throw new StorageError(`比較後に変更されました: ${name}`);
    }
    if (formatOf(inspected.directory) !== inspected.format) throw new StorageError("比較後に保存形式が変わりました。");
  }

  switchRecovery() {
    if (!this.settingsPath) return null;
    const file = `${this.settingsPath}.switch.json`;
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }

  async switch(request) {
    this.assertIdle();
    if (this.switchRecovery() || this.restartRequired) throw new StorageError("未完了の保存先切替を確認してください。");
    this.cancelSearch();
    const preview = this.previews.get(request.token);
    this.previews.delete(request.token);
    if (!preview || preview.expires < Date.now() || preview.generation !== this.storageGeneration) throw new StorageError("比較が期限切れです。");
    if (!["overwrite", "use-destination"].includes(request.choice)) throw new StorageError("切替方法が不正です。", 400);
    if (!["monthly", "empty"].includes(preview.target.format)) throw new StorageError("変更先を先に明示的に月別形式へ移行・採用してください。");
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    this.busy = { kind: "switch", completed: 0, total: 1 };
    try {
      withLocks([path.join(preview.source.directory, ".changelog-store"), path.join(preview.target.directory, ".changelog-store"), this.settingsPath], () => {
        this.directory();
        if (identity(existingDirectory(preview.requestedDirectory)) !== identity(preview.target.directory) ||
            preview.settingsRevision !== fileRevision(this.settingsPath)) throw new StorageError("比較後に保存先または設定が変わりました。");
        this.verifyInspection(preview.source);
        this.verifyInspection(preview.target);
        const journal = { id: randomUUID(), source: preview.source.directory, destination: preview.target.directory, stage: "prepared", choice: request.choice };
        atomicWrite(`${this.settingsPath}.switch.json`, JSON.stringify(journal));
        if (request.choice === "overwrite") {
          const sourceMonths = new Set(Object.keys(preview.source.inventory));
          const changes = [...sourceMonths].map(month => ({
            name: `${month}.json`, expected: preview.target.revisions[`${month}.json`] || "missing",
            sourceRevision: preview.source.revisions[`${month}.json`],
            read: () => fs.readFileSync(path.join(preview.source.directory, `${month}.json`), "utf8")
          }));
          for (const month of Object.keys(preview.target.inventory)) {
            if (!sourceMonths.has(month)) changes.push({ name: `${month}.json`, expected: preview.target.revisions[`${month}.json`], content: null });
          }
          changes.push({ name: MARKER, expected: preview.target.revisions[MARKER], content: FORMAT });
          transact(preview.target.directory, changes, "replace");
        }
        journal.stage = "data-complete";
        atomicWrite(`${this.settingsPath}.switch.json`, JSON.stringify(journal));
        const next = { ...this.settings, dataDirectory: preview.target.directory };
        try { atomicWrite(this.settingsPath, JSON.stringify(next, null, 2)); }
        catch (error) { throw new StorageError(`変更先データの処理は完了しましたが、設定保存に失敗しました。旧接続を維持しています: ${error.message}`, 500); }
        this.settings = next;
        this.settingsRevision = fileRevision(this.settingsPath);
        this.pinnedDirectory = preview.target.directory;
        this.ready = false;
        this.storageGeneration = randomUUID();
        this.sequence++;
        this.bodies.clear();
        fs.unlinkSync(`${this.settingsPath}.switch.json`);
      });
    } finally { this.busy = null; }
    await this.init();
    return this.state();
  }

  previewMigration(request) {
    if (request.storageGeneration !== this.storageGeneration) throw new StorageError("接続が変わりました。");
    if (this.switchRecovery() || this.restartRequired) throw new StorageError("未完了の切替を確認してください。");
    const directory = request.dataDirectory ? existingDirectory(validateStorageSettings(request).dataDirectory) : this.directory();
    return this.startJob("migration-preview", async job => {
      const inspected = await this.inspect(directory, job);
      if (!["legacy", "unmanaged", "empty"].includes(inspected.format)) throw new StorageError("移行対象の旧形式データがありません。");
      const token = randomUUID();
      this.migrationPreview = { token, inspected, generation: this.storageGeneration, expires: Date.now() + 300000 };
      return { token, summary: inspected.summary };
    });
  }

  migrate(request) {
    if (request.storageGeneration !== this.storageGeneration) throw new StorageError("接続が変わりました。");
    if (this.switchRecovery() || this.restartRequired) throw new StorageError("未完了の切替を確認してください。");
    const preview = this.migrationPreview;
    this.migrationPreview = null;
    if (!preview || preview.token !== request.token || preview.generation !== this.storageGeneration ||
        preview.expires < Date.now()) throw new StorageError("移行の確認が期限切れです。");
    return this.startJob("migration", async job => {
      const { inspected } = preview;
      const { directory } = inspected;
      job.total = inspected.summary.monthCount;
      let changes = [];
      if (inspected.format === "legacy") {
        const name = Object.keys(inspected.revisions).find(name => name !== MARKER);
        const snapshot = readSnapshot(path.join(directory, name));
        const grouped = new Map();
        for (const article of snapshot.articles) {
          const month = monthOf(article);
          if (!grouped.has(month)) grouped.set(month, []);
          grouped.get(month).push(article);
        }
        changes = [...grouped].map(([month, articles]) => ({
          name: `${month}.json`, expected: "missing", content: JSON.stringify(articles, null, 2)
        }));
        const backupName = path.join(".changelog-legacy", `${name.replace(/\.json$/, "")}-${randomUUID()}.json`);
        changes.push({ name: backupName, expected: "missing", sourceRevision: snapshot.dataRevision, read: () => fs.readFileSync(snapshot.file, "utf8") });
        changes.push({ name, expected: snapshot.dataRevision, content: null });
      }
      changes.push({ name: MARKER, expected: "missing", content: FORMAT });
      directoryGate(directory, () => {
        this.verifyInspection(inspected);
        transact(directory, changes, "migration");
      });
      job.completed = job.total;
      if (identity(directory) !== identity(this.directory())) return this.responseContext();
      this.ready = false;
      this.storageGeneration = randomUUID();
      this.sequence++;
      // initialize owns the index progress; do not retain all legacy article bodies afterwards.
      this.busy = null;
      await this.init();
      return this.responseContext();
    });
  }

  async recover(request) {
    this.assertIdle();
    this.cancelSearch();
    const directory = request.directory ? existingDirectory(validateStorageSettings({ dataDirectory: request.directory }).dataDirectory) : this.directory();
    if (request.storageGeneration !== this.storageGeneration) throw new StorageError("接続が変わりました。");
    recover(directory, request.id, request.direction);
    if (identity(directory) === identity(this.directory())) return this.reload();
    return this.state();
  }

  acknowledgeSwitch(id) {
    this.assertIdle();
    return withLocks([this.settingsPath], () => {
      const journal = this.switchRecovery();
      if (!journal || journal.id !== id) throw new StorageError("切替記録が変わりました。");
      if (pendingOperation(journal.destination)) throw new StorageError("変更先の月別データ操作を先に復旧してください。");
      fs.unlinkSync(`${this.settingsPath}.switch.json`);
      this.restartRequired = true;
      return { ...this.responseContext(), restartRequired: true };
    });
  }

  setModelPreference(value) {
    if (typeof value !== "boolean") throw new StorageError("モデル設定が不正です。", 400);
    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
    return withLocks([this.settingsPath], () => {
      if (this.settingsRevision !== fileRevision(this.settingsPath) || this.switchRecovery() || this.restartRequired) throw new StorageError("別セッションの設定変更または未完了切替があります。");
      const next = { ...this.settings, useAutoEfficiency: value };
      atomicWrite(this.settingsPath, JSON.stringify(next, null, 2));
      this.settings = next;
      this.settingsRevision = fileRevision(this.settingsPath);
      return { ...this.responseContext(), ...next };
    });
  }
}
