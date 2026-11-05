// State
let allArticles = [];
let periodArticles = [];
let filteredArticles = [];
let currentArticleIndex = 0;
let currentArticleId = null;
let currentMode = 'side'; // 'side' | 'interleaved' | 'ja' | 'en'
let activeBlockIndex = -1; // -1 means no block selected
let storageState = null;
let storageChanging = false;
let storagePreview = null;
let dataEpoch = 0;
let dataRequestSequence = 0;
let appliedRequestSequence = 0;
let queueRequestSequence = 0;
let appliedQueueSequence = 0;
let lastStorageNotice = '';
let nextArticleCursor = null;
let listTotal = 0;
let periodTotal = 0;
let periodTranslated = 0;
let listEpoch = 0;
let detailEpoch = 0;
const detailCache = new Map();
let activeSearchId = null;
let activeSearchJobId = null;
let searchEpoch = 0;
let activeStorageJob = null;

// Elements
const sidebar = document.getElementById('sidebar');
const articleList = document.getElementById('article-list');
const searchInput = document.getElementById('search-input');
const categoryFilter = document.getElementById('category-filter');
const statusFilter = document.getElementById('status-filter');
const periodSelector = document.getElementById('period-selector');
const monthOptgroup = document.getElementById('month-optgroup');
const filteredCount = document.getElementById('filtered-count');
const translatedRatio = document.getElementById('translated-ratio');

const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const navCounter = document.getElementById('nav-counter');
const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
const btnThemeToggle = document.getElementById('btn-theme-toggle');
const btnHelpToggle = document.getElementById('btn-help-toggle');
const helpTooltipCard = document.getElementById('help-tooltip-card');
const kbHintsBar = document.getElementById('kb-hints-bar');

const artCategory = document.getElementById('art-category');
const artDate = document.getElementById('art-date');
const artStatusBadge = document.getElementById('art-status-badge');
const btnTranslateHeader = document.getElementById('btn-translate-header');
const artLink = document.getElementById('art-link');
const artTitleEn = document.getElementById('art-title-en');
const artTitleJa = document.getElementById('art-title-ja');
const blocksContainer = document.getElementById('blocks-container');
const untranslatedAlert = document.getElementById('untranslated-alert');
const articleBodyWrapper = document.getElementById('article-body-wrapper');
const mainView = document.getElementById('main-view');

// Queue Elements
const btnBatchTranslate = document.getElementById('btn-batch-translate');
const batchTranslateLabel = document.getElementById('batch-translate-label');
const batchOrderSelect = document.getElementById('batch-order');
const useAutoEfficiencyCheckbox = document.getElementById('use-auto-efficiency');
const btnRefreshArticles = document.getElementById('btn-refresh-articles');
const btnRefreshInfo = document.getElementById('btn-refresh-info');
const refreshTooltip = document.getElementById('refresh-tooltip');
const refreshStatus = document.getElementById('refresh-status');
const storageDirectory = document.getElementById('storage-directory');
const btnSaveStorage = document.getElementById('btn-save-storage');
const storageStatus = document.getElementById('storage-status');
const storageDialog = document.getElementById('storage-comparison');
const btnReloadStorage = document.getElementById('btn-reload-storage');
const btnRecovery = document.getElementById('btn-storage-recovery');
const btnMigrate = document.getElementById('btn-storage-migrate');
const btnRecoverForward = document.getElementById('btn-storage-recover-forward');
const btnRecoverRollback = document.getElementById('btn-storage-recover-rollback');
const btnMoreArticles = document.getElementById('btn-more-articles');
const btnSearch = document.getElementById('btn-search');
const btnCancelSearch = document.getElementById('btn-cancel-search');
const searchStatus = document.getElementById('search-status');

function requireVersion(value) {
  if (!value || value.apiVersion !== 3) {
    throw new Error('拡張機能APIの版が一致しません。/restart-session を実行してCanvasを開き直してください。');
  }
  return value;
}

function validSummary(value) {
  return value && typeof value.file === 'string' && typeof value.exists === 'boolean' &&
    Number.isInteger(value.articleCount) && value.articleCount >= 0 &&
    Number.isInteger(value.translatedCount) && value.translatedCount >= 0 &&
    (value.oldestDate === null || typeof value.oldestDate === 'string') &&
    (value.newestDate === null || typeof value.newestDate === 'string');
}

function storageRequest() {
  if (!storageState || storageChanging || storageState.externallyChanged ||
      storageState.recovery || storageState.restartRequired) {
    throw new Error('保存先の状態を確認してから操作してください。');
  }
  return { storageGeneration: storageState.storageGeneration, dataRevision: storageState.dataRevision };
}

async function postApi(url, body = {}) {
  requireVersion(storageState);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: JSON.stringify({ storageGeneration: storageState.storageGeneration, ...body })
  });
  let value;
  try { value = await res.json(); }
  catch { throw new Error(`APIが不正なJSONを返しました (HTTP ${res.status})。/restart-session 後に開き直してください。`); }
  if (!res.ok) throw new Error(value?.error || `HTTP ${res.status}`);
  return requireVersion(value);
}

async function applyStorageState(value, epoch, requestSequence) {
  requireVersion(value);
  if (!Array.isArray(value.months) || typeof value.dataDirectory !== 'string' ||
      typeof value.storageGeneration !== 'string' || typeof value.dataRevision !== 'string' ||
      typeof value.useAutoEfficiency !== 'boolean' || !validSummary(value.summary) ||
      !Number.isInteger(value.sequence)) {
    throw new Error('APIの保存先・記事一覧が不正です。/restart-session 後に開き直してください。');
  }
  if (epoch !== dataEpoch || (storageState && value.sequence < storageState.sequence) ||
      (storageState && value.sequence === storageState.sequence && requestSequence < appliedRequestSequence)) return false;
  appliedRequestSequence = Math.max(appliedRequestSequence, requestSequence);
  const generationChanged = storageState?.storageGeneration !== value.storageGeneration;
  const hadState = Boolean(storageState);
  const changed = generationChanged || storageState?.dataRevision !== value.dataRevision ||
    storageState?.initializationError !== value.initializationError ||
    storageState?.format !== value.format || Boolean(storageState?.progress) !== Boolean(value.progress);
  const selectedId = generationChanged ? null : currentArticleId;
  storageState = value;
  if (storageDirectory && generationChanged) storageDirectory.value = value.dataDirectory;
  if (useAutoEfficiencyCheckbox && !useAutoEfficiencyCheckbox.disabled) useAutoEfficiencyCheckbox.checked = value.useAutoEfficiency;
  const needsMigration = ['legacy', 'unmanaged', 'empty'].includes(value.format);
  if (btnMigrate) {
    btnMigrate.hidden = !needsMigration;
    btnMigrate.disabled = value.busy;
    btnMigrate.textContent = value.format === 'legacy' ? '月別形式へ移行' : '月別形式として使用';
  }
  if (btnSaveStorage) btnSaveStorage.disabled = storageChanging || value.busy || Boolean(value.recovery || value.switchRecovery) || (needsMigration && value.format !== 'empty');
  if (btnReloadStorage) btnReloadStorage.disabled = storageChanging || value.busy;
  if (btnRecovery) btnRecovery.hidden = !value.switchRecovery;
  if (btnRecoverForward) btnRecoverForward.hidden = !(value.recovery || value.destinationRecovery);
  if (btnRecoverRollback) btnRecoverRollback.hidden = !(value.recovery || value.destinationRecovery);
  const unavailable = storageChanging || value.externallyChanged || Boolean(value.recovery || value.switchRecovery) ||
    !['monthly', 'empty'].includes(value.format) || value.progress || value.restartRequired || value.initializationError;
  if (btnRefreshArticles) btnRefreshArticles.disabled = unavailable;
  if (btnBatchTranslate) btnBatchTranslate.disabled = unavailable || value.busy;
  const notice = JSON.stringify([value.storageGeneration, value.externallyChanged, value.recovery, value.switchRecovery, value.progress, value.indexWarning, value.format, value.initializationError]);
  if (value.initializationError && notice !== lastStorageNotice) {
    setStorageStatus(`読み込めませんでした: ${value.initializationError}\nファイルを確認・修正し、「保存先から再読み込み」で再試行してください。`, true);
  } else if (value.recovery && notice !== lastStorageNotice) {
    setStorageStatus(`未完了の月別データ操作: ${value.recovery.kind} / ${value.recovery.stage}\n変更済み ${value.recovery.applied} / ${value.recovery.entries.length} ファイル\n内容を確認して「残りを適用」または「元に戻す」を選んでください。外部変更があれば復旧は停止します。`, true);
  } else if (value.switchRecovery && notice !== lastStorageNotice) {
    setStorageStatus(`未完了の保存先切替: ${value.switchRecovery.stage}\n元: ${value.switchRecovery.source}\n変更先: ${value.switchRecovery.destination}\nデータ・設定を確認してください。自動的に再上書きしません。`, true);
  } else if (value.progress && notice !== lastStorageNotice) {
    setStorageStatus(`処理中: ${value.progress.kind} (${value.progress.completed} / ${value.progress.total})`);
  } else if (needsMigration && value.format !== 'empty' && notice !== lastStorageNotice) {
    setStorageStatus('この保存先は月別形式への移行・形式採用が必要です。旧ファイルは明示操作まで変更しません。');
  } else if (value.indexWarning && notice !== lastStorageNotice) {
    setStorageStatus(value.indexWarning, true);
  } else if (value.externallyChanged && notice !== lastStorageNotice) {
    setStorageStatus('保存先が外部で変更されました。「保存先から再読み込み」で取り込んでください。', true);
  } else if (notice !== lastStorageNotice) {
    setStorageStatus(`現在: ${value.dataDirectory}${value.defaultDirectory ? '\n互換用初期値はworktree内です。アーカイブ前に管理する保存先へ切り替えてください。' : ''}`);
  }
  lastStorageNotice = notice;
  if (changed) {
    if (activeSearchId) {
      activeSearchId = null;
      activeSearchJobId = null;
      searchEpoch++;
      searchStatus.textContent = 'データが更新されました。検索をやり直してください。';
    }
    if (generationChanged) {
      isTranslating = false;
      currentManualTargetId = null;
      currentArticleIndex = 0;
      currentArticleId = null;
      activeBlockIndex = -1;
      detailCache.clear();
      activeSearchId = null;
      activeSearchJobId = null;
      searchEpoch++;
      resetTranslateButtons();
      if (searchInput) searchInput.value = '';
      if (categoryFilter) categoryFilter.value = 'all';
      if (statusFilter) statusFilter.value = 'all';
      if (periodSelector && hadState) periodSelector.value = 'all-time';
    }
    populateMonthSelector();
    if (['monthly', 'empty'].includes(value.format) && !value.recovery && !value.progress && !value.externallyChanged && !value.initializationError) {
      await loadArticlePage(false, selectedId);
    } else {
      allArticles = [];
      filteredArticles = [];
      periodArticles = [];
      periodTotal = 0;
      periodTranslated = 0;
      renderEmptyState();
      updateStats();
    }
  }
  if (storageState !== value || epoch !== dataEpoch) return false;
  if (btnTranslateHeader && unavailable) btnTranslateHeader.disabled = true;
  else if (btnTranslateHeader && !isTranslating) btnTranslateHeader.disabled = filteredArticles.length === 0;
  return true;
}

function getBatchOrder() {
  return batchOrderSelect?.value === 'oldest' ? 'oldest' : 'newest';
}
const queueStatusCard = document.getElementById('queue-status-card');
const queueBadge = document.getElementById('queue-badge');
const queueCounts = document.getElementById('queue-counts');
const queueCurrentTitle = document.getElementById('queue-current-title');
const queueProgressFill = document.getElementById('queue-progress-fill');
const btnQueueTogglePause = document.getElementById('btn-queue-toggle-pause');
const btnQueueCancel = document.getElementById('btn-queue-cancel');

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  sidebar.inert = collapsed;
  sidebar.setAttribute('aria-hidden', String(collapsed));
  btnSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  const action = collapsed ? '表示' : '隠す';
  btnSidebarToggle.textContent = '☰ 一覧';
  btnSidebarToggle.title = `記事一覧を${action} (B)`;
  btnSidebarToggle.setAttribute('aria-label', `記事一覧を${action}`);
}

/**
 * Period Filter Calculation
 * - 上旬（1〜15日）の場合: 前月15日以降 〜 現在
 * - 下旬（16日以降）の場合: 前月末日以降 〜 現在
 */
function getRecentCutoffDate(baseDate = new Date()) {
  const currentDay = baseDate.getDate();
  const currentYear = baseDate.getFullYear();
  const currentMonth = baseDate.getMonth(); // 0-indexed

  if (currentDay <= 15) {
    // 上旬: 前月15日 (e.g. 10月1日なら 9月15日)
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    return new Date(Date.UTC(prevYear, prevMonth, 15, 0, 0, 0));
  } else {
    // 下旬: 前月の最終日 (e.g. 9月20日なら 8月31日)
    const lastDayOfPrevMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 0, 0, 0));
    return lastDayOfPrevMonth;
  }
}

// Fetch Articles Data
async function loadData() {
  const epoch = dataEpoch;
  const requestSequence = ++dataRequestSequence;
  try {
    const res = await fetch('/api/storage');
    const value = await res.json();
    if (!res.ok) throw new Error(value?.error || `HTTP ${res.status}`);
    await applyStorageState(value, epoch, requestSequence);
  } catch (err) {
    if (epoch !== dataEpoch || requestSequence < appliedRequestSequence) return;
    console.error('Failed to load articles data from the configured directory:', err);
    setStorageStatus(`対訳データを読み込めませんでした: ${err.message}`, true);
    return;
  }
}

async function refreshArticles() {
  if (!btnRefreshArticles || !refreshStatus || storageChanging || storageDialog?.open) return;

  btnRefreshArticles.disabled = true;
  refreshStatus.hidden = false;
  refreshStatus.textContent = 'RSSから最新記事を取得しています…';
  refreshStatus.classList.remove('refresh-error');
  const epoch = dataEpoch;
  const requestSequence = ++dataRequestSequence;

  try {
    const context = storageRequest();
    const res = await fetch('/api/articles/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify(context)
    });
    if (res.status === 404) {
      throw new Error('更新APIが見つかりません (HTTP 404)。拡張機能を再読み込みし、Canvasを開き直してください。');
    }
    let result;
    try {
      result = await res.json();
    } catch (err) {
      throw new Error(`更新APIがJSON以外または不正なJSONを返しました (HTTP ${res.status}, ${res.headers.get('content-type') || 'Content-Typeなし'})。拡張機能を再読み込みし、Canvasを開き直してください。`, { cause: err });
    }
    if (!res.ok) {
      throw new Error(result?.error || `更新APIでHTTP ${res.status}が発生しました。`);
    }
    if (!result || !Array.isArray(result.months)) {
      throw new Error('更新APIの応答に月別一覧がありません。');
    }

    if (!await applyStorageState(result, epoch, requestSequence)) return;

    const updatedAt = new Date(result.updatedAt).toLocaleString('ja-JP');
    refreshStatus.textContent = `更新しました: 新着 ${result.addedCount} 件 / 全 ${result.totalArticles} 件 (${updatedAt})。翻訳は未開始です。`;
  } catch (err) {
    if (epoch !== dataEpoch) return;
    refreshStatus.textContent = `更新に失敗しました: ${err.message}`;
    refreshStatus.classList.add('refresh-error');
  } finally {
    btnRefreshArticles.disabled = storageChanging || Boolean(storageState?.externallyChanged || storageState?.recovery);
  }
}

// Populate Month Selector dynamically based on available data
function populateMonthSelector() {
  if (!monthOptgroup) return;
  const selected = periodSelector?.value;
  monthOptgroup.innerHTML = '';
  (storageState?.months || []).forEach(({ month: ym, articleCount: count }) => {
    const [y, m] = ym.split('-');
    const opt = document.createElement('option');
    opt.value = `month:${ym}`;
    opt.textContent = `${y}年${parseInt(m, 10)}月 (${count}件)`;
    monthOptgroup.appendChild(opt);
  });
  if (periodSelector && selected) {
    periodSelector.value = selected;
    if (!periodSelector.value) periodSelector.value = 'recent';
  }

  const now = new Date();
  const isEarly = now.getDate() <= 15;
  const cutoff = getRecentCutoffDate(now);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const recentOpt = periodSelector ? periodSelector.querySelector('option[value="recent"]') : null;
  if (recentOpt) {
    recentOpt.textContent = `最新（${isEarly ? '上旬: 前月15日' : '下旬: 前月末日'} [${cutoffStr}] 〜 現在）`;
  }
}

// Apply Period Selection (Recent / All / Specific Month)
function applyPeriodFilter(preserveArticleId = null) {
  void cancelSearch(false);
  void loadArticlePage(false, preserveArticleId);
}

function applyFilters(preserveArticleId = null) {
  void loadArticlePage(false, preserveArticleId);
}

async function loadArticlePage(append = false, preserveArticleId = null) {
  if (!storageState || storageChanging) return;
  const epoch = append ? listEpoch : ++listEpoch;
  const generation = storageState.storageGeneration;
  const revision = storageState.dataRevision;
  // A data refresh (preserveArticleId without append) re-reads as many pages as were already loaded.
  const refreshing = !append && Boolean(preserveArticleId);
  const keepCount = refreshing ? allArticles.length : 0;
  const baseParams = new URLSearchParams({
    period: periodSelector?.value || 'recent',
    category: categoryFilter?.value || 'all', status: statusFilter?.value || 'all'
  });
  if (activeSearchId) baseParams.set('searchId', activeSearchId);
  if (btnMoreArticles) btnMoreArticles.disabled = true;
  try {
    let articles = append ? [...allArticles] : [];
    let cursor = append ? nextArticleCursor : null;
    let value;
    do {
      const params = new URLSearchParams(baseParams);
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/articles?${params}`);
      value = await res.json();
      if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
      requireVersion(value);
      if (epoch !== listEpoch || generation !== storageState.storageGeneration ||
          revision !== value.dataRevision || value.storageGeneration !== generation) return;
      if (!Array.isArray(value.articles) || value.articles.some(article => Object.hasOwn(article, 'blocks'))) {
        throw new Error('一覧APIが不正な要約を返しました。');
      }
      articles = [...articles, ...value.articles];
      cursor = value.nextCursor;
    } while (refreshing && cursor && articles.length < keepCount);
    allArticles = articles;
    filteredArticles = allArticles;
    periodArticles = allArticles;
    nextArticleCursor = value.nextCursor;
    listTotal = value.total;
    periodTotal = value.totalInPeriod;
    periodTranslated = value.translatedInPeriod;
    const listScroll = articleList.scrollTop;
    renderSidebarList();
    if (append || refreshing) articleList.scrollTop = listScroll;
    updateStats();
    if (btnMoreArticles) btnMoreArticles.hidden = !nextArticleCursor;
    if (filteredArticles.length) {
      if (!append) {
        if (preserveArticleId) {
          const selected = filteredArticles.findIndex(article => article.id === preserveArticleId);
          if (selected >= 0) {
            await selectArticle(selected, { keepPosition: true });
          } else {
            currentArticleIndex = -1;
            navCounter.textContent = `— / ${listTotal}`;
            btnPrev.disabled = true;
            btnNext.disabled = false;
          }
        } else {
          await selectArticle(0);
        }
      }
    } else renderEmptyState();
  } catch (error) {
    if (epoch !== listEpoch || generation !== storageState?.storageGeneration) return;
    setStorageStatus(`一覧を取得できませんでした: ${error.message}`, true);
    if (append) { nextArticleCursor = null; await loadArticlePage(false); }
  } finally { if (btnMoreArticles) btnMoreArticles.disabled = false; }
}

function updateStats() {
  const filtered = filteredArticles.length;
  filteredCount.textContent = `${periodTotal}件中 ${listTotal}件該当 · ${filtered}件読み込み済み`;
  translatedRatio.textContent = `${periodTranslated}件 対訳済`;
}

function renderEmptyState() {
  articleList.innerHTML = '<li class="article-list-item">該当する記事はありません。</li>';
  navCounter.textContent = '0 / 0';
  btnPrev.disabled = true;
  btnNext.disabled = true;
  artCategory.textContent = '';
  artDate.textContent = '';
  artStatusBadge.textContent = '';
  artLink.removeAttribute('href');
  artLink.style.display = 'none';
  artTitleEn.textContent = '該当する記事はありません';
  artTitleJa.textContent = '';
  btnTranslateHeader.disabled = true;
  untranslatedAlert.innerHTML = '';
  blocksContainer.innerHTML = '';
}

// Render Sidebar Article List
function renderSidebarList() {
  articleList.innerHTML = '';
  filteredArticles.forEach((art, idx) => {
    const li = document.createElement('li');
    li.className = `article-list-item ${idx === currentArticleIndex ? 'active' : ''}`;
    li.onclick = () => selectArticle(idx);

    const isTranslated = art.translated;
    li.innerHTML = `
      <div class="item-meta">
        <span class="item-date">${art.date ? escapeHtml(art.date.substring(5)) : ''}</span>
        <span class="item-category">${escapeHtml(art.category)}</span>
        <span class="item-status-badge ${isTranslated ? 'status-translated' : 'status-untranslated'}">
          ${isTranslated ? '対訳あり' : '原文'}
        </span>
      </div>
      <div class="item-title-en">${escapeHtml(art.title)}</div>
      ${art.titleJa ? `<div class="item-title-ja">${escapeHtml(art.titleJa)}</div>` : ''}
    `;
    articleList.appendChild(li);
  });
}

// Select Article by Index in filtered list
// keepPosition: re-render the open article in place (no scrolling, no loading placeholder).
async function selectArticle(index, { keepPosition = false } = {}) {
  const scrollToArticle = !keepPosition;
  if (index >= filteredArticles.length && nextArticleCursor) {
    await loadArticlePage(true, currentArticleId);
  }
  if (index < 0 || index >= filteredArticles.length) return;
  currentArticleIndex = index;
  currentArticleId = filteredArticles[index].id;

  // Update sidebar active item
  const items = articleList.querySelectorAll('.article-list-item');
  items.forEach((it, i) => {
    it.classList.toggle('active', i === index);
  });

  // Ensure sidebar item is in view
  if (scrollToArticle && items[index]) {
    items[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Update nav controls
  navCounter.textContent = `${index + 1} / ${listTotal}`;
  btnPrev.disabled = index === 0;
  btnNext.disabled = index === filteredArticles.length - 1 && !nextArticleCursor;

  const target = filteredArticles[index];
  const epoch = ++detailEpoch;
  const generation = storageState.storageGeneration;
  const revision = storageState.dataRevision;
  const savedScroll = articleBodyWrapper.scrollTop;
  const savedBlock = activeBlockIndex;
  if (!keepPosition) {
    blocksContainer.textContent = '本文を読み込んでいます…';
    artTitleEn.textContent = target.title;
    artTitleJa.textContent = target.titleJa;
  }
  try {
    const key = `${generation}:${revision}:${target.id}`;
    let article = detailCache.get(key);
    if (!article) {
      const response = await fetch(`/api/articles/${encodeURIComponent(target.id)}`);
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      requireVersion(value);
      if (value.storageGeneration !== generation || value.dataRevision !== revision) return;
      article = value.article;
    }
    if (epoch !== detailEpoch || generation !== storageState.storageGeneration || revision !== storageState.dataRevision) return;
    detailCache.delete(key);
    detailCache.set(key, article);
    while (detailCache.size > 3) detailCache.delete(detailCache.keys().next().value);
    renderArticle(article);
  } catch (error) {
    if (epoch === detailEpoch) {
      if (!keepPosition) blocksContainer.textContent = `本文を読み込めませんでした: ${error.message}`;
      setStorageStatus(error.message, true);
    }
    return;
  }

  if (keepPosition) {
    articleBodyWrapper.scrollTop = savedScroll;
    const rows = blocksContainer.querySelectorAll('.bilingual-row');
    activeBlockIndex = savedBlock < rows.length ? savedBlock : -1;
    rows.forEach((row, idx) => row.classList.toggle('active-block', idx === activeBlockIndex));
    return;
  }
  // Scroll reader to top
  articleBodyWrapper.scrollTop = 0;
  setActiveBlock(-1);
}

// Set Active Block Index (-1 to clear)
function setActiveBlock(index) {
  const rows = blocksContainer.querySelectorAll('.bilingual-row');
  if (rows.length === 0) {
    activeBlockIndex = -1;
    return;
  }

  if (index < -1) index = -1;
  if (index >= rows.length) index = rows.length - 1;

  activeBlockIndex = index;
  rows.forEach((r, idx) => {
    r.classList.toggle('active-block', idx === activeBlockIndex);
  });

  if (activeBlockIndex >= 0 && rows[activeBlockIndex]) {
    rows[activeBlockIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// Navigate blocks
function moveBlock(direction) {
  const rows = blocksContainer.querySelectorAll('.bilingual-row');
  if (rows.length === 0) return;

  if (activeBlockIndex === -1) {
    // 初期状態（未選択時）:
    // 下方向 (↓/j/s) が押された場合は先頭の段落 (0) を選択
    // 上方向 (↑/k/w) が押された場合はどこにもフォーカスせず何もしない
    if (direction > 0) {
      setActiveBlock(0);
    }
    return;
  }

  const nextIndex = activeBlockIndex + direction;
  // 先頭・末尾で停止（記事の文章閲覧UIとして、誤操作で末尾や先頭にワープしない一般的な挙動）
  if (nextIndex >= 0 && nextIndex < rows.length) {
    setActiveBlock(nextIndex);
  }
}

// Render Article
function renderArticle(art) {
  artCategory.textContent = art.category || '';
  artDate.textContent = art.date || '';

  // Validate URL scheme to prevent javascript: or data: URIs
  if (art.link && /^https?:\/\//i.test(art.link)) {
    artLink.href = art.link;
    artLink.style.display = 'inline-flex';
  } else {
    artLink.removeAttribute('href');
    artLink.style.display = 'none';
  }

  artTitleEn.textContent = art.title;
  artTitleJa.textContent = art.titleJa || '（未翻訳）';
  artTitleJa.style.display = art.titleJa ? 'block' : (currentMode === 'en' ? 'none' : 'block');

  if (art.translated) {
    artStatusBadge.className = 'badge status-translated';
    artStatusBadge.textContent = '対訳あり';
    untranslatedAlert.innerHTML = '';
    if (btnTranslateHeader) {
      btnTranslateHeader.classList.remove('loading');
      btnTranslateHeader.disabled = false;
      btnTranslateHeader.innerHTML = `
        <span class="translate-icon">🔄</span>
        <span class="translate-label">再翻訳</span>
        <span class="kb-key" style="font-size: 0.7rem; padding: 1px 4px; border-color: rgba(255,255,255,0.3);">T</span>
      `;
      btnTranslateHeader.title = 'AI対訳を再生成 (ショートカット: T)';
    }
  } else {
    artStatusBadge.className = 'badge status-untranslated';
    artStatusBadge.textContent = '原文のみ';
    if (btnTranslateHeader) {
      btnTranslateHeader.classList.remove('loading');
      btnTranslateHeader.disabled = false;
      btnTranslateHeader.innerHTML = `
        <span class="translate-icon">🌐</span>
        <span class="translate-label">日本語訳を生成</span>
        <span class="kb-key" style="font-size: 0.7rem; padding: 1px 4px; border-color: rgba(255,255,255,0.3);">T</span>
      `;
      btnTranslateHeader.title = 'AI対訳を生成 (ショートカット: T)';
    }
    untranslatedAlert.innerHTML = `
      <div class="untranslated-banner" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <strong>この記事の日本語訳はまだ登録されていません。</strong>
          <div style="font-size:0.85em; margin-top:2px;">「日本語訳を生成」ボタンまたはキーボードの [T] を押すと、Copilot app で安全に対訳を自動生成します。</div>
        </div>
        <button class="btn-translate-action" id="btn-translate-banner" style="margin-left: 1rem; flex-shrink:0;">
          🌐 日本語訳を生成 [T]
        </button>
      </div>
    `;
    const btnBanner = document.getElementById('btn-translate-banner');
    if (btnBanner) {
      btnBanner.onclick = () => requestTranslateArticle();
    }
  }

  // Render Blocks
  blocksContainer.innerHTML = '';
  art.blocks.forEach((block, bIdx) => {
    const row = document.createElement('div');
    row.className = 'bilingual-row';
    row.id = `row-${block.id}`;
    row.onclick = () => setActiveBlock(bIdx);

    const jaContent = block.ja ? sanitizeHtml(block.ja) : `<span style="color:var(--text-muted); font-style:italic;">[未翻訳]</span>`;
    const enFormatted = sanitizeHtml(block.en);

    if (block.tag === 'li') {
      row.classList.add('block-li');
    }

    row.innerHTML = `
      <div class="block-en">${enFormatted}</div>
      <div class="block-ja">${jaContent}</div>
    `;

    blocksContainer.appendChild(row);
  });
}

// View Mode Switching
function setViewMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  mainView.classList.remove('view-mode-side', 'view-mode-interleaved', 'view-mode-ja', 'view-mode-en');
  mainView.classList.add(`view-mode-${mode}`);

  const colHeaders = document.getElementById('column-headers');
  if (colHeaders) {
    colHeaders.style.display = (mode === 'side') ? 'grid' : 'none';
  }
}

// CSRF Token Helper
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
}

function setStorageStatus(message, isError = false) {
  if (!storageStatus) return;
  storageStatus.hidden = false;
  storageStatus.textContent = message;
  storageStatus.classList.toggle('storage-error', isError);
}

async function saveStorageSettings() {
  if (!btnSaveStorage || !storageStatus || storageChanging) return;
  btnSaveStorage.disabled = true;
  try {
    const job = await postApi('/api/storage/preview', {
      ...storageRequest(), dataDirectory: storageDirectory.value
    });
    storagePreview = await waitStorageJob(job);
    if (typeof storagePreview.token !== 'string' ||
        !validSummary(storagePreview.current) || !validSummary(storagePreview.destination)) {
      throw new Error('比較APIの応答が不正です。/restart-session 後に開き直してください。');
    }
    const describe = summary => `
      <p class="storage-card-path">${escapeHtml(summary.file)}</p>
      <span class="storage-file-state">${summary.exists ? 'データファイルあり' : 'データファイルなし'}</span>
      <dl class="storage-card-stats">
        <div><dt>記事</dt><dd>${summary.articleCount.toLocaleString('ja-JP')}<span> 件</span></dd></div>
        <div><dt>翻訳済み</dt><dd>${summary.translatedCount.toLocaleString('ja-JP')}<span> 件</span></dd></div>
      </dl>
      <p class="storage-file-state">${summary.monthCount}か月 · ${summary.format === 'legacy' ? '旧全件形式（移行が必要）' : summary.format === 'unmanaged' ? '形式採用が必要' : '月別形式'}</p>
      <p class="storage-card-period"><span>記事の日付範囲</span>${summary.oldestDate ? `${escapeHtml(summary.oldestDate)} ～ ${escapeHtml(summary.newestDate)}` : 'まだ記事はありません'}</p>`;
    document.getElementById('storage-current-details').innerHTML = describe(storagePreview.current);
    document.getElementById('storage-destination-details').innerHTML = describe(storagePreview.destination);
    const needsMigration = !['monthly', 'empty'].includes(storagePreview.destination.format);
    document.getElementById('btn-storage-migrate-destination').hidden = !needsMigration;
    document.getElementById('btn-storage-use').disabled = needsMigration;
    document.getElementById('btn-storage-overwrite').disabled = needsMigration;
    storageDialog.showModal();
    document.getElementById('btn-storage-cancel').focus();
  } catch (err) {
    setStorageStatus(`保存先を比較できませんでした: ${err.message}`, true);
  } finally {
    btnSaveStorage.disabled = false;
  }
}

async function waitStorageJob(job) {
  activeStorageJob = job.id;
  document.getElementById('btn-storage-cancel-job').hidden = job.kind === 'migration';
  try {
    while (job.status === 'running') {
      setStorageStatus(`処理中: ${job.completed} / ${job.total}か月`);
      await new Promise(resolve => setTimeout(resolve, 150));
      const response = await fetch(`/api/storage/jobs/${encodeURIComponent(job.id)}`);
      job = requireVersion(await response.json());
      if (!response.ok) throw new Error(job.error || `HTTP ${response.status}`);
    }
    if (job.status !== 'completed') throw new Error(job.error || '操作を中止しました。');
    return job.result;
  } finally {
    activeStorageJob = null;
    document.getElementById('btn-storage-cancel-job').hidden = true;
  }
}

async function runMigration(dataDirectory) {
  try {
    const inspection = await waitStorageJob(await postApi('/api/storage/preview-migration', {
      storageGeneration: storageState.storageGeneration, ...(dataDirectory ? { dataDirectory } : {})
    }));
    const { summary } = inspection;
    if (!confirm(`${summary.file}\n${summary.articleCount}件 / ${summary.translatedCount}件対訳済 / ${summary.monthCount}か月\n月別形式に移行・採用しますか？旧全件ファイルは .changelog-legacy に退避して残します。`)) return;
    const job = await postApi('/api/storage/migrate', { storageGeneration: storageState.storageGeneration, token: inspection.token });
    await waitStorageJob(job);
    await loadData();
  } catch (error) {
    await loadData();
    setStorageStatus(`移行を完了できませんでした: ${error.message}`, true);
  }
}

async function closeStorageComparison() {
  const preview = storagePreview;
  storagePreview = null;
  storageDialog.close();
  btnSaveStorage.focus();
  if (preview) {
    try { await postApi('/api/storage/cancel', { token: preview.token }); }
    catch (error) { setStorageStatus(`比較の破棄に失敗しました: ${error.message}`, true); }
  }
}

async function confirmStorageSwitch(choice) {
  if (!storagePreview || storageChanging) return;
  const token = storagePreview.token;
  storagePreview = null;
  storageChanging = true;
  ++dataEpoch;
  storageDialog.close();
  try {
    const result = await postApi('/api/storage/switch', { token, choice });
    storageChanging = false;
    await applyStorageState(result, dataEpoch, ++dataRequestSequence);
    setStorageStatus(`保存先を切り替えました: ${result.dataDirectory}`);
  } catch (error) {
    setStorageStatus(`保存先切替を完了できませんでした: ${error.message}`, true);
    // A lost response must be reconciled, never retried with another overwrite.
    const message = storageStatus.textContent;
    storageChanging = false;
    await loadData();
    setStorageStatus(message, true);
  } finally {
    storageChanging = false;
    btnSaveStorage.focus();
  }
}

async function reloadStorage() {
  if (storageChanging || !storageState) return;
  storageChanging = true;
  ++dataEpoch;
  try {
    const value = await postApi('/api/storage/reload', { storageGeneration: storageState.storageGeneration });
    storageChanging = false;
    await applyStorageState(value, dataEpoch, ++dataRequestSequence);
  } catch (error) {
    setStorageStatus(`再読み込みできませんでした: ${error.message}`, true);
  } finally { storageChanging = false; }
}

// Translate Article via Background Queue (Priority Interrupt)
let isTranslating = false;
let currentManualTargetId = null;
let queuePollTimer = null;
let lastRefreshTime = 0;
let latestQueueStatus = null;

function resetTranslateButtons() {
  if (btnTranslateHeader) {
    btnTranslateHeader.classList.remove('loading');
    btnTranslateHeader.disabled = false;
    btnTranslateHeader.innerHTML = `
      <span class="translate-icon">🌐</span>
      <span class="translate-label">日本語訳を生成</span>
      <span class="kb-key" style="font-size: 0.7rem; padding: 1px 4px; border-color: rgba(255,255,255,0.3);">T</span>
    `;
  }
}

function updateQueueUI(status) {
  if (!queueStatusCard) return;

  const isActive = status.isProcessing || status.queueLength > 0;
  if (!isActive) {
    if ((status.completedCount > 0 || status.failedCount > 0) && queueStatusCard.style.display !== 'none') {
      queueBadge.textContent = status.failedCount ? '⚠️ 翻訳エラーあり' : '✅ 翻訳完了';
      queueBadge.className = 'queue-badge';
      queueCounts.textContent = `${status.completedCount} / ${status.totalSubmitted}`;
      queueProgressFill.style.width = '100%';
      queueCurrentTitle.textContent = status.failedCount ? `失敗 ${status.failedCount} 件: ${status.lastError || ''}` : 'すべてのタスクが完了しました';
      const generation = status.storageGeneration;
      setTimeout(() => {
        if (storageState?.storageGeneration === generation && !latestQueueStatus?.isProcessing && latestQueueStatus?.queueLength === 0) {
          queueStatusCard.style.display = 'none';
        }
      }, 4000);
    } else {
      queueStatusCard.style.display = 'none';
    }
    if (btnBatchTranslate) {
      btnBatchTranslate.disabled = false;
      batchTranslateLabel.textContent = '未翻訳を一括翻訳 (非同期)';
    }
    return;
  }

  queueStatusCard.style.display = 'flex';
  if (btnBatchTranslate) {
    btnBatchTranslate.disabled = true;
    batchTranslateLabel.textContent = 'バックグラウンド実行中...';
  }

  if (status.isPaused) {
    queueBadge.textContent = '⏸️ 一時停止中';
    queueBadge.className = 'queue-badge';
    if (btnQueueTogglePause) btnQueueTogglePause.textContent = '▶️';
  } else if (status.currentTask && status.currentTask.priority === 'high') {
    queueBadge.textContent = '⚡ 割込優先処理中';
    queueBadge.className = 'queue-badge priority-high';
    if (btnQueueTogglePause) btnQueueTogglePause.textContent = '⏸️';
  } else {
    queueBadge.textContent = '🔄 順次翻訳中';
    queueBadge.className = 'queue-badge';
    if (btnQueueTogglePause) btnQueueTogglePause.textContent = '⏸️';
  }

  const completed = status.completedCount || 0;
  const total = status.totalSubmitted || (completed + status.queueLength + (status.isProcessing ? 1 : 0));
  queueCounts.textContent = `${completed} / ${total}`;

  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  queueProgressFill.style.width = `${pct}%`;

  if (status.currentTask) {
    queueCurrentTitle.textContent = status.currentTask.title || '記事を翻訳中...';
    queueCurrentTitle.title = status.currentTask.title || '';
  } else {
    queueCurrentTitle.textContent = '次の記事を準備中...';
  }
}

async function checkQueueStatus() {
  const epoch = dataEpoch;
  const requestSequence = ++queueRequestSequence;
  try {
    const res = await fetch('/api/queue/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = requireVersion(await res.json());
    if (!Number.isInteger(status.sequence) || typeof status.storageGeneration !== 'string' ||
        typeof status.isProcessing !== 'boolean' || !Number.isInteger(status.queueLength) ||
        !Array.isArray(status.queue)) {
      throw new Error('キューAPIの応答が不正です。/restart-session 後に開き直してください。');
    }
    if (epoch !== dataEpoch || requestSequence < appliedQueueSequence ||
        (storageState && status.sequence < storageState.sequence)) return;
    appliedQueueSequence = requestSequence;
    if (status.storageGeneration !== storageState?.storageGeneration ||
        status.dataRevision !== storageState?.dataRevision) {
      await loadData();
    }
    if (epoch !== dataEpoch || status.storageGeneration !== storageState?.storageGeneration) return;
    latestQueueStatus = status;
    updateQueueUI(status);
    if (status.lastError) setStorageStatus(`翻訳エラー: ${status.lastError}`, true);
    if (isTranslating && status.currentTask?.articleId !== currentManualTargetId &&
        !status.queue.some(task => task.articleId === currentManualTargetId)) {
      isTranslating = false;
      currentManualTargetId = null;
      resetTranslateButtons();
    }
    // Also discover external file changes and settings left by other Canvas panels.
    await refreshArticlesData();
  } catch (err) {
    if (epoch !== dataEpoch || requestSequence < appliedQueueSequence) return;
    setStorageStatus(`状態を取得できませんでした: ${err.message}`, true);
  }
}

async function refreshArticlesData() {
  const now = Date.now();
  if (now - lastRefreshTime < 1800) return;
  lastRefreshTime = now;

  if (!storageChanging) await loadData();
}

function startQueuePolling() {
  if (queuePollTimer) return;
  checkQueueStatus();
  queuePollTimer = setInterval(checkQueueStatus, 2000);
}

function stopQueuePolling() {
  if (queuePollTimer) {
    clearInterval(queuePollTimer);
    queuePollTimer = null;
  }
}

async function requestTranslateArticle() {
  if (isTranslating || storageChanging || storageDialog?.open) return;
  const currentArt = filteredArticles[currentArticleIndex];
  if (!currentArt) return;
  const generation = storageState?.storageGeneration;

  isTranslating = true;
  currentManualTargetId = currentArt.id;

  if (btnTranslateHeader) {
    btnTranslateHeader.classList.add('loading');
    btnTranslateHeader.disabled = true;
    btnTranslateHeader.innerHTML = `
      <span class="translate-icon">⚡</span>
      <span class="translate-label">割り込み処理中...</span>
    `;
  }
  const btnBanner = document.getElementById('btn-translate-banner');
  if (btnBanner) {
    btnBanner.classList.add('loading');
    btnBanner.disabled = true;
    btnBanner.innerHTML = `⚡ 最優先で割り込み翻訳中...`;
  }

  try {
    await postApi(`/api/articles/${encodeURIComponent(currentArt.id)}/request-translate`, storageRequest());
    if (generation !== storageState?.storageGeneration) return;

    startQueuePolling();
    checkQueueStatus();

  } catch (err) {
    if (generation !== storageState?.storageGeneration) return;
    console.error('Translation error:', err);
    alert(`翻訳リクエストエラー: ${err.message}`);
    isTranslating = false;
    currentManualTargetId = null;
    resetTranslateButtons();
  }
}

async function enqueueBatchCurrentView() {
  if (storageChanging || storageDialog?.open) return;
  try {
    const preview = await postApi('/api/queue/preview-batch', {
      ...storageRequest(), period: periodSelector?.value || 'recent', order: getBatchOrder()
    });
    if (!preview.count) { alert('選択期間に未翻訳の記事はありません。'); return; }
    const label = periodSelector?.value === 'all-time' ? '全期間' : '選択期間';
    const orderLabel = getBatchOrder() === 'oldest' ? '古い順' : '新しい順';
    if (!confirm(`${label}の未翻訳記事 ${preview.count} 件を${orderLabel}で翻訳しますか？\n読み込み済みページや検索結果ではなく、期間全体が対象です。`)) return;
    await postApi('/api/queue/enqueue-batch', { ...storageRequest(), token: preview.token });

    startQueuePolling();
    checkQueueStatus();
  } catch (err) {
    alert(`一括キュー登録に失敗しました: ${err.message}`);
  }
}

async function cancelSearch(reload = true) {
  const id = activeSearchJobId;
  searchEpoch++;
  activeSearchId = null;
  activeSearchJobId = null;
  if (btnCancelSearch) btnCancelSearch.hidden = true;
  if (searchStatus) searchStatus.textContent = '';
  if (storageState && id) {
    try { await postApi('/api/search/cancel', { id }); }
    catch (error) { setStorageStatus(`検索を中止できませんでした: ${error.message}`, true); }
  }
  if (reload) await loadArticlePage(false);
}

async function runSearch() {
  if (!searchInput.value.trim()) { await cancelSearch(); return; }
  const epoch = ++searchEpoch;
  activeSearchId = null;
  btnCancelSearch.hidden = false;
  try {
    let job = await postApi('/api/search', {
      ...storageRequest(), query: searchInput.value, period: periodSelector?.value || 'recent'
    });
    if (epoch !== searchEpoch) {
      await postApi('/api/search/cancel', { id: job.id });
      return;
    }
    activeSearchJobId = job.id;
    while (job.status === 'running') {
      searchStatus.textContent = `本文・訳文を検索中 ${job.completed} / ${job.total}か月 · ${job.matches}件一致（途中経過）`;
      await new Promise(resolve => setTimeout(resolve, 150));
      if (epoch !== searchEpoch) return;
      const response = await fetch(`/api/search?id=${encodeURIComponent(job.id)}`);
      job = requireVersion(await response.json());
      if (!response.ok) throw new Error(job.error || `HTTP ${response.status}`);
    }
    if (epoch !== searchEpoch) return;
    if (job.status !== 'completed') throw new Error(job.error || '検索を中止しました。');
    activeSearchId = job.id;
    searchStatus.textContent = `検索完了 · ${job.matches}件一致`;
    await loadArticlePage(false);
  } catch (error) {
    if (epoch === searchEpoch) searchStatus.textContent = `検索できませんでした: ${error.message}`;
  }
}

async function toggleQueuePause() {
  try {
    const isPaused = queueBadge.textContent.includes('一時停止');
    const endpoint = isPaused ? '/api/queue/resume' : '/api/queue/pause';
    await postApi(endpoint, storageRequest());
    checkQueueStatus();
  } catch (err) {
    setStorageStatus(`一時停止・再開できませんでした: ${err.message}`, true);
  }
}

async function cancelQueue() {
  if (!confirm('翻訳キューを中止し、遅延結果を無効にしますか？ Copilot上での生成自体は停止しません。')) return;
  try {
    await postApi('/api/queue/clear', { storageGeneration: storageState?.storageGeneration });
    isTranslating = false;
    currentManualTargetId = null;
    resetTranslateButtons();
    checkQueueStatus();
  } catch (err) {
    setStorageStatus(`中止できませんでした: ${err.message}`, true);
  }
}

// Setup Event Listeners
function setupEvents() {
  setSidebarCollapsed(sidebar.classList.contains('collapsed'));

  // Navigation
  btnPrev.onclick = () => selectArticle(currentArticleIndex - 1);
  btnNext.onclick = () => selectArticle(currentArticleIndex + 1);

  // Translate Button
  if (btnTranslateHeader) {
    btnTranslateHeader.onclick = () => requestTranslateArticle();
  }

  // Period / Month Selector
  if (periodSelector) {
    periodSelector.onchange = () => applyPeriodFilter();
  }

  // Search and Filters
  searchInput.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); void runSearch(); }
  };
  if (btnSearch) btnSearch.onclick = () => runSearch();
  if (btnCancelSearch) btnCancelSearch.onclick = () => cancelSearch();
  if (btnMoreArticles) btnMoreArticles.onclick = () => loadArticlePage(true, currentArticleId);
  categoryFilter.onchange = () => applyFilters();
  statusFilter.onchange = () => applyFilters();

  // Mode Buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.onclick = () => setViewMode(btn.dataset.mode);
  });

  // Sidebar Toggle
  btnSidebarToggle.onclick = () => {
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
  };

  // Theme Toggle
  btnThemeToggle.onclick = () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    btnThemeToggle.textContent = isDark ? '☀️' : '🌙';
  };

  // Help Tooltip Toggle
  function toggleHelp(e) {
    if (e) e.stopPropagation();
    if (helpTooltipCard) {
      helpTooltipCard.classList.toggle('open');
    }
  }

  // Queue Controls
  if (batchOrderSelect) {
    batchOrderSelect.value = localStorage.getItem('batchOrder') === 'oldest' ? 'oldest' : 'newest';
    batchOrderSelect.onchange = () => localStorage.setItem('batchOrder', batchOrderSelect.value);
  }
  if (useAutoEfficiencyCheckbox) {
    useAutoEfficiencyCheckbox.onchange = async () => {
      const selected = useAutoEfficiencyCheckbox.checked;
      useAutoEfficiencyCheckbox.disabled = true;
      try {
        await postApi('/api/settings', { useAutoEfficiency: selected });
        if (storageState) storageState.useAutoEfficiency = selected;
        useAutoEfficiencyCheckbox.checked = selected;
      } catch (err) {
        useAutoEfficiencyCheckbox.checked = !selected;
        setStorageStatus(`モデル設定を保存できませんでした: ${err.message}`, true);
      } finally { useAutoEfficiencyCheckbox.disabled = false; }
    };
  }
  if (btnSaveStorage) btnSaveStorage.onclick = () => saveStorageSettings();
  if (btnReloadStorage) btnReloadStorage.onclick = () => reloadStorage();
  if (btnMigrate) btnMigrate.onclick = () => runMigration();
  document.getElementById('btn-storage-cancel-job').onclick = async () => {
    if (activeStorageJob) await postApi('/api/storage/cancel', { id: activeStorageJob });
  };
  const recover = async direction => {
    const record = storageState?.recovery || storageState?.destinationRecovery;
    if (!record || !confirm(direction === 'forward' ? '記録にある残りの変更を適用しますか？' : '記録にある変更前のデータへ戻しますか？')) return;
    try {
      await postApi('/api/storage/recover', {
        id: record.id, direction, storageGeneration: storageState.storageGeneration,
        ...(storageState.destinationRecovery && !storageState.recovery ? { directory: storageState.switchRecovery.destination } : {})
      });
      await loadData();
    } catch (error) { setStorageStatus(`復旧できませんでした: ${error.message}`, true); }
  };
  if (btnRecoverForward) btnRecoverForward.onclick = () => recover('forward');
  if (btnRecoverRollback) btnRecoverRollback.onclick = () => recover('rollback');
  if (storageDialog) {
    document.getElementById('btn-storage-cancel').onclick = () => closeStorageComparison();
    document.getElementById('btn-storage-overwrite').onclick = () => confirmStorageSwitch('overwrite');
    document.getElementById('btn-storage-migrate-destination').onclick = async () => {
      const directory = storagePreview?.destination.file;
      await closeStorageComparison();
      if (directory) {
        await runMigration(directory);
        await saveStorageSettings();
      }
    };
    document.getElementById('btn-storage-use').onclick = () => confirmStorageSwitch('use-destination');
    storageDialog.addEventListener('cancel', event => { event.preventDefault(); closeStorageComparison(); });
  }
  if (btnRecovery) btnRecovery.onclick = async () => {
    if (!storageState?.switchRecovery || !confirm('元・変更先ファイルと設定を確認しましたか？ 記録の解除後に /restart-session が必要です。')) return;
    try {
      await postApi('/api/storage/acknowledge-recovery', { id: storageState.switchRecovery.id });
      setStorageStatus('/restart-session 後にCanvasを開き直してください。');
      await loadData();
    } catch (error) { setStorageStatus(`切替記録を確認できませんでした: ${error.message}`, true); }
  };
  if (btnBatchTranslate) {
    btnBatchTranslate.onclick = () => enqueueBatchCurrentView();
  }
  if (btnRefreshArticles) {
    btnRefreshArticles.onclick = () => refreshArticles();
  }
  if (btnRefreshInfo && refreshTooltip) {
    btnRefreshInfo.onclick = () => {
      const isOpen = btnRefreshInfo.getAttribute('aria-expanded') === 'true';
      btnRefreshInfo.setAttribute('aria-expanded', String(!isOpen));
      btnRefreshInfo.parentElement.classList.toggle('is-open', !isOpen);
      refreshTooltip.hidden = isOpen;
    };
    btnRefreshInfo.onkeydown = (event) => {
      if (event.key === 'Escape') {
        btnRefreshInfo.setAttribute('aria-expanded', 'false');
        btnRefreshInfo.parentElement.classList.remove('is-open');
        refreshTooltip.hidden = true;
        btnRefreshInfo.blur();
      }
    };
  }
  if (btnQueueTogglePause) {
    btnQueueTogglePause.onclick = () => toggleQueuePause();
  }
  if (btnQueueCancel) {
    btnQueueCancel.onclick = () => cancelQueue();
  }

  if (btnHelpToggle) {
    btnHelpToggle.onclick = toggleHelp;
  }
  if (kbHintsBar) {
    kbHintsBar.onclick = toggleHelp;
  }

  // Close help popover on outside click
  document.addEventListener('click', (e) => {
    if (helpTooltipCard && helpTooltipCard.classList.contains('open')) {
      if (!helpTooltipCard.contains(e.target) && e.target !== btnHelpToggle) {
        helpTooltipCard.classList.remove('open');
      }
    }
  });

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (storageDialog?.open) return;
    // If typing in input, ignore navigation shortcuts
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
      if (e.key === 'Escape') {
        searchInput.blur();
      }
      return;
    }

    if (e.key === 'Escape') {
      if (helpTooltipCard && helpTooltipCard.classList.contains('open')) {
        helpTooltipCard.classList.remove('open');
        return;
      }
    }

    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      toggleHelp();
      return;
    }

    const key = e.key;

    // 記事一覧の表示 / 非表示
    if (key === 'b' || key === 'B') {
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    }
    // 記事移動: 次の記事 (→ / l / d)
    else if (key === 'ArrowRight' || key === 'l' || key === 'L' || key === 'd' || key === 'D') {
      btnNext.click();
    }
    // 記事移動: 前の記事 (← / h / a)
    else if (key === 'ArrowLeft' || key === 'h' || key === 'H' || key === 'a' || key === 'A') {
      btnPrev.click();
    }
    // 段落移動: 次の段落・下へ (↓ / j / s)
    else if (key === 'ArrowDown' || key === 'j' || key === 'J' || key === 's' || key === 'S') {
      e.preventDefault();
      moveBlock(1);
    }
    // 段落移動: 前の段落・上へ (↑ / k / w)
    else if (key === 'ArrowUp' || key === 'k' || key === 'K' || key === 'w' || key === 'W') {
      e.preventDefault();
      moveBlock(-1);
    }
    // AI翻訳の生成 (t / T)
    else if (key === 't' || key === 'T') {
      e.preventDefault();
      requestTranslateArticle();
    }
    // モード切替
    else if (key === '1') {
      setViewMode('side');
    } else if (key === '2') {
      setViewMode('interleaved');
    } else if (key === '3') {
      setViewMode('ja');
    } else if (key === '4') {
      setViewMode('en');
    } else if (key === '/') {
      e.preventDefault();
      searchInput.focus();
    }
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

// Client-side HTML sanitizer for article blocks to prevent XSS
function sanitizeHtml(html) {
  if (!html) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const allowedTags = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'CODE', 'PRE', 'P', 'BR', 'SPAN',
    'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR'
  ]);
  const allowedAttrs = new Set(['href', 'title', 'class', 'target', 'rel']);

  // Remove dangerous executable/interactive elements completely
  const dangerous = doc.body.querySelectorAll('script, style, iframe, object, embed, svg, math, form, input, button, textarea, select, template');
  dangerous.forEach(el => el.remove());

  // Recursively sanitize all nodes in post-order (children first)
  function sanitizeNode(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        // Recurse into child first so descendants are always sanitized
        sanitizeNode(child);

        if (!allowedTags.has(child.tagName)) {
          // Unwrap non-allowed element by moving sanitized children to parent
          while (child.firstChild) {
            child.parentNode.insertBefore(child.firstChild, child);
          }
          child.remove();
          continue;
        }

        // Filter attributes on allowed element
        const attrs = Array.from(child.attributes);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('on') || !allowedAttrs.has(name)) {
            child.removeAttribute(attr.name);
          } else if (name === 'href') {
            const rawVal = attr.value;
            // Remove ASCII and Unicode whitespace/control characters within scheme to prevent obfuscated javascript: URLs
            const stripped = rawVal.replace(/[\u0000-\u0020\u007F-\u009F\u200B-\u200D\uFEFF]/g, '').toLowerCase();
            const isAllowedScheme = (/^https?:\/\//i.test(rawVal) || /^mailto:/i.test(rawVal) || /^#[a-z0-9_-]+$/i.test(rawVal)) &&
              !stripped.startsWith('javascript:') &&
              !stripped.startsWith('data:') &&
              !stripped.startsWith('vbscript:');

            if (!isAllowedScheme) {
              child.removeAttribute('href');
            } else if (child.getAttribute('target') === '_blank') {
              child.setAttribute('rel', 'noopener noreferrer');
            }
          }
        }
      }
    }
  }

  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

// Init
setupEvents();
loadData().then(() => {
  startQueuePolling();
});
