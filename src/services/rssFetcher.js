// src/services/rssFetcher.js
// Fetches RSS feeds, translates to Bengali, stores in DB
// Runs on cron schedule. Safe, legal, attributed aggregation.

require('dotenv').config();
const Parser = require('rss-parser');
const slugify = require('slugify');
const pool = require('../config/db');
const { translateBatch } = require('./translationService');
const logger = require('../utils/logger');

const rssParser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'TRPNews/1.0 (+https://trpnews.in/about)',
    'Accept': 'application/rss+xml, application/xml, text/xml',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
      ['enclosure', 'enclosure', { keepArray: false }],
    ]
  }
});

/**
 * Extract best available image from RSS item
 */
function extractImage(item) {
  if (item.mediaContent && item.mediaContent.$) return item.mediaContent.$.url;
  if (item.mediaThumbnail && item.mediaThumbnail.$) return item.mediaThumbnail.$.url;
  if (item.enclosure && item.enclosure.url && item.enclosure.type?.includes('image')) return item.enclosure.url;
  // Try to pull image from content HTML
  const match = (item.content || item['content:encoded'] || '').match(/<img[^>]+src="([^">]+)"/);
  return match ? match[1] : null;
}

/**
 * Clean HTML from summary text
 */
function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 500); // Cap summary at 500 chars
}

/**
 * Generate unique slug from Bengali title + timestamp
 */
function generateSlug(title) {
  const ts = Date.now().toString(36);
  const base = slugify(title.replace(/[^\x00-\x7F]/g, ''), { lower: true, strict: true });
  return `${base || 'news'}-${ts}`;
}

/**
 * Check if article already exists in DB (by source URL)
 */
async function articleExists(sourceUrl) {
  const result = await pool.query(
    'SELECT id FROM news_articles WHERE source_url = $1',
    [sourceUrl]
  );
  return result.rows.length > 0;
}

/**
 * Fetch a single RSS source and return new articles
 */
async function fetchSource(source) {
  const startTime = Date.now();
  logger.info(`📡 Fetching: ${source.name} → ${source.url}`);

  try {
    const feed = await rssParser.parseURL(source.url);
    const items = feed.items.slice(0, parseInt(process.env.MAX_ARTICLES_PER_SOURCE) || 10);

    const newArticles = [];
    for (const item of items) {
      const url = item.link || item.guid;
      if (!url) continue;
      const exists = await articleExists(url);
      if (exists) continue;

      newArticles.push({
        sourceUrl:     url,
        sourceName:    source.name,
        originalTitle: cleanText(item.title),
        summary:       cleanText(item.contentSnippet || item.summary || item.description),
        imageUrl:      extractImage(item),
        author:        item.creator || item.author || source.name,
        publishedAt:   item.pubDate ? new Date(item.pubDate) : new Date(),
        category:      source.category,
      });
    }

    logger.info(`  Found ${newArticles.length} new articles from ${source.name}`);

    // Translate in batch
    if (newArticles.length === 0) return { found: items.length, isNew: 0 };

    const translated = await translateBatch(
      newArticles.map(a => ({
        title:      a.originalTitle,
        summary:    a.summary,
        sourceName: a.sourceName,
        sourceUrl:  a.sourceUrl,
        category:   a.category,
      }))
    );

    // Insert into DB
    let inserted = 0;
    for (let i = 0; i < newArticles.length; i++) {
      const article = newArticles[i];
      const t = translated[i];
      const slug = generateSlug(t.bengaliTitle);

      try {
        await pool.query(`
          INSERT INTO news_articles (
            source_name, source_url, original_title, original_summary,
            bengali_title, bengali_summary, bengali_content,
            category, tags, image_url, author, published_at, slug, status
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        `, [
          article.sourceName,
          article.sourceUrl,
          article.originalTitle,
          article.summary,
          t.bengaliTitle,
          t.bengaliSummary,
          t.bengaliContent,
          t.category || article.category,
          t.tags,
          article.imageUrl,
          article.author,
          article.publishedAt,
          slug,
          'pending', // Always starts as pending — admin approves before publishing
        ]);
        inserted++;
      } catch (dbErr) {
        if (!dbErr.message.includes('unique')) {
          logger.error(`DB insert error: ${dbErr.message}`);
        }
      }
    }

    // Update source fetch stats
    await pool.query(
      'UPDATE rss_sources SET last_fetched = NOW(), fetch_count = fetch_count + 1 WHERE id = $1',
      [source.id]
    );

    const duration = Date.now() - startTime;
    await pool.query(
      'INSERT INTO fetch_logs (source_id, articles_found, articles_new, duration_ms) VALUES ($1,$2,$3,$4)',
      [source.id, items.length, inserted, duration]
    );

    logger.info(`  ✅ Inserted ${inserted} new articles from ${source.name} in ${duration}ms`);
    return { found: items.length, isNew: inserted };

  } catch (err) {
    logger.error(`❌ Error fetching ${source.name}: ${err.message}`);
    await pool.query(
      'UPDATE rss_sources SET error_count = error_count + 1 WHERE id = $1',
      [source.id]
    );
    await pool.query(
      'INSERT INTO fetch_logs (source_id, error, duration_ms) VALUES ($1,$2,$3)',
      [source.id, err.message, Date.now() - startTime]
    );
    return { found: 0, isNew: 0, error: err.message };
  }
}

/**
 * Main fetch job — runs all active sources sequentially
 */
async function runFetchJob() {
  logger.info('🚀 Starting RSS fetch job...');
  const start = Date.now();

  const { rows: sources } = await pool.query(
    'SELECT * FROM rss_sources WHERE active = TRUE ORDER BY id'
  );

  let totalNew = 0;
  for (const source of sources) {
    const result = await fetchSource(source);
    totalNew += result.isNew || 0;
    // Pause between sources to be a good citizen
    await new Promise(r => setTimeout(r, 2000));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`✅ Fetch job complete. ${totalNew} new articles in ${elapsed}s`);
}

// Run directly: node src/services/rssFetcher.js
if (require.main === module) {
  runFetchJob().then(() => process.exit(0)).catch(console.error);
}

module.exports = { runFetchJob, fetchSource };
