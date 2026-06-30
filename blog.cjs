#!/usr/bin/env node
// ─── blog.cjs — Authority Studio AI content CLI ───────────────────────────────
//
// Usage:
//   node blog.cjs --new "your topic here"          Draft only — review before publishing
//   node blog.cjs --new "your topic here" --auto   Full pipeline in one pass (cron mode)
//   node blog.cjs --publish your-slug-here         Promote a reviewed draft to live
//   node blog.cjs --list                           Show all articles and their status
//
// Requires:
//   OPENAI_API_KEY in environment (already configured in your stack)
//
// File outputs:
//   blog/articles/{slug}.js   One file per article — never touches other articles
//   blogData.js               Index file — one import line added, nothing else changed
//   topic-queue.json          Popped when --auto flag is used by cron
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

// ─── Config ──────────────────────────────────────────────────────────────────

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const OPENAI_MODEL      = 'gpt-4o';
const ARTICLES_DIR      = path.join(__dirname, 'blog', 'articles');
const BLOG_DATA_PATH    = path.join(__dirname, 'blogData.js');
const TOPIC_QUEUE_PATH  = path.join(__dirname, 'topic-queue.json');
const SITE_BASE_URL     = 'https://authoritystudioai.com';
const AUTHOR_DEFAULT    = 'Authority Studio AI';
const MIN_WORD_COUNT    = 1100;

// ─── Guards ──────────────────────────────────────────────────────────────────

if (!OPENAI_API_KEY) {
  console.error('\n❌  OPENAI_API_KEY is not set in your environment.\n');
  process.exit(1);
}

if (!fs.existsSync(ARTICLES_DIR)) {
  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  console.log('📁  Created blog/articles/ directory');
}

if (!fs.existsSync(BLOG_DATA_PATH)) {
  fs.writeFileSync(BLOG_DATA_PATH,
`// blogData.js — Authority Studio AI content index
// One import per article. Add new articles at the bottom.
// Do not manually edit article content here — edit the article file directly.

${''/* imports injected below */}

var articles = [
];

export default articles;
`, 'utf8');
  console.log('📄  Created blogData.js index');
}

// ─── Argument parsing ────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const newIdx  = args.indexOf('--new');
const pubIdx  = args.indexOf('--publish');
const listIdx = args.indexOf('--list');
const isAuto  = args.includes('--auto');

const topic   = newIdx  !== -1 ? args[newIdx  + 1] : null;
const pubSlug = pubIdx  !== -1 ? args[pubIdx  + 1] : null;
const doList  = listIdx !== -1;

if (!topic && !pubSlug && !doList) {
  printHelp();
  process.exit(0);
}

// ─── Router ──────────────────────────────────────────────────────────────────

(async () => {
  try {
    if (doList)       await cmdList();
    else if (pubSlug) await cmdPublish(pubSlug);
    else if (topic)   await cmdNew(topic, isAuto);
  } catch (err) {
    console.error('\n❌  Fatal error:', err.message);
    process.exit(1);
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND: --list
// ─────────────────────────────────────────────────────────────────────────────

async function cmdList() {
  const files = fs.existsSync(ARTICLES_DIR)
    ? fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.js'))
    : [];

  if (files.length === 0) {
    console.log('\n📭  No articles yet. Run: node blog.cjs --new "your topic"\n');
    return;
  }

  console.log('\n── Articles ─────────────────────────────────────────────────\n');
  for (const file of files) {
    const raw  = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
    const slug = extractField(raw, 'slug');
    const status = extractField(raw, 'status');
    const title  = extractField(raw, 'title');
    const date   = extractField(raw, 'publishDate');
    const icon   = status === 'published' ? '✅' : '📝';
    console.log(`  ${icon}  [${status}]  ${title || slug}`);
    console.log(`       slug: ${slug}  |  date: ${date || '—'}`);
    console.log(`       url:  ${SITE_BASE_URL}/blog/${slug}\n`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND: --new
// ─────────────────────────────────────────────────────────────────────────────

async function cmdNew(topic, auto) {
  console.log(`\n🔍  Generating article plan for: "${topic}"\n`);

  // ── Step 1: Generate structured plan ──────────────────────────────────────
  const plan = await callOpenAI({
    system: systemPromptPlanner(),
    user: `Topic: ${topic}\n\nReturn a JSON object only. No markdown. No explanation.`,
    max_tokens: 1000,
    json: true,
  });

  const slug = plan.slug;
  const articlePath = path.join(ARTICLES_DIR, `${slug}.js`);

  if (fs.existsSync(articlePath)) {
    console.error(`❌  Article already exists: blog/articles/${slug}.js`);
    console.error('    Delete it first if you want to regenerate.\n');
    process.exit(1);
  }

  // ── Step 1b: Guard against duplicate target query (different slug, same topic) ──
  const existingTargets = collectExistingTargetQueries();
  const normalizedNewTarget = normalizeQuery(plan.targetQuery || topic);
  for (const existing of existingTargets) {
    if (normalizeQuery(existing.targetQuery) === normalizedNewTarget) {
      console.error(`❌  Duplicate target query detected.`);
      console.error(`    New article targets: "${plan.targetQuery}"`);
      console.error(`    Already covered by:  blog/articles/${existing.slug}.js`);
      console.error('    Remove this topic from topic-queue.json or choose a different angle.\n');
      process.exit(1);
    }
  }

  // ── Step 2: Show plan for review ──────────────────────────────────────────
  console.log('── Article Plan ────────────────────────────────────────────\n');
  console.log(`  Slug:        ${plan.slug}`);
  console.log(`  Title:       ${plan.title}`);
  console.log(`  Meta title:  ${plan.metaTitle}`);
  console.log(`  Meta desc:   ${plan.metaDescription}`);
  console.log(`  Target query:${plan.targetQuery}`);
  console.log(`  Category:    ${plan.category}`);
  console.log(`  Tags:        ${(plan.tags || []).join(', ')}`);
  console.log('\n  Outline:');
  (plan.outline || []).forEach((item, i) => {
    console.log(`    ${i + 1}. ${item}`);
  });
  console.log('\n────────────────────────────────────────────────────────────\n');

  // ── Step 3: Confirm outline (skip in auto mode) ───────────────────────────
  if (!auto) {
    const approved = await prompt('Approve outline and generate full draft? (y/n): ');
    if (approved.toLowerCase() !== 'y') {
      console.log('\n⛔  Cancelled. No files written.\n');
      process.exit(0);
    }
  } else {
    console.log('⚡  Auto mode — proceeding without prompt.\n');
  }

  // ── Step 4: Generate full article body ────────────────────────────────────
  console.log('✍️   Generating full article body...\n');

  const body = await callOpenAI({
    system: systemPromptWriter(),
    user: buildWriterPrompt(plan),
    max_tokens: 4000,
    json: false,
  });

  const wordCount = countWords(body);
  if (wordCount < MIN_WORD_COUNT) {
    console.warn(`⚠️   Warning: body is only ${wordCount} words (minimum ${MIN_WORD_COUNT}). Consider regenerating.`);
  }

  // ── Step 5: Build article object ──────────────────────────────────────────
  const today = todayISO();
  const article = {
    slug:             plan.slug,
    title:            plan.title,
    metaTitle:        plan.metaTitle,
    metaDescription:  plan.metaDescription,
    publishDate:      today,
    author:           AUTHOR_DEFAULT,
    category:         plan.category || 'LinkedIn Authority',
    tags:             plan.tags || [],
    wordCount:        wordCount,
    featuredImageAlt: plan.featuredImageAlt || plan.title,
    excerpt:          plan.excerpt || '',
    targetQuery:      plan.targetQuery || '',
    body:             body,
    relatedSlugs:     plan.relatedSlugs || [],
    internalLinks:    plan.internalLinks || [],
    status:           'draft',
    jsonLd:           null, // generated at render time — never authored manually
  };

  // ── Step 6: Write article file ────────────────────────────────────────────
  const fileContent = buildArticleFile(article);
  fs.writeFileSync(articlePath, fileContent, 'utf8');
  console.log(`✅  Draft saved: blog/articles/${slug}.js`);
  console.log(`    Word count: ${wordCount}`);

  // ── Step 7: Register in blogData.js index ─────────────────────────────────
  registerInIndex(slug);

  // ── Step 8: Auto mode still requires manual --publish ────────────────────
  // Auto mode generates the draft and opens a PR (handled by the GitHub Action).
  // It must NEVER auto-publish — quality review always happens in the PR.
  console.log('\n── Next steps ───────────────────────────────────────────────');
  console.log(`  1. Review:   blog/articles/${slug}.js`);
  console.log(`  2. Publish:  node blog.cjs --publish ${slug}`);
  console.log(`  3. After publish: trigger generate-snapshots workflow in GitHub Actions`);
  console.log(`  4. Then:     Request indexing in GSC for ${SITE_BASE_URL}/blog/${slug}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND: --publish
// ─────────────────────────────────────────────────────────────────────────────

async function cmdPublish(slug, skipConfirm) {
  const articlePath = path.join(ARTICLES_DIR, `${slug}.js`);

  if (!fs.existsSync(articlePath)) {
    console.error(`\n❌  Article not found: blog/articles/${slug}.js\n`);
    process.exit(1);
  }

  let raw = fs.readFileSync(articlePath, 'utf8');
  const status = extractField(raw, 'status');

  if (status === 'published') {
    console.log(`\n⚠️   Already published: ${slug}\n`);
    process.exit(0);
  }

  if (status !== 'draft') {
    console.error(`\n❌  Unexpected status "${status}" — expected "draft". Aborting.\n`);
    process.exit(1);
  }

  // Show summary
  const title      = extractField(raw, 'title');
  const metaTitle  = extractField(raw, 'metaTitle');
  const metaDesc   = extractField(raw, 'metaDescription');

  console.log('\n── Publish summary ─────────────────────────────────────────\n');
  console.log(`  Slug:       ${slug}`);
  console.log(`  Title:      ${title}`);
  console.log(`  Meta title: ${metaTitle}`);
  console.log(`  Meta desc:  ${metaDesc}`);
  console.log(`  URL:        ${SITE_BASE_URL}/blog/${slug}`);
  console.log('\n────────────────────────────────────────────────────────────\n');

  if (!skipConfirm) {
    const confirmed = await prompt('Publish this article? (y/n): ');
    if (confirmed.toLowerCase() !== 'y') {
      console.log('\n⛔  Cancelled. No changes made.\n');
      process.exit(0);
    }
  }

  // Update status and publishDate in file
  const today = todayISO();
  raw = raw.replace(/status:\s*'draft'/, `status:      'published'`);
  raw = raw.replace(/(publishDate:\s*')[^']*(')/,  `$1${today}$2`);
  fs.writeFileSync(articlePath, raw, 'utf8');

  // Ensure registered in index
  registerInIndex(slug);

  console.log(`\n✅  Published: ${slug}`);
  console.log('\n── Next steps ───────────────────────────────────────────────');
  console.log('  1. Trigger the generate-snapshots workflow in GitHub Actions');
  console.log('     (so Googlebot gets the pre-rendered HTML for this article)');
  console.log(`  2. Request indexing in GSC:`);
  console.log(`     ${SITE_BASE_URL}/blog`);
  console.log(`     ${SITE_BASE_URL}/blog/${slug}`);

  // Optional: trigger GitHub Actions workflow if token is available
  await maybeTrigerSnapshot(slug);

  console.log('\n────────────────────────────────────────────────────────────\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function callOpenAI({ system, user, max_tokens, json }) {
  const body = {
    model: OPENAI_MODEL,
    max_tokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user',   content: user   },
    ],
  };

  if (json) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${err}`);
  }

  const data    = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  if (json) {
    try {
      return JSON.parse(content);
    } catch {
      // Fallback: strip any accidental fences
      const clean = content.replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    }
  }

  return content.trim();
}

function systemPromptPlanner() {
  return `You are an expert SEO content strategist for Authority Studio AI — a LinkedIn authority intelligence platform that scores posts across 5 dimensions (Hook Strength, Clarity, Authority Depth, Retention, Originality) and provides Voice DNA fingerprinting, GEO Readiness scoring, and Personal-Best RAG compounding.

Your job is to plan a cornerstone SEO article that:
- Targets a specific search query professionals are actually searching
- Positions Authority Studio AI naturally in context — not as an advertisement
- Will rank in Google for B2B professionals, LinkedIn ghostwriters, founders, and consultants

Return a JSON object with exactly these fields:
{
  "slug": "url-safe-lowercase-with-hyphens",
  "title": "Display title for the article",
  "metaTitle": "SEO-optimised title under 60 chars — include the target query",
  "metaDescription": "Under 155 chars — specific, includes target query, no generic filler",
  "targetQuery": "The exact search query this article targets",
  "category": "One of: LinkedIn Authority | Content Strategy | Voice DNA | GEO Readiness | Ghostwriting | Benchmarking",
  "tags": ["array", "of", "4-6", "relevant", "tags"],
  "featuredImageAlt": "Descriptive alt text for the featured image",
  "excerpt": "2-3 sentence summary of the article — specific, no filler",
  "outline": ["Section 1 heading", "Section 2 heading", "Section 3 heading", "Section 4 heading", "Section 5 heading"],
  "relatedSlugs": [],
  "internalLinks": [
    { "anchor": "anchor text", "href": "/relevant-page" }
  ]
}

Internal link hrefs must be from this list only: /, /pricing, /authority-engine, /score, /voice-studio, /geo-audit, /linkedin-post-analyzer, /about`;
}

function systemPromptWriter() {
  return `You are a world-class B2B content writer for Authority Studio AI. You write authoritative, specific, practical articles for LinkedIn professionals — founders, consultants, ghostwriters, executives.

Writing rules — enforce every one, no exceptions:

1. Open with a specific, contestable claim — a sentence someone could disagree with. Never a definition. Never "X represents a measure of Y." Never a question. Never "In today's world" or "In the age of AI."

2. Every section must contain at least one of: a specific number, a named mechanism/framework, or a concrete before/after example. Generic statements like "engagement matters" or "quality content performs better" are FORBIDDEN without a specific number or named example attached in the same paragraph.

3. NEVER use vague intensifiers or filler hedges: "significantly," "various factors," "a range of," "essential," "crucial," "imagine," "akin to," "represents a measure of." If you catch yourself writing one of these, replace the sentence with a specific claim instead.

4. Reference Authority Studio AI naturally — it earns its place by solving a specific problem stated earlier in the same paragraph, not as a generic plug.

5. Target the specified search query in the first 60 words, naturally.

6. No filler transitions: no "Furthermore," "In conclusion," "It's worth noting," "Moreover," "In today's landscape."

7. End with one specific, actionable next step a reader can do in the next 10 minutes — not "start your journey" or "begin optimizing today."

8. Write in a direct, expert voice. Short sentences. No hedging language ("can help," "may improve," "tends to"). State things directly: "this does X," not "this can help with X."

9. Minimum 1100 words. Every paragraph must contain a specific claim, number, or example — if a paragraph could apply to any company in any industry, delete it and replace it with a paragraph that could only be about this specific topic.

10. Format with clear H2 subheadings matching the approved outline. No H1.

11. Do not use markdown code blocks. Use plain markdown headings (##) and paragraphs.

12. Before finishing, mentally check: does the article contain at least 5 specific numbers, named mechanisms, or concrete examples total? If not, it fails the quality bar — keep revising mentally until it does, then output the final version only.`;
}

function buildWriterPrompt(plan) {
  return `Write a full article using this approved plan.

Target query: ${plan.targetQuery}
Title: ${plan.title}
Excerpt: ${plan.excerpt}

Approved outline (use these as H2 subheadings in order):
${(plan.outline || []).map((s, i) => `${i + 1}. ${s}`).join('\n')}

Internal links to include naturally in the body:
${(plan.internalLinks || []).map(l => `- Anchor: "${l.anchor}" → href: ${l.href}`).join('\n') || 'None specified'}

Write the full article now. Start directly with the opening paragraph — do not repeat the title.`;
}

function buildArticleFile(article) {
  // Escape backticks and template literal syntax in body
  const safeBody = article.body
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');

  return `// blog/articles/${article.slug}.js
// Generated by blog.cjs — edit freely, never delete the export default line.
// Status: ${article.status} | Created: ${article.publishDate}

var article = {
  slug:            '${article.slug}',
  title:           '${esc(article.title)}',
  metaTitle:       '${esc(article.metaTitle)}',
  metaDescription: '${esc(article.metaDescription)}',
  publishDate:     '${article.publishDate}',
  author:          '${esc(article.author)}',
  category:        '${esc(article.category)}',
  tags:            ${JSON.stringify(article.tags)},
  wordCount:       ${article.wordCount},
  featuredImageAlt:'${esc(article.featuredImageAlt)}',
  excerpt:         '${esc(article.excerpt)}',
  targetQuery:     '${esc(article.targetQuery)}',
  relatedSlugs:    ${JSON.stringify(article.relatedSlugs)},
  internalLinks:   ${JSON.stringify(article.internalLinks, null, 2).replace(/\n/g, '\n  ')},
  status:          '${article.status}',
  jsonLd:          null,
  body: \`${safeBody}\`,
};

export default article;
`;
}

function registerInIndex(slug) {
  let index = fs.readFileSync(BLOG_DATA_PATH, 'utf8');

  const importLine  = `import ${slugToVar(slug)} from './blog/articles/${slug}.js';`;
  const alreadyImported = index.includes(`'./blog/articles/${slug}.js'`);

  if (!alreadyImported) {
    // Insert import before the articles array declaration
    index = index.replace(
      /^(var articles\s*=\s*\[)/m,
      `${importLine}\n\n$1`
    );
    console.log(`📎  Import added to blogData.js: ${importLine}`);
  }

  // Add to articles array if not already there
  const varName = slugToVar(slug);
  const alreadyInArray = index.includes(varName + ',') || index.includes(varName + '\n');

  if (!alreadyInArray) {
    index = index.replace(
      /^(var articles\s*=\s*\[)/m,
      `$1\n  ${varName},`
    );
    console.log(`📋  Added to articles array: ${varName}`);
  }

  fs.writeFileSync(BLOG_DATA_PATH, index, 'utf8');
}

async function maybeTrigerSnapshot(slug) {
  const token = process.env.GITHUB_TOKEN;
  const repo  = process.env.GITHUB_REPOSITORY; // e.g. "singhkamal06/Frontend-system-..."

  if (!token || !repo) return;

  console.log('\n🚀  Triggering generate-snapshots workflow via GitHub API...');

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/generate-snapshots.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/vnd.github+json',
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (res.status === 204) {
      console.log('✅  Snapshot workflow triggered — Googlebot will have fresh HTML within minutes.');
    } else {
      const err = await res.text();
      console.warn(`⚠️   Could not trigger workflow (${res.status}): ${err}`);
    }
  } catch (err) {
    console.warn('⚠️   Could not trigger workflow:', err.message);
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function collectExistingTargetQueries() {
  if (!fs.existsSync(ARTICLES_DIR)) return [];
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.js'));
  return files.map(file => {
    const raw = fs.readFileSync(path.join(ARTICLES_DIR, file), 'utf8');
    return {
      slug: extractField(raw, 'slug'),
      targetQuery: extractField(raw, 'targetQuery'),
    };
  }).filter(a => a.targetQuery);
}

function normalizeQuery(q) {
  return (q || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function slugToVar(slug) {
  // linkedin-authority-score → articleLinkedinAuthorityScore
  return 'article' + slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function esc(str) {
  return (str || '').replace(/'/g, "\\'");
}

function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function extractField(raw, field) {
  const match = raw.match(new RegExp(`${field}:\\s*'([^']*)'`));
  return match ? match[1] : '';
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function printHelp() {
  console.log(`
── blog.cjs — Authority Studio AI content CLI ──────────────────

  node blog.cjs --new "your topic"           Draft article, review before publish
  node blog.cjs --new "your topic" --auto    Full pipeline in one pass (cron mode)
  node blog.cjs --publish your-slug          Promote reviewed draft to live
  node blog.cjs --list                       Show all articles and status

Environment variables required:
  OPENAI_API_KEY        (required — already in your stack)
  GITHUB_TOKEN          (optional — auto-triggers snapshot workflow on publish)
  GITHUB_REPOSITORY     (optional — e.g. singhkamal06/your-repo-name)

────────────────────────────────────────────────────────────────
`);
}
