#!/usr/bin/env node
// generate-sitemap.cjs
//
// Rebuilds public/sitemap.xml from static routes + all published blog articles.
// Run manually or add as a step in weekly-draft.yml after --publish.
//
// Usage: node generate-sitemap.cjs

'use strict';

const fs   = require('fs');
const path = require('path');

var SITE_BASE_URL  = 'https://authoritystudioai.com';
var ARTICLES_DIR   = path.join(__dirname, 'blog', 'articles');
var SITEMAP_PATH   = path.join(__dirname, 'public', 'sitemap.xml');
var today          = new Date().toISOString().slice(0, 10);

// ── Static routes ─────────────────────────────────────────────────────────────
var staticUrls = [
  { loc: '/',                       priority: '1.0', changefreq: 'daily'   },
  { loc: '/signup',                  priority: '0.9', changefreq: 'weekly'  },
  { loc: '/login',                   priority: '0.8', changefreq: 'weekly'  },
  { loc: '/reset-password',          priority: '0.5', changefreq: 'monthly' },
  { loc: '/about',                   priority: '0.8', changefreq: 'weekly'  },
  { loc: '/contact',                 priority: '0.7', changefreq: 'weekly'  },
  { loc: '/pricing',                 priority: '0.9', changefreq: 'weekly'  },
  { loc: '/api-docs',                priority: '0.7', changefreq: 'weekly'  },
  { loc: '/changelog',               priority: '0.6', changefreq: 'weekly'  },
  { loc: '/authority-engine',        priority: '0.9', changefreq: 'weekly'  },
  { loc: '/linkedin-post-analyzer',  priority: '0.9', changefreq: 'weekly'  },
  { loc: '/voice-studio',            priority: '0.9', changefreq: 'weekly'  },
  { loc: '/geo-audit',               priority: '0.9', changefreq: 'weekly'  },
  { loc: '/privacy',                 priority: '0.3', changefreq: 'monthly' },
  { loc: '/privacy_policy',          priority: '0.3', changefreq: 'monthly' },
  { loc: '/terms',                   priority: '0.3', changefreq: 'monthly' },
  { loc: '/terms_of_service',        priority: '0.3', changefreq: 'monthly' },
  { loc: '/cookies',                 priority: '0.3', changefreq: 'monthly' },
  { loc: '/score',                   priority: '0.8', changefreq: 'weekly'  },
  { loc: '/blog',                    priority: '0.9', changefreq: 'daily'   },
];

// ── Published blog articles ───────────────────────────────────────────────────
var blogUrls = [];
if (fs.existsSync(ARTICLES_DIR)) {
  var files = fs.readdirSync(ARTICLES_DIR).filter(function(f) { return f.endsWith('.js'); });
  files.forEach(function(file) {
    var raw         = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
    var slugMatch   = raw.match(/slug:\s*'([^']*)'/);
    var statusMatch = raw.match(/status:\s*'([^']*)'/);
    var dateMatch   = raw.match(/publishDate:\s*'([^']*)'/);
    if (slugMatch && statusMatch && statusMatch[1] === 'published') {
      blogUrls.push({
        loc:        '/blog/' + slugMatch[1],
        lastmod:    dateMatch ? dateMatch[1] : today,
        priority:   '0.8',
        changefreq: 'weekly',
      });
    }
  });
  // Sort by publish date descending
  blogUrls.sort(function(a, b) {
    if (b.lastmod > a.lastmod) return 1;
    if (b.lastmod < a.lastmod) return -1;
    return 0;
  });
}

// ── Build XML ─────────────────────────────────────────────────────────────────
function urlEntry(u) {
  return [
    '  <url>',
    '    <loc>' + SITE_BASE_URL + u.loc + '</loc>',
    '    <lastmod>' + (u.lastmod || today) + '</lastmod>',
    '    <changefreq>' + u.changefreq + '</changefreq>',
    '    <priority>' + u.priority + '</priority>',
    '  </url>',
  ].join('\n');
}

var allEntries = staticUrls.map(urlEntry).concat(blogUrls.map(urlEntry));

var xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + allEntries.join('\n')
  + '\n</urlset>\n';

fs.writeFileSync(SITEMAP_PATH, xml, 'utf8');

console.log('sitemap.xml written to: ' + SITEMAP_PATH);
console.log('  Static URLs:  ' + staticUrls.length);
console.log('  Article URLs: ' + blogUrls.length);
console.log('  Total:        ' + (staticUrls.length + blogUrls.length));
