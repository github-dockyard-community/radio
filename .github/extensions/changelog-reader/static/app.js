// State
let allArticles = [];
let periodArticles = [];
let filteredArticles = [];
let currentArticleIndex = 0;
let currentMode = 'side'; // 'side' | 'interleaved' | 'ja' | 'en'
let activeBlockIndex = -1; // -1 means no block selected

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
  try {
    const res = await fetch('/api/articles');
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    allArticles = await res.json();
  } catch (err) {
    console.warn('API fetch failed, trying local relative fetch...', err);
    try {
      const fallback = await fetch('data/changelog-all.json');
      allArticles = await fallback.json();
    } catch (e2) {
      console.error('Failed to load articles data:', e2);
      return;
    }
  }

  // Sort descending by date
  allArticles.sort((a, b) => new Date(b.date) - new Date(a.date));

  populateMonthSelector();
  applyPeriodFilter();
  if (filteredArticles.length > 0) {
    selectArticle(0);
  }
}

// Populate Month Selector dynamically based on available data
function populateMonthSelector() {
  if (!monthOptgroup) return;
  const months = new Set();
  allArticles.forEach(a => {
    if (a.date) {
      months.add(a.date.substring(0, 7)); // "YYYY-MM"
    }
  });

  const sortedMonths = Array.from(months).sort().reverse();
  monthOptgroup.innerHTML = '';

  sortedMonths.forEach(ym => {
    const [y, m] = ym.split('-');
    const opt = document.createElement('option');
    opt.value = `month:${ym}`;
    const count = allArticles.filter(a => a.date && a.date.startsWith(ym)).length;
    opt.textContent = `${y}年${parseInt(m, 10)}月 (${count}件)`;
    monthOptgroup.appendChild(opt);
  });

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
  const selectedPeriod = periodSelector ? periodSelector.value : 'recent';

  if (selectedPeriod === 'all-time') {
    periodArticles = allArticles;
  } else if (selectedPeriod === 'recent') {
    const cutoff = getRecentCutoffDate();
    periodArticles = allArticles.filter(art => {
      const d = new Date(art.date + 'T00:00:00Z');
      return d >= cutoff;
    });
  } else if (selectedPeriod.startsWith('month:')) {
    const ym = selectedPeriod.replace('month:', '');
    periodArticles = allArticles.filter(art => art.date && art.date.startsWith(ym));
  } else {
    periodArticles = allArticles;
  }

  applyFilters(preserveArticleId);
}

// Filter Logic within currently active period
function applyFilters(preserveArticleId = null) {
  const query = (searchInput.value || '').toLowerCase().trim();
  const cat = categoryFilter.value;
  const status = statusFilter.value;

  filteredArticles = periodArticles.filter(art => {
    // Category match
    if (cat !== 'all' && art.category !== cat) return false;

    // Status match
    if (status === 'translated' && !art.translated) return false;
    if (status === 'untranslated' && art.translated) return false;

    // Query match
    if (query) {
      const matchTitleEn = art.title.toLowerCase().includes(query);
      const matchTitleJa = (art.titleJa || '').toLowerCase().includes(query);
      const matchBlocks = art.blocks.some(b => 
        (b.enText || '').toLowerCase().includes(query) || 
        (b.ja || '').toLowerCase().includes(query)
      );
      if (!matchTitleEn && !matchTitleJa && !matchBlocks) return false;
    }

    return true;
  });

  renderSidebarList();
  updateStats();

  if (filteredArticles.length > 0) {
    let nextIndex = 0;
    if (preserveArticleId) {
      const foundIdx = filteredArticles.findIndex(a => a.id === preserveArticleId);
      if (foundIdx !== -1) {
        nextIndex = foundIdx;
      }
    } else if (currentArticleIndex < filteredArticles.length) {
      nextIndex = currentArticleIndex;
    }
    currentArticleIndex = nextIndex;
    selectArticle(currentArticleIndex);
  } else {
    renderEmptyState();
  }
}

function updateStats() {
  const totalInPeriod = periodArticles.length;
  const filtered = filteredArticles.length;
  const translated = periodArticles.filter(a => a.translated).length;

  filteredCount.textContent = `${totalInPeriod}件中 ${filtered}件表示`;
  translatedRatio.textContent = `${translated}件 対訳済`;
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
function selectArticle(index) {
  if (index < 0 || index >= filteredArticles.length) return;
  currentArticleIndex = index;

  // Update sidebar active item
  const items = articleList.querySelectorAll('.article-list-item');
  items.forEach((it, i) => {
    it.classList.toggle('active', i === index);
  });

  // Ensure sidebar item is in view
  if (items[index]) {
    items[index].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Update nav controls
  navCounter.textContent = `${index + 1} / ${filteredArticles.length}`;
  btnPrev.disabled = index === 0;
  btnNext.disabled = index === filteredArticles.length - 1;

  // Render article content
  renderArticle(filteredArticles[index]);

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

// Translate Article via Background Queue (Priority Interrupt)
let isTranslating = false;
let currentManualTargetId = null;
let queuePollTimer = null;
let lastRefreshTime = 0;

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
    if (status.completedCount > 0 && queueStatusCard.style.display !== 'none') {
      queueBadge.textContent = '✅ 翻訳完了';
      queueBadge.className = 'queue-badge';
      queueCounts.textContent = `${status.completedCount} / ${status.totalSubmitted}`;
      queueProgressFill.style.width = '100%';
      queueCurrentTitle.textContent = 'すべてのタスクが完了しました';
      setTimeout(() => {
        if (!status.isProcessing && status.queueLength === 0) {
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
  try {
    const res = await fetch('/api/queue/status');
    if (!res.ok) return;
    const status = await res.json();
    updateQueueUI(status);

    if (status.isProcessing || status.completedCount > 0) {
      await refreshArticlesData();
    }
  } catch (err) {
    console.warn('Queue check error:', err);
  }
}

async function refreshArticlesData() {
  const now = Date.now();
  if (now - lastRefreshTime < 1800) return;
  lastRefreshTime = now;

  try {
    const res = await fetch('/api/articles');
    if (!res.ok) return;
    const articles = await res.json();

    let hasDiff = false;
    for (const newArt of articles) {
      const existing = allArticles.find(a => a.id === newArt.id);
      if (existing) {
        if (!existing.translated && newArt.translated) {
          Object.assign(existing, newArt);
          hasDiff = true;
        } else if (existing.translated && newArt.translated && (!existing.titleJa && newArt.titleJa)) {
          Object.assign(existing, newArt);
          hasDiff = true;
        }
      }
    }

    if (hasDiff) {
      const selectedId = filteredArticles[currentArticleIndex]?.id;
      applyPeriodFilter(selectedId);

      if (isTranslating && currentManualTargetId) {
        const manualArt = allArticles.find(a => a.id === currentManualTargetId);
        if (manualArt && manualArt.translated) {
          isTranslating = false;
          currentManualTargetId = null;
          resetTranslateButtons();
        }
      }
    }
  } catch (e) {
    console.warn('Refresh articles error:', e);
  }
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
  if (isTranslating) return;
  const currentArt = filteredArticles[currentArticleIndex];
  if (!currentArt) return;

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
    const res = await fetch(`/api/articles/${encodeURIComponent(currentArt.id)}/request-translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken()
      }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    startQueuePolling();
    checkQueueStatus();

    setTimeout(() => {
      if (isTranslating && currentManualTargetId === currentArt.id) {
        isTranslating = false;
        currentManualTargetId = null;
        resetTranslateButtons();
      }
    }, 180000);

  } catch (err) {
    console.error('Translation error:', err);
    alert(`翻訳リクエストエラー: ${err.message}`);
    isTranslating = false;
    currentManualTargetId = null;
    resetTranslateButtons();
  }
}

async function enqueueBatchCurrentView() {
  const untranslated = periodArticles.filter(a => !a.translated);
  if (untranslated.length === 0) {
    alert('現在の表示期間には、未翻訳の記事はありません（すべて対訳済みです）。');
    return;
  }

  const ordered = getBatchOrder() === 'oldest' ? [...untranslated].reverse() : untranslated;
  const orderLabel = getBatchOrder() === 'oldest' ? '古い順' : '新しい順';
  const confirmMsg = `現在の期間に含まれる未翻訳記事 ${untranslated.length} 件を、${orderLabel}に1件ずつ順次翻訳しますか？\n（途中で別の記事を手動翻訳すると最優先で割り込みます）`;
  if (!confirm(confirmMsg)) return;

  try {
    const articleIds = ordered.map(a => a.id);
    const res = await fetch('/api/queue/enqueue-batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': getCsrfToken()
      },
      body: JSON.stringify({ articleIds })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    startQueuePolling();
    checkQueueStatus();
  } catch (err) {
    alert(`一括キュー登録に失敗しました: ${err.message}`);
  }
}

async function toggleQueuePause() {
  try {
    const isPaused = queueBadge.textContent.includes('一時停止');
    const endpoint = isPaused ? '/api/queue/resume' : '/api/queue/pause';
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'X-CSRF-Token': getCsrfToken() }
    });
    checkQueueStatus();
  } catch (err) {
    console.error('Toggle pause error:', err);
  }
}

async function cancelQueue() {
  if (!confirm('残りの翻訳キューと作業環境をすべて停止・クリアしますか？')) return;
  try {
    await fetch('/api/queue/clear', {
      method: 'POST',
      headers: { 'X-CSRF-Token': getCsrfToken() }
    });
    isTranslating = false;
    currentManualTargetId = null;
    resetTranslateButtons();
    checkQueueStatus();
  } catch (err) {
    console.error('Cancel queue error:', err);
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
  searchInput.oninput = () => applyFilters();
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
    fetch('/api/settings')
      .then(r => r.json())
      .then(s => { useAutoEfficiencyCheckbox.checked = s.useAutoEfficiency !== false; })
      .catch(() => {});
    useAutoEfficiencyCheckbox.onchange = async () => {
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
          body: JSON.stringify({ useAutoEfficiency: useAutoEfficiencyCheckbox.checked })
        });
      } catch (err) {
        console.error('Failed to update settings:', err);
      }
    };
  }
  if (btnBatchTranslate) {
    btnBatchTranslate.onclick = () => enqueueBatchCurrentView();
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
