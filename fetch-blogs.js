const { subDays, startOfDay } = require("date-fns");
const { fetchAllVapiUpdates } = require("./fetch-vapi.js");

const CLAUDE_BLOG = "https://claude.com/blog";
const VERCEL_FEED = "https://vercel.com/atom";

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

function decodeEntities(text) {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/&#x27;/g, "'")
        .trim();
}

/**
 * Fetch Claude blog posts published within the last `numDaysAgo` days.
 *
 * claude.com has no RSS feed and its sitemap carries no dates, but the blog
 * index is server rendered: each card holds its title, date, and slug in
 * `fs-list-field` attributes.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, title, date }>>} newest first
 */
async function fetchClaudeBlogPosts(numDaysAgo) {
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));
    const html = await fetchText(CLAUDE_BLOG);

    const posts = [];
    const seen = new Set();

    // Each card starts with its heading field; everything up to the next
    // heading belongs to that post.
    const chunks = html.split(/fs-list-field="heading"/).slice(1);

    for (const chunk of chunks) {
        const title = chunk.match(/^[^>]*>([^<]+)</);
        const date = chunk.match(/fs-list-field="date"[^>]*>([^<]+)</);
        const slug = chunk.match(/href="\/blog\/([a-z0-9-]+)"/);

        if (!title || !date || !slug) continue;

        const published = new Date(decodeEntities(date[1]));
        if (isNaN(published) || published < cutoff) continue;

        if (seen.has(slug[1])) continue;
        seen.add(slug[1]);

        posts.push({
            url: `${CLAUDE_BLOG}/${slug[1]}`,
            title: decodeEntities(title[1]),
            date: published.toISOString().slice(0, 10),
        });
    }

    return posts.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Fetch Vercel blog posts published within the last `numDaysAgo` days.
 *
 * The Atom feed covers /blog and /changelog; only /blog is watched, matching
 * the existing watchlist.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, title, date }>>} newest first
 */
async function fetchVercelBlogPosts(numDaysAgo) {
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));
    const xml = await fetchText(VERCEL_FEED);

    const posts = [];

    for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const link = entry.match(/<link href="([^"]+)"/);
        const updated = entry.match(/<updated>([^<]+)<\/updated>/);
        const title = entry.match(/<title>([\s\S]*?)<\/title>/);

        if (!link || !updated) continue;
        if (!link[1].includes("/blog/")) continue; // skip /changelog

        const published = new Date(updated[1]);
        if (isNaN(published) || published < cutoff) continue;

        posts.push({
            url: link[1],
            title: title ? decodeEntities(title[1]) : link[1],
            date: published.toISOString().slice(0, 10),
        });
    }

    return posts.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Fetch every watched blog source in one call.
 *
 * Each source is independent: if one fails, the others still return.
 *
 * @param {number} numDaysAgo — how many days back to look
 */
async function fetchAllBlogUpdates(numDaysAgo) {
    const [claude, vercel, vapi] = await Promise.all([
        fetchClaudeBlogPosts(numDaysAgo).catch((err) => {
            console.error("Failed to fetch Claude blog:", err.message);
            return [];
        }),
        fetchVercelBlogPosts(numDaysAgo).catch((err) => {
            console.error("Failed to fetch Vercel blog:", err.message);
            return [];
        }),
        fetchAllVapiUpdates(numDaysAgo).catch((err) => {
            console.error("Failed to fetch Vapi updates:", err.message);
            return { blogPosts: [], changelog: [] };
        }),
    ]);

    return { claude, vercel, vapi };
}

module.exports = {
    fetchClaudeBlogPosts,
    fetchVercelBlogPosts,
    fetchAllBlogUpdates,
};
