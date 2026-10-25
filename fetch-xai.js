const { subDays, startOfDay, format } = require("date-fns");

const XAI_SITE = "https://x.ai";
const XAI_NEWS = `${XAI_SITE}/news`;
const GROK_BOT_CHANGELOG = `${XAI_SITE}/changelog/bot`;
const GROK_BOT_FEED = `${GROK_BOT_CHANGELOG}/rss.xml`;

// Chromium is pre-installed in the cloud environment; override for local runs.
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

const USER_AGENT =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/**
 * Fetch xAI news posts published within the last `numDaysAgo` days.
 *
 * x.ai sits behind a Cloudflare challenge that rejects plain HTTP requests
 * (HTTP 403), so the news index is loaded in headless Chromium instead. Each
 * post is an anchor to /news/{slug} holding its date and title: either in a
 * heading element, or as the line right after the date on the grid cards.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, title, date }>>} newest first
 */
async function fetchXaiNewsPosts(numDaysAgo) {
    const { chromium } = require("playwright-core");
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));

    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

    let cards;
    try {
        const page = await browser.newPage({ userAgent: USER_AGENT });
        await page.goto(XAI_NEWS, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForSelector('a[href^="/news/"]', { timeout: 30000 });

        cards = await page.$$eval('a[href^="/news/"]', (anchors) =>
            anchors.map((a) => ({
                href: a.getAttribute("href"),
                heading: a.querySelector("h1, h2, h3, h4")?.innerText.trim() ?? null,
                lines: a.innerText.split("\n").map((l) => l.trim()).filter(Boolean),
            }))
        );
    } finally {
        await browser.close();
    }

    const datePattern = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
    const posts = [];
    const seen = new Set();
    let dated = 0;

    for (const { href, heading, lines } of cards) {
        const slug = href.match(/^\/news\/([a-z0-9-]+)\/?$/);
        if (!slug || seen.has(slug[1])) continue;

        const dateIndex = lines.findIndex((l) => datePattern.test(l));
        if (dateIndex === -1) continue;
        dated++;

        const published = new Date(lines[dateIndex]);
        if (isNaN(published) || published < cutoff) continue;

        const title = heading || lines[dateIndex + 1];
        if (!title) continue;

        seen.add(slug[1]);
        posts.push({
            url: `${XAI_NEWS}/${slug[1]}`,
            title,
            date: format(published, "yyyy-MM-dd"),
        });
    }

    // An empty window is normal; finding no dated cards at all means the
    // layout changed, which should surface as a failure, not "nothing new".
    if (dated === 0) {
        throw new Error("Found no dated posts on x.ai/news; the page layout may have changed");
    }

    return posts.sort((a, b) => b.date.localeCompare(a.date));
}

function decodeEntities(text) {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Turn a changelog item's HTML (paragraphs, h3 sections, and bullet lists)
 * into Markdown.
 */
function htmlToMarkdown(html) {
    return decodeEntities(
        html
            .replace(/<h3>([\s\S]*?)<\/h3>/g, "\n\n### $1\n")
            .replace(/<li>([\s\S]*?)<\/li>/g, "- $1\n")
            .replace(/<\/p>/g, "\n")
            .replace(/<[^>]+>/g, "")
    )
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/**
 * Fetch Grok Bot changelog releases published within the last `numDaysAgo`
 * days.
 *
 * The changelog has an RSS feed whose items carry each release's full notes
 * as HTML. Cloudflare blocks the feed for plain HTTP requests and for
 * Playwright's request API alike, but serves it to a real page navigation,
 * so it is loaded in headless Chromium like the news page.
 *
 * @param {number} numDaysAgo — how many days back to look
 * @returns {Promise<Array<{ url, version, title, date, markdown }>>} newest first
 */
async function fetchGrokBotChangelog(numDaysAgo) {
    const { chromium } = require("playwright-core");
    const cutoff = startOfDay(subDays(new Date(), numDaysAgo));

    const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });

    let xml;
    try {
        const page = await browser.newPage({ userAgent: USER_AGENT });
        const res = await page.goto(GROK_BOT_FEED, { waitUntil: "domcontentloaded", timeout: 60000 });
        if (!res || !res.ok()) {
            throw new Error(`HTTP ${res ? res.status() : "no response"} from ${GROK_BOT_FEED}`);
        }
        xml = await res.text();
    } finally {
        await browser.close();
    }

    if (!xml.includes("<rss")) {
        throw new Error(`${GROK_BOT_FEED} did not return an RSS feed`);
    }

    const releases = [];

    for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const link = item.match(/<link>([^<]+)<\/link>/);
        const pubDate = item.match(/<pubDate>([^<]+)<\/pubDate>/);
        const title = item.match(/<title>([\s\S]*?)<\/title>/);
        const description = item.match(/<description>([\s\S]*?)<\/description>/);

        if (!link || !pubDate) continue;

        const published = new Date(pubDate[1]);
        if (isNaN(published) || published < cutoff) continue;

        const url = link[1].trim();
        const version = url.match(/#v(.+)$/);

        releases.push({
            url,
            version: version ? version[1] : null,
            // Titles end with the version, e.g. "Vault, email forwarding (0.75.5)"
            title: title ? decodeEntities(title[1]).replace(/\s*\([\d.]+\)$/, "").trim() : url,
            date: format(published, "yyyy-MM-dd"),
            markdown: description ? htmlToMarkdown(decodeEntities(description[1])) : "",
        });
    }

    return releases.sort((a, b) => b.date.localeCompare(a.date));
}

module.exports = { fetchXaiNewsPosts, fetchGrokBotChangelog };
