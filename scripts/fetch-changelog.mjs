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

export async function fetchAndSaveChangelog({ monthsBack = 4, maxPages = 30, verbose = false } = {}) {
  const existingTranslations = {};

  if (fs.existsSync(dataPath)) {
    try {
      const existingArticles = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      for (const a of existingArticles) {
        if (a.translated) {
          existingTranslations[a.id] = {
            titleJa: a.titleJa,
            blocks: (a.blocks || []).map(b => ({ id: b.id, ja: b.ja }))
          };
        }
      }
    } catch {
      // Ignore parse errors on corrupted local cache
    }
  } else if (fs.existsSync(legacyDataPath)) {
    try {
      const existingArticles = JSON.parse(fs.readFileSync(legacyDataPath, 'utf8'));
      for (const a of existingArticles) {
        if (a.translated) {
          existingTranslations[a.id] = {
            titleJa: a.titleJa,
            blocks: (a.blocks || []).map(b => ({ id: b.id, ja: b.ja }))
          };
        }
      }
    } catch {
      // Ignore
    }
  }

  const now = new Date();
  const stopDate = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);

  const allArticles = [];
  let page = 1;
  let keepFetching = true;

  while (keepFetching && page <= maxPages) {
    const url = `https://github.blog/changelog/feed/?paged=${page}`;
    if (verbose) console.log(`[Changelog fetch] Page ${page}...`);

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (verbose) console.error(`Failed to fetch page ${page}:`, err);
      break;
    }

    if (!res.ok) break;

    const xml = await res.text();
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
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

      const encodedMatch = itemContent.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
      const html = encodedMatch ? encodedMatch[1].trim() : '';
      const categories = [...itemContent.matchAll(/<category domain="[^"]*"><!\[CDATA\[(.*?)\]\]><\/category>/g)].map(m => m[1]);

      if (pubDate < stopDate) {
        keepFetching = false;
        break;
      }

      const blocks = cleanHtmlToParagraphs(html);
      const mappedCat = mapCategory(categories, title);
      const slug = link.replace(/.*\/changelog\//, '').replace(/\/$/, '');

      const existing = existingTranslations[slug];
      const translated = !!existing;
      const transMap = existing ? new Map(existing.blocks.map(b => [b.id, b.ja])) : null;

      allArticles.push({
        id: slug,
        title,
        titleJa: existing ? existing.titleJa : '',
        link,
        pubDate: pubDateStr,
        date: pubDate.toISOString().split('T')[0],
        yearMonth: pubDate.toISOString().substring(0, 7),
        categories,
        category: mappedCat,
        translated,
        blocks: blocks.map((b, idx) => ({
          id: `b_${idx}`,
          tag: b.tag,
          en: b.enHtml,
          enText: b.enText,
          ja: (transMap && transMap.get(`b_${idx}`)) || ''
        }))
      });
    }

    if (countOnPage === 0) break;
    page++;
  }

  if (allArticles.length > 0) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(dataPath, JSON.stringify(allArticles, null, 2), 'utf8');
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
