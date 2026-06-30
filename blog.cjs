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

  // ── Step 4: Generate full article body — section by section, deterministic ──
  // Single-call generation was unreliable (model undershot 1100 words repeatedly
  // even with retries). Generating per-section guarantees total length, because
  // each section call only needs to hit ~180 words, which the model reliably does.
  console.log('✍️   Generating article body, section by section...\n');

  const opening = await generateSection({
    plan,
    sectionLabel: 'Opening paragraph',
    instruction: `Write the opening paragraph only — 70-90 words. Make a specific, contestable claim about "${plan.targetQuery}". Do not use a heading. Do not summarize what the article will cover — start directly with the claim.`,
    minWords: 60,
  });

  const sections = [];
  for (let i = 0; i < (plan.outline || []).length; i++) {
    const heading = plan.outline[i];
    const sectionBody = await generateSection({
      plan,
      sectionLabel: `Section ${i + 1}: ${heading}`,
      instruction: `Write the full section for the heading "## ${heading}". 180-230 words. Include the heading line itself. Develop one named mechanism, framework, or fully worked example in detail — do not summarize it in one sentence. Do not invent statistics or percentages. Do not use filler transitions.`,
      minWords: 160,
    });
    sections.push(sectionBody);
  }

  const closing = await generateSection({
    plan,
    sectionLabel: 'Closing paragraph',
    instruction: `Write a closing paragraph only — 60-90 words. No heading. End with one specific, actionable next step the reader can do in the next 10 minutes. Do not write "start your journey" or generic calls to action.`,
    minWords: 50,
  });

  const body = [opening, ...sections, closing].join('\n\n');
  const wordCount = countWords(body);

  console.log(`✅  Assembled article: ${wordCount} words across ${sections.length} sections.\n`);

  if (wordCount < MIN_WORD_COUNT) {
    console.error(`❌  Article rejected: assembled body is only ${wordCount} words (minimum ${MIN_WORD_COUNT}).`);
    console.error('    This should be rare with section-by-section generation. No file written.\n');
    process.exit(1);
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
  return `You are a world-class B2B content writer for Authority Studio AI. You write authoritative, specific, practical content for LinkedIn professionals — founders, consultants, ghostwriters, executives.

You will be asked to write ONE piece of an article at a time (an opening paragraph, one section, or a closing paragraph). Follow the specific instruction given exactly, including its word count range.

Rules that apply to every piece you write:

1. Never use vague intensifiers or filler hedges: "significantly," "various factors," "a range of," "essential," "crucial," "imagine," "akin to," "represents a measure of."

2. Never invent statistics, percentages, or study citations. If you do not have a verified number, do not fabricate one — use a named mechanism or a clearly reasoned worked example instead.

3. Reference Authority Studio AI naturally only when it directly solves the specific problem being discussed in that section — never as a generic plug.

4. No filler transitions: no "Furthermore," "In conclusion," "It's worth noting," "Moreover," "In today's landscape."

5. Write in a direct, expert voice. Short sentences. No hedging language ("can help," "may improve," "tends to"). State things directly.

6. Plain text or markdown paragraph only — no markdown code blocks, no extra commentary about what you're doing, just the requested content.

7. Hit the word count range given in the instruction. If a section is given 180-230 words, do not stop at 90 — develop the named mechanism or example fully with concrete, specific detail until you reach the target.`;
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

// ─── Section-by-section generation ─────────────────────────────────────────

async function generateSection(opts) {
  const plan = opts.plan;
  const sectionLabel = opts.sectionLabel;
  const instruction = opts.instruction;
  const minWords = opts.minWords;

  const MAX_SECTION_ATTEMPTS = 2;
  let text = '';
  let words = 0;

  for (let attempt = 1; attempt <= MAX_SECTION_ATTEMPTS; attempt++) {
    const userPrompt = `Article title: ${plan.title}\nTarget query: ${plan.targetQuery}\n\n${instruction}` +
      (attempt > 1 ? `\n\nYour previous attempt was only ${words} words — too short. Expand the worked example with more concrete detail this time.` : '');

    text = await callOpenAI({
      system: systemPromptWriter(),
      user: userPrompt,
      max_tokens: 700,
      json: false,
    });

    words = countWords(text);

    if (words >= minWords) {
      console.log(`  ${sectionLabel}: ${words} words`);
      return text.trim();
    }
  }

  console.log(`  ${sectionLabel}: ${words} words (under target, using as-is)`);
  return text.trim();
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
