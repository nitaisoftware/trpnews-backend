// src/models/migrate.js
// Run with: node src/models/migrate.js

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔧 Running database migrations...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id          SERIAL PRIMARY KEY,
        email       VARCHAR(255) UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        name        VARCHAR(255) DEFAULT 'Admin',
        created_at  TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS news_articles (
        id              SERIAL PRIMARY KEY,
        source_name     VARCHAR(100) NOT NULL,
        source_url      VARCHAR(500) NOT NULL,
        original_title  TEXT NOT NULL,
        original_summary TEXT,
        bengali_title   TEXT,
        bengali_summary TEXT,
        bengali_content TEXT,
        category        VARCHAR(50) DEFAULT 'world',
        tags            TEXT[] DEFAULT '{}',
        image_url       VARCHAR(1000),
        author          VARCHAR(255),
        published_at    TIMESTAMP,
        fetched_at      TIMESTAMP DEFAULT NOW(),
        status          VARCHAR(20) DEFAULT 'pending',
        approved_by     INTEGER REFERENCES admins(id),
        approved_at     TIMESTAMP,
        slug            VARCHAR(500) UNIQUE,
        views           INTEGER DEFAULT 0,
        is_breaking     BOOLEAN DEFAULT FALSE,
        is_featured     BOOLEAN DEFAULT FALSE,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rss_sources (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        url         VARCHAR(500) NOT NULL UNIQUE,
        category    VARCHAR(50) DEFAULT 'world',
        language    VARCHAR(10) DEFAULT 'en',
        active      BOOLEAN DEFAULT TRUE,
        last_fetched TIMESTAMP,
        fetch_count  INTEGER DEFAULT 0,
        error_count  INTEGER DEFAULT 0,
        created_at  TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fetch_logs (
        id          SERIAL PRIMARY KEY,
        source_id   INTEGER REFERENCES rss_sources(id),
        articles_found  INTEGER DEFAULT 0,
        articles_new    INTEGER DEFAULT 0,
        error       TEXT,
        duration_ms INTEGER,
        created_at  TIMESTAMP DEFAULT NOW()
      );
    `);

    // Indexes for performance
    await client.query(`CREATE INDEX IF NOT EXISTS idx_articles_status ON news_articles(status);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_articles_category ON news_articles(category);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_articles_created ON news_articles(created_at DESC);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_articles_slug ON news_articles(slug);`);

    // Seed RSS sources
    await client.query(`
      INSERT INTO rss_sources (name, url, category, language) VALUES
        ('BBC World News',        'http://feeds.bbci.co.uk/news/world/rss.xml',             'world',         'en'),
        ('BBC Technology',        'http://feeds.bbci.co.uk/news/technology/rss.xml',         'technology',    'en'),
        ('BBC Sport',             'http://feeds.bbci.co.uk/sport/rss.xml',                  'sports',        'en'),
        ('Reuters Top News',      'https://feeds.reuters.com/reuters/topNews',               'world',         'en'),
        ('Reuters Business',      'https://feeds.reuters.com/reuters/businessNews',          'business',      'en'),
        ('Reuters Sports',        'https://feeds.reuters.com/reuters/sportsNews',            'sports',        'en'),
        ('Al Jazeera English',    'https://www.aljazeera.com/xml/rss/all.xml',               'world',         'en'),
        ('AP Top News',           'https://feeds.apnews.com/rss/apf-topnews',               'world',         'en'),
        ('Times of India',        'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', 'india',      'en'),
        ('NDTV News',             'https://feeds.feedburner.com/ndtvnews-top-stories',       'india',        'en'),
        ('ESPN Cricket',          'https://www.espncricinfo.com/rss/content/story/feeds/0.xml','sports',      'en'),
        ('TechCrunch',            'https://techcrunch.com/feed/',                            'technology',    'en'),
        ('Funny / Odd News',      'https://www.theguardian.com/tone/features/rss',           'fun',           'en')
      ON CONFLICT (url) DO NOTHING;
    `);

    console.log('✅ Database migration complete!');
    console.log('✅ RSS sources seeded!');

    // Create default admin
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
    await client.query(`
      INSERT INTO admins (email, password, name)
      VALUES ($1, $2, 'TRP News Admin')
      ON CONFLICT (email) DO NOTHING;
    `, [process.env.ADMIN_EMAIL || 'admin@trpnews.in', hashedPassword]);
    console.log('✅ Default admin created!');

  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    client.release();
    pool.end();
  }
}

migrate();
