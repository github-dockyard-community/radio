import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dataPath = path.join(dataDir, 'changelog-all.json');
const legacyDataPath = path.join(dataDir, 'changelog-2026-09.json');

// Category mapping based on github-changelog-digest
const CATEGORY_MAP = [
  { name: 'Copilot', test: /copilot/i },
  { name: 'Models', test: /model|gpt|claude|grok|llama/i },
  { name: 'Project & Issues', test: /issues|projects|pull requests|planning/i },
  { name: 'Collaboration tools & Community engagement', test: /slack|teams|discussions|community/i },
  { name: 'Actions', test: /action|workflow|runner/i },
  { name: 'Codespaces', test: /codespace/i },
  { name: 'Packages', test: /package|npm|nuget|container registry/i },
  { name: 'Mobile', test: /mobile|ios|android/i },
  { name: 'Client apps', test: /desktop|cli/i },
  { name: 'Security', test: /security|codeql|secret|scanning|cve|vulnerability|advisory|ssh/i },
  { name: 'Administration & Enterprise', test: /enterprise|admin|scim|sso|managed/i },
  { name: 'Ecosystem & Accessibility', test: /ecosystem|accessibility/i },
  { name: 'Platform governance', test: /governance|compliance|audit/i },
  { name: 'Account management', test: /account|billing|subscription/i },
  { name: 'Miscellaneous', test: /.*/ }
];

export function mapCategory(categories, title) {
  const text = `${(categories || []).join(' ')} ${title || ''}`;
  for (const cat of CATEGORY_MAP) {
    if (cat.name === 'Miscellaneous') continue;
    if (cat.test.test(text)) return cat.name;
  }
  return 'Miscellaneous';
}

export function cleanHtmlToParagraphs(html) {
  if (!html) return [];
  let body = html
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<\/?(html|head|body)[^>]*>/gi, '')
    .replace(/<p class="post-meta">[\s\S]*?<\/p>/gi, '')
    .replace(/<p>The post <a[^>]*>.*?<\/a> appeared first on.*?<\/p>/gi, '')
    .trim();

  const blocks = [];
  const blockRegex = /<(p|h1|h2|h3|h4|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockRegex.exec(body)) !== null) {
    const tag = match[1].toLowerCase();
    const content = match[2].trim();
    if (!content) continue;
    if (content.includes('appeared first on') && content.includes('The GitHub Blog')) continue;

    blocks.push({
      tag,
      enHtml: content,
      enText: content.replace(/<[^>]+>/g, '').trim()
    });
  }
  return blocks;
}

export function mergeChangelogArticles(existingArticles, refreshedArticles) {
  const existingById = new Map(existingArticles.map(article => [article.id, article]));
  const refreshedById = new Map(refreshedArticles.map(article => {
    const existing = existingById.get(article.id);
    const existingBlocks = new Map((existing?.blocks || []).map(block => [block.id, block]));
    const titleJa = existing?.title === article.title ? existing.titleJa : '';
    const blocks = article.blocks.map(block => {
      const previous = existingBlocks.get(block.id);
      return { ...block, ja: previous?.enText === block.enText ? previous.ja : '' };
    });
    return [article.id, {
      ...article,
      titleJa,
      blocks,
      translated: Boolean(existing?.translated && titleJa && blocks.every(block => block.ja))
    }];
  }));
  const existingIds = new Set(existingArticles.map(article => article.id));
  const merged = existingArticles.map(existing => refreshedById.get(existing.id) || existing);

  for (const article of refreshedArticles) {
    if (!existingIds.has(article.id)) {
      merged.push(refreshedById.get(article.id));
    }
  }

  return merged;
}

function loadExistingArticles() {
  let existingArticles = [];

  if (fs.existsSync(dataPath)) {
    try {
      existingArticles = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    } catch (err) {
      throw new Error(`既存キャッシュを読み込めません (${dataPath})。ファイルを確認してください。`, { cause: err });
    }
  } else if (fs.existsSync(legacyDataPath)) {
    try {
      existingArticles = JSON.parse(fs.readFileSync(legacyDataPath, 'utf8'));
    } catch (err) {
      throw new Error(`既存キャッシュを読み込めません (${legacyDataPath})。ファイルを確認してください。`, { cause: err });
    }
  }
  if (!Array.isArray(existingArticles)) {
    throw new Error('既存キャッシュの記事一覧が不正です。更新を中止しました。');
  }

  return existingArticles;
}

export async function fetchAndSaveChangelog({ monthsBack = 4, maxPages = 30, verbose = false } = {}) {
  loadExistingArticles();
  const now = new Date();
  const stopDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);

  const refreshedArticles = [];
  let page = 1;
  let keepFetching = true;

  while (keepFetching && page <= maxPages) {
    const url = `https://github.blog/changelog/feed/?paged=${page}`;
    if (verbose) console.log(`[Changelog fetch] Page ${page}...`);

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new Error(`RSSの${page}ページ目を取得できません: ${err.message}`, { cause: err });
    }

    if (!res.ok) {
      if (page > 1 && res.status === 404) break;
      throw new Error(`RSSの${page}ページ目を取得できません: HTTP ${res.status}`);
    }

    let xml;
    try {
      xml = await res.text();
    } catch (err) {
      throw new Error(`RSSの${page}ページ目の本文を読み込めません: ${err.message}`, { cause: err });
    }
    if (!/<rss\b[^>]*>[\s\S]*<channel\b[^>]*>[\s\S]*<\/channel>\s*<\/rss>\s*$/i.test(xml)) {
      throw new Error(`RSSの${page}ページ目がRSS XMLではありません (HTTP ${res.status}, ${res.headers.get('content-type') || 'Content-Typeなし'})。`);
    }
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    if ((xml.match(/<item\b/g) || []).length !== [...xml.matchAll(itemRegex)].length) {
      throw new Error(`RSSの${page}ページ目の記事XMLが不正です。`);
    }
    let match;
    let countOnPage = 0;

    while ((match = itemRegex.exec(xml)) !== null) {
      countOnPage++;
      const itemContent = match[1];
      const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
      const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/, '$1').trim() : '';
      const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/);
      const link = linkMatch ? linkMatch[1].trim() : '';
      const pubDateMatch = itemContent.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const pubDateStr = pubDateMatch ? pubDateMatch[1].trim() : '';
      const pubDate = new Date(pubDateStr);
      if (!title || !link || !Number.isFinite(pubDate.getTime())) {
        throw new Error(`RSSの${page}ページ目の記事にタイトル・リンク・有効な日付がありません。`);
      }

      const encodedMatch = itemContent.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
      const html = encodedMatch ? encodedMatch[1].trim() : '';
      const categories = [...itemContent.matchAll(/<category domain="[^"]*"><!\[CDATA\[(.*?)\]\]><\/category>/g)].map(m => m[1]);

      if (pubDate < stopDate) {
        keepFetching = false;
        break;
      }

      const blocks = cleanHtmlToParagraphs(html);
      if (blocks.length === 0) {
        throw new Error(`RSSの${page}ページ目の記事本文が空または不正です。`);
      }
      const mappedCat = mapCategory(categories, title);
      const slug = link.replace(/.*\/changelog\//, '').replace(/\/$/, '');

      const articleBlocks = blocks.map((b, idx) => {
        const id = `b_${idx}`;
        return {
          id,
          tag: b.tag,
          en: b.enHtml,
          enText: b.enText,
          ja: ''
        };
      });

      refreshedArticles.push({
        id: slug,
        title,
        titleJa: '',
        link,
        pubDate: pubDateStr,
        date: pubDate.toISOString().split('T')[0],
        yearMonth: pubDate.toISOString().substring(0, 7),
        categories,
        category: mappedCat,
        translated: false,
        blocks: articleBlocks
      });
    }

    if (countOnPage === 0) {
      if (page === 1) throw new Error("RSSフィードに記事がありません。");
      break;
    }
    page++;
  }

  // Translation saves may have completed while the RSS requests were in flight.
  const allArticles = mergeChangelogArticles(loadExistingArticles(), refreshedArticles);
  if (refreshedArticles.length > 0) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const temporaryPath = `${dataPath}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(allArticles, null, 2), 'utf8');
      fs.renameSync(temporaryPath, dataPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
    if (verbose) {
      console.log(`Successfully fetched and saved ${allArticles.length} articles to ${dataPath}`);
    }
  }

  return allArticles;
}

// Direct execution CLI support
if (process.argv[1] === __filename) {
  fetchAndSaveChangelog({ verbose: true }).catch(err => {
    console.error('Error fetching changelog:', err);
    process.exit(1);
  });
}
