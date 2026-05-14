// src/routes/admin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { runFetchJob } = require('../services/rssFetcher');
const logger = require('../utils/logger');

const router = express.Router();

// ─── AUTH ──────────────────────────────────────────────

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { rows } = await pool.query('SELECT * FROM admins WHERE email = $1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: admin.id, email: admin.email, name: admin.name },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, admin: { id: admin.id, email: admin.email, name: admin.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ admin: req.admin });
});

// ─── NEWS QUEUE ────────────────────────────────────────

// GET /api/admin/queue?status=pending&category=&page=1
router.get('/queue', requireAuth, async (req, res) => {
  const { status = 'pending', category, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let where = 'WHERE 1=1';
    const params = [];
    let i = 1;

    if (status !== 'all') { where += ` AND a.status = $${i++}`; params.push(status); }
    if (category)         { where += ` AND a.category = $${i++}`; params.push(category); }

    const countRes = await pool.query(
      `SELECT COUNT(*) FROM news_articles a ${where}`, params
    );
    const total = parseInt(countRes.rows[0].count);

    const { rows } = await pool.query(`
      SELECT
        a.id, a.source_name, a.source_url, a.original_title,
        a.bengali_title, a.bengali_summary, a.category, a.tags,
        a.image_url, a.status, a.is_breaking, a.is_featured,
        a.published_at, a.fetched_at, a.slug, a.views,
        adm.name AS approved_by_name
      FROM news_articles a
      LEFT JOIN admins adm ON adm.id = a.approved_by
      ${where}
      ORDER BY a.fetched_at DESC
      LIMIT $${i} OFFSET $${i+1}
    `, [...params, limit, offset]);

    res.json({ articles: rows, total, page: +page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stats
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const [pending, approved, rejected, total, todayFetched, sources] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM news_articles WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM news_articles WHERE status='approved'"),
      pool.query("SELECT COUNT(*) FROM news_articles WHERE status='rejected'"),
      pool.query("SELECT COUNT(*) FROM news_articles"),
      pool.query("SELECT COUNT(*) FROM news_articles WHERE fetched_at > NOW() - INTERVAL '24 hours'"),
      pool.query("SELECT COUNT(*) FROM rss_sources WHERE active=TRUE"),
    ]);
    res.json({
      pending:      parseInt(pending.rows[0].count),
      approved:     parseInt(approved.rows[0].count),
      rejected:     parseInt(rejected.rows[0].count),
      total:        parseInt(total.rows[0].count),
      todayFetched: parseInt(todayFetched.rows[0].count),
      activeSources: parseInt(sources.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/articles/:id/approve
router.patch('/articles/:id/approve', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { is_breaking, is_featured, bengali_title, bengali_summary, bengali_content, category } = req.body;
  try {
    const { rows } = await pool.query(`
      UPDATE news_articles SET
        status = 'approved',
        approved_by = $1,
        approved_at = NOW(),
        is_breaking = COALESCE($2, is_breaking),
        is_featured = COALESCE($3, is_featured),
        bengali_title = COALESCE($4, bengali_title),
        bengali_summary = COALESCE($5, bengali_summary),
        bengali_content = COALESCE($6, bengali_content),
        category = COALESCE($7, category),
        updated_at = NOW()
      WHERE id = $8 RETURNING *
    `, [req.admin.id, is_breaking, is_featured, bengali_title, bengali_summary, bengali_content, category, id]);

    if (!rows.length) return res.status(404).json({ error: 'Article not found' });
    logger.info(`✅ Article #${id} approved by ${req.admin.email}`);
    res.json({ article: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/articles/:id/reject
router.patch('/articles/:id/reject', requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE news_articles SET status='rejected', updated_at=NOW() WHERE id=$1",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/articles/:id
router.delete('/articles/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM news_articles WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/fetch — manual trigger
router.post('/fetch', requireAuth, async (req, res) => {
  res.json({ message: 'Fetch job started in background' });
  runFetchJob().catch(err => logger.error('Manual fetch error:', err));
});

// ─── RSS SOURCES ────────────────────────────────────────

router.get('/sources', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM rss_sources ORDER BY id');
  res.json({ sources: rows });
});

router.post('/sources', requireAuth, async (req, res) => {
  const { name, url, category, language = 'en' } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO rss_sources (name, url, category, language) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, url, category || 'world', language]
    );
    res.json({ source: rows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/sources/:id/toggle', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE rss_sources SET active = NOT active WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  res.json({ source: rows[0] });
});

module.exports = router;
