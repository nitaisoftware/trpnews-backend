// src/routes/news.js
// Public-facing API — only serves APPROVED articles
// No copyright issues: we serve summaries + link to source

const express = require('express');
const pool = require('../config/db');
const router = express.Router();

const VALID_CATEGORIES = ['world','politics','india','sports','technology','business','entertainment','health','fun','science','environment'];

// GET /api/news?category=&page=1&limit=12
router.get('/', async (req, res) => {
  const { category, page = 1, limit = 12, search } = req.query;
  const offset = (page - 1) * limit;

  try {
    let where = "WHERE a.status = 'approved'";
    const params = [];
    let i = 1;

    if (category && VALID_CATEGORIES.includes(category)) {
      where += ` AND a.category = $${i++}`; params.push(category);
    }
    if (search) {
      where += ` AND (a.bengali_title ILIKE $${i} OR a.bengali_summary ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }

    const countRes = await pool.query(`SELECT COUNT(*) FROM news_articles a ${where}`, params);
    const total = parseInt(countRes.rows[0].count);

    const { rows } = await pool.query(`
      SELECT
        id, source_name, source_url, bengali_title, bengali_summary,
        category, tags, image_url, author, published_at, slug,
        is_breaking, is_featured, views
      FROM news_articles a
      ${where}
      ORDER BY is_featured DESC, is_breaking DESC, approved_at DESC
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, limit, offset]);

    res.json({ articles: rows, total, page: +page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/featured — hero articles for homepage
router.get('/featured', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, source_name, source_url, bengali_title, bengali_summary,
             category, image_url, slug, is_breaking, published_at
      FROM news_articles
      WHERE status = 'approved' AND (is_featured = TRUE OR is_breaking = TRUE)
      ORDER BY approved_at DESC LIMIT 5
    `);
    res.json({ articles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/breaking — ticker articles
router.get('/breaking', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT bengali_title, slug, category
      FROM news_articles
      WHERE status = 'approved' AND is_breaking = TRUE
      ORDER BY approved_at DESC LIMIT 8
    `);
    res.json({ articles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/trending — most viewed last 24h
router.get('/trending', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, bengali_title, category, slug, views
      FROM news_articles
      WHERE status = 'approved' AND approved_at > NOW() - INTERVAL '48 hours'
      ORDER BY views DESC LIMIT 10
    `);
    res.json({ articles: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/:slug — single article + increment views
router.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      UPDATE news_articles
      SET views = views + 1
      WHERE slug = $1 AND status = 'approved'
      RETURNING
        id, source_name, source_url, original_title,
        bengali_title, bengali_summary, bengali_content,
        category, tags, image_url, author, published_at,
        slug, is_breaking, is_featured, views
    `, [req.params.slug]);

    if (!rows.length) return res.status(404).json({ error: 'Article not found' });

    const article = rows[0];

    // Fetch related articles (same category)
    const { rows: related } = await pool.query(`
      SELECT id, bengali_title, slug, category, image_url, published_at
      FROM news_articles
      WHERE status = 'approved' AND category = $1 AND slug != $2
      ORDER BY approved_at DESC LIMIT 4
    `, [article.category, req.params.slug]);

    res.json({ article, related });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
