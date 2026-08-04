const { subDays, startOfDay } = require("date-fns");

const VAPI_SITE = "https://vapi.ai";
const VAPI_DOCS = "https://docs.vapi.ai";

// Blog categories to watch. Posts appearing in more than one are returned once,
// with every category they belong to.
const BLOG_CATEGORIES = ["agent_building", "features"];

const MONTHS = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Fetch a URL as text, throwing on a non-2xx response.
 */
async function fetchText(url) {
    const res = await fetch(url, {
        headers: { "User-Agent": "ai-news-digest/1.0" },
    });

    if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    }

    return res.text();
}

/**
 * Parse a card date like "APR 15, 2026" into a Date.
 */
function parseCardDate(raw) {
    const match = raw.match(/([A-Z]{3})\s+(\d{1,2}),\s+(\d{4})/);
    if (!match) return null;

    const month = MONTHS[match[1]];
    if (month === undefined) return null;

    return new Date(Number(match[3]), month, Number(match[2]));
}

/**
 * Extract post cards from a rendered category page.
 *
 * Each card is an anchor of the form:
 *   <a href="/blog/{slug}"> ...<img alt="{title}">... {DATE} {title} </a>
 */
function parseCategoryPage(html, category) {
    const posts = [];
    const cardPattern = /<a\b[^>]*href="\/blog\/([a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi;

    for (const [, slug, body] of html.matchAll(cardPattern)) {
        const text = body
            .replace(/<img[^>]*>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const dateMatch = text.match(/([A-Z]{3})\s+\d{1,2},\s+\d{4}/);
        if (!dateMatch) continue; // nav links and the newsletter CTA carry no date

        const date = parseCardDate(dateMatch[0]);
        if (!date) continue;

        // Card text runs "{Category label} {DATE} {Title}", so the title is
        // whatever follows the date.
        const title = text.slice(dateMatch.index + dateMatch[0].length).trim();

        posts.push({
            slug,
            title,
            date,
            category,
            url: `${VAPI_SITE}/blog/${slug}`,
        });
    }

    return posts;
}

/**
 * Fetch Vapi blog posts from the watched categories, published within the
 * last `numDaysAgo` days.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, title, date, categories }>>} newest first
 */
async function fetchVapiBlogPosts(numDaysAgo) {
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));
    const bySlug = new Map();

    for (const category of BLOG_CATEGORIES) {
        const url = `${VAPI_SITE}/blog/category/${category}`;

        let html;
        try {
            html = await fetchText(url);
        } catch (err) {
            console.error(`Failed to fetch Vapi category "${category}":`, err.message);
            continue;
        }

        for (const post of parseCategoryPage(html, category)) {
            if (post.date < cutoff) continue;

            const existing = bySlug.get(post.slug);
            if (existing) {
                existing.categories.push(category);
                continue;
            }

            bySlug.set(post.slug, {
                url: post.url,
                title: post.title,
                date: post.date.toISOString().slice(0, 10),
                categories: [category],
            });
        }
    }

    return [...bySlug.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Fetch Vapi changelog entries published within the last `numDaysAgo` days.
 *
 * The /whats-new index renders client side and is empty when fetched, but the
 * docs sitemap lists every entry at a dated URL, and appending .md to any docs
 * page returns clean Markdown.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, date, markdown }>>} newest first
 */
async function fetchVapiChangelog(numDaysAgo) {
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));
    const sitemap = await fetchText(`${VAPI_DOCS}/sitemap.xml`);

    const entries = [];
    const locPattern = /<loc>(https:\/\/docs\.vapi\.ai\/whats-new\/(\d{4})\/(\d{1,2})\/(\d{1,2}))<\/loc>/g;

    for (const [, url, year, month, day] of sitemap.matchAll(locPattern)) {
        const date = new Date(Number(year), Number(month) - 1, Number(day));
        if (date < cutoff) continue;

        entries.push({ url, date });
    }

    entries.sort((a, b) => b.date - a.date);

    const results = [];

    for (const entry of entries) {
        try {
            const raw = await fetchText(`${entry.url}.md`);

            // Drop the boilerplate ".md / llms.txt / MCP" preamble.
            const markdown = raw.replace(/^(>.*\n)+\s*/, "").trim();

            // docs.vapi.ai answers missing pages with HTTP 200 and a
            // "Page Not Found" body, so status alone can't be trusted.
            if (/^#\s*Page Not Found/i.test(markdown)) continue;

            results.push({
                url: entry.url,
                date: entry.date.toISOString().slice(0, 10),
                markdown,
            });
        } catch (err) {
            console.error(`Failed to fetch changelog ${entry.url}:`, err.message);
        }
    }

    return results;
}

/**
 * Fetch everything watched on Vapi in one call.
 *
 * @param {number} numDaysAgo — how many days back to look
 */
async function fetchAllVapiUpdates(numDaysAgo) {
    const [blogPosts, changelog] = await Promise.all([
        fetchVapiBlogPosts(numDaysAgo),
        fetchVapiChangelog(numDaysAgo),
    ]);

    return { blogPosts, changelog };
}

module.exports = { fetchVapiBlogPosts, fetchVapiChangelog, fetchAllVapiUpdates };
