// generate-snapshots.cjs
//
// Run with: node generate-snapshots.cjs
// Requires: npm install playwright @supabase/supabase-js
//           npx playwright install chromium
//
// Reads published article slugs dynamically from blog/articles/*.js
// so new articles are snapshotted automatically without editing this file.

'use strict';

const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

const SITE_BASE_URL          = 'https://authoritystudioai.com';
const SUPABASE_URL           = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SNAPSHOT_BUCKET        = 'prerendered-pages';

// ── Dynamically collect published blog article routes ────────────────────────
function getBlogRoutes() {
  var articlesDir = path.join(__dirname, 'blog', 'articles');
  if (!fs.existsSync(articlesDir)) return [];
  return fs.readdirSync(articlesDir)
    .filter(function(f) { return f.endsWith('.js'); })
    .reduce(function(acc, file) {
      var raw = fs.readFileSync(path.join(articlesDir, file), 'utf8');
      var slugMatch   = raw.match(/slug:\s*'([^']*)'/);
      var statusMatch = raw.match(/status:\s*'([^']*)'/);
      if (slugMatch && statusMatch && statusMatch[1] === 'published') {
        acc.push({
          path: '/blog/' + slugMatch[1],
          key:  'blog-' + slugMatch[1] + '.html',
        });
      }
      return acc;
    }, []);
}

// Keep this list in sync with App.jsx's public routes and the
// SNAPSHOT_ROUTES map in prerender-proxy/index.ts.
// Blog article routes are appended dynamically — no manual edits needed.
var ROUTES = [
  { path: '/',                       key: 'home.html' },
  { path: '/pricing',                key: 'pricing.html' },
  { path: '/authority-engine',       key: 'authority-engine.html' },
  { path: '/score',                  key: 'score.html' },
  { path: '/voice-studio',           key: 'voice-studio.html' },
  { path: '/geo-audit',              key: 'geo-audit.html' },
  { path: '/linkedin-post-analyzer', key: 'linkedin-post-analyzer.html' },
  { path: '/about',                  key: 'about.html' },
  { path: '/contact',                key: 'contact.html' },
  { path: '/blog',                   key: 'blog.html' },
].concat(getBlogRoutes());

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
    process.exit(1);
  }

  console.log('Routes to snapshot: ' + ROUTES.length);
  ROUTES.forEach(function(r) { console.log('  ' + r.path); });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const browser  = await chromium.launch();
  const page     = await browser.newPage();

  let successCount = 0;
  let failCount    = 0;

  for (const route of ROUTES) {
    const url = SITE_BASE_URL + route.path;
    try {
      console.log('Rendering', url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      // Give react-helmet and any async data fetches a moment to settle
      // beyond networkidle (charts/animations can trail slightly).
      await page.waitForTimeout(1500);
      const html = await page.content();

      const { error } = await supabase.storage
        .from(SNAPSHOT_BUCKET)
        .upload(route.key, html, {
          contentType: 'text/html; charset=utf-8',
          upsert: true,
        });

      if (error) {
        console.error('Upload failed for', route.key, error.message);
        failCount++;
      } else {
        console.log('Snapshot saved:', route.key, '(' + html.length + ' chars)');
        successCount++;
      }
    } catch (err) {
      console.error('Render failed for', url, err.message);
      failCount++;
    }
  }

  await browser.close();
  console.log('Done. ' + successCount + ' succeeded, ' + failCount + ' failed.');
  if (failCount > 0) process.exit(1);
}

main();
