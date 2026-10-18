const { subDays, startOfDay, format } = require("date-fns");

const XAI_SITE = "https://x.ai";
const XAI_NEWS = `${XAI_SITE}/news`;

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

module.exports = { fetchXaiNewsPosts };
