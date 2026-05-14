// src/services/translationService.js
// Uses Claude API to translate English news to Bengali
// This is your UNIQUE VALUE ADD — not copying, but translating + summarizing

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Category name mapping English → Bengali
const CATEGORY_BENGALI = {
  world:       'বিশ্ব',
  politics:    'রাজনীতি',
  india:       'ভারত',
  sports:      'খেলাধুলা',
  technology:  'প্রযুক্তি',
  business:    'ব্যবসা',
  entertainment: 'বিনোদন',
  health:      'স্বাস্থ্য',
  fun:         'মজার খবর',
  science:     'বিজ্ঞান',
  environment: 'পরিবেশ',
};

/**
 * Auto-detect category from title + summary using keyword matching
 * Falls back to Claude if ambiguous
 */
function detectCategory(title, summary) {
  const text = (title + ' ' + (summary || '')).toLowerCase();

  const rules = [
    { category: 'sports',        keywords: ['cricket','ipl','football','fifa','olympic','sport','match','tournament','player','goal','wicket','tennis','f1','nba'] },
    { category: 'technology',    keywords: ['ai','apple','google','microsoft','tech','software','cyber','robot','data','startup','app','iphone','android'] },
    { category: 'politics',      keywords: ['election','parliament','president','minister','government','party','vote','congress','BJP','modi','policy','senate','congress'] },
    { category: 'business',      keywords: ['stock','market','economy','bank','gdp','inflation','company','trade','profit','investment','rupee','dollar'] },
    { category: 'health',        keywords: ['covid','health','hospital','doctor','vaccine','disease','cancer','treatment','medicine','who','patient'] },
    { category: 'entertainment', keywords: ['bollywood','film','movie','actor','singer','music','award','oscar','celebrity','netflix','series'] },
    { category: 'science',       keywords: ['nasa','space','planet','science','research','study','climate','discovery','experiment'] },
    { category: 'fun',           keywords: ['weird','funny','bizarre','unusual','viral','odd','strange','amazing','incredible','shocking'] },
    { category: 'environment',   keywords: ['climate','environment','pollution','forest','wildlife','nature','green','carbon','flood','drought'] },
    { category: 'india',         keywords: ['india','delhi','mumbai','kolkata','bengal','modi','bjp','congress','rupee','ncr'] },
  ];

  for (const rule of rules) {
    if (rule.keywords.some(kw => text.includes(kw))) {
      return rule.category;
    }
  }
  return 'world';
}

/**
 * Translate a news article to Bengali using Claude
 * Returns: { bengaliTitle, bengaliSummary, bengaliContent, category }
 *
 * LEGAL NOTE: We translate & summarize only. Original source is always linked.
 * This is transformative editorial work, not reproduction.
 */
async function translateArticle(article) {
  const { title, summary, sourceName, sourceUrl, category } = article;

  const prompt = `You are a professional Bengali news journalist. Translate and adapt this English news snippet into natural, readable Bengali for a Bengali-speaking audience.

IMPORTANT RULES:
1. Write a Bengali HEADLINE (শিরোনাম) — compelling, journalistic
2. Write a Bengali SUMMARY (সারসংক্ষেপ) — 2-3 sentences, original phrasing, DO NOT copy the English verbatim
3. Write Bengali CONTENT (বিষয়বস্তু) — 4-6 sentences expanding the story in your own words
4. Detect the CATEGORY from: world, politics, india, sports, technology, business, entertainment, health, fun, science, environment
5. List 3-5 TAGS in Bengali (e.g., ভারত, রাজনীতি, বাজেট)

English Title: ${title}
English Summary: ${summary || 'No summary available'}
News Source: ${sourceName}

Respond ONLY in this exact JSON format (no markdown, no extra text):
{
  "bengaliTitle": "...",
  "bengaliSummary": "...",
  "bengaliContent": "...",
  "category": "...",
  "tags": ["...", "...", "..."]
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text.trim();
    // Strip any accidental markdown fences
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      bengaliTitle:   parsed.bengaliTitle   || title,
      bengaliSummary: parsed.bengaliSummary || '',
      bengaliContent: parsed.bengaliContent || '',
      category:       parsed.category       || detectCategory(title, summary),
      tags:           parsed.tags           || [],
    };
  } catch (err) {
    logger.error(`Translation failed for "${title}": ${err.message}`);
    // Graceful fallback — keep original title, mark for re-translation
    return {
      bengaliTitle:   title,
      bengaliSummary: summary || '',
      bengaliContent: '',
      category:       detectCategory(title, summary),
      tags:           [],
    };
  }
}

/**
 * Batch translate multiple articles with rate limiting
 * Claude Haiku is cheap: ~$0.00025 per article
 */
async function translateBatch(articles, delayMs = 500) {
  const results = [];
  for (let i = 0; i < articles.length; i++) {
    const result = await translateArticle(articles[i]);
    results.push(result);
    logger.info(`Translated ${i + 1}/${articles.length}: ${result.bengaliTitle.substring(0, 50)}...`);
    // Small delay to avoid rate limits
    if (i < articles.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

module.exports = { translateArticle, translateBatch, detectCategory, CATEGORY_BENGALI };
