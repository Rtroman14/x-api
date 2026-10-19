const { subDays, startOfDay } = require("date-fns");

const SHADCN_FEED = "https://ui.shadcn.com/rss.xml";

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

function unwrapCdata(text) {
    return text.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim();
}

/**
 * Drop fenced code blocks from changelog Markdown. Entries embed full
 * component demos that run to tens of kilobytes; the prose around them is
 * what says what shipped.
 */
function stripCodeBlocks(markdown) {
    return markdown
        .replace(/^```[\s\S]*?^```\s*$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Fetch shadcn/ui changelog entries published within the last `numDaysAgo`
 * days.
 *
 * The RSS feed lists every changelog entry with its date, and each entry is
 * also served as raw Markdown at its URL plus `.md`, so the body comes back
 * without scraping the 1MB rendered page.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, title, date, description, markdown }>>} newest first
 */
async function fetchShadcnChangelog(numDaysAgo) {
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));
    const xml = await fetchText(SHADCN_FEED);

    const entries = [];

    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const link = item.match(/<link>([^<]+)<\/link>/);
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/);
        const title = item.match(/<title>([\s\S]*?)<\/title>/);
        const description = item.match(/<description>([\s\S]*?)<\/description>/);

        if (!link || !pubDate) continue;

        const published = new Date(pubDate[1]);
        if (isNaN(published) || published < cutoff) continue;

        entries.push({
            url: link[1].trim(),
            title: title ? unwrapCdata(title[1]) : link[1].trim(),
            date: published.toISOString().slice(0, 10),
            description: description ? unwrapCdata(description[1]) : "",
        });
    }

    for (const entry of entries) {
        try {
            entry.markdown = stripCodeBlocks(await fetchText(`${entry.url}.md`));
        } catch (err) {
            // The feed's description still says what shipped.
            console.error(`Failed to fetch shadcn entry ${entry.url}:`, err.message);
            entry.markdown = null;
        }
    }

    return entries.sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { fetchShadcnChangelog };
