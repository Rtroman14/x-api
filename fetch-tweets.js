const { subDays } = require("date-fns");
const { readFile } = require("fs/promises");
const path = require("path");

const X_API_BASE = "https://api.x.com/2";

/**
 * Resolve an X username to a user ID.
 */
async function resolveUserId(username, bearerToken) {
    const url = `${X_API_BASE}/users/by/username/${encodeURIComponent(username)}`;

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to resolve username "${username}": HTTP ${res.status} — ${body}`);
    }

    const { data } = await res.json();
    return data.id;
}

/**
 * Fetch a single page of tweets for a user ID.
 */
async function fetchTweetPage(userId, bearerToken, { startTime, paginationToken }) {
    const url = new URL(`${X_API_BASE}/users/${userId}/tweets`);

    url.searchParams.set("max_results", "100");
    url.searchParams.set("exclude", "retweets,replies");
    url.searchParams.set("tweet.fields", "created_at,public_metrics,entities,text,note_tweet");
    url.searchParams.set("start_time", startTime);

    if (paginationToken) {
        url.searchParams.set("pagination_token", paginationToken);
    }

    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${bearerToken}` },
    });

    if (res.status === 429) {
        const resetEpoch = res.headers.get("x-rate-limit-reset");
        const resetAt = new Date(resetEpoch * 1000).toISOString();
        throw new Error(`Rate limited. Resets at ${resetAt}`);
    }

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to fetch tweets: HTTP ${res.status} — ${body}`);
    }

    return res.json();
}

/**
 * Fetch all original tweets (no retweets/replies) from a user
 * posted between now and `numDaysAgo` days ago.
 *
 * @param {string} username  — X handle without the @
 * @param {number} numDaysAgo — how many days back to fetch
 * @returns {Promise<Array>} — array of tweet objects
 */
async function fetchUserTweets(username, numDaysAgo) {
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) {
        throw new Error("Missing X_BEARER_TOKEN environment variable");
    }

    const userId = await resolveUserId(username, bearerToken);
    const startTime = subDays(new Date(), numDaysAgo).toISOString();

    const allTweets = [];
    let paginationToken;

    do {
        const response = await fetchTweetPage(userId, bearerToken, {
            startTime,
            paginationToken,
        });

        if (response.data) {
            allTweets.push(...response.data);
        }

        paginationToken = response.meta?.next_token;
    } while (paginationToken);

    return allTweets.map((tweet) => ({
        ...tweet,
        fullText: tweet.note_tweet?.text ?? tweet.text,
    }));
}

/**
 * Fetch recent tweets from all accounts listed in accounts.json.
 *
 * @param {number} numDaysAgo — how many days back to fetch
 * @returns {Promise<Array<{ username: string, tweets: Array }>>}
 */
async function fetchAllAccountTweets(numDaysAgo) {
    const accountsPath = path.join(__dirname, "accounts.json");
    const { accounts } = JSON.parse(await readFile(accountsPath, "utf8"));

    const results = [];

    for (const username of accounts) {
        try {
            const tweets = await fetchUserTweets(username, numDaysAgo);
            results.push({ username, tweets });
        } catch (err) {
            console.error(`Failed to fetch @${username}:`, err.message);
            results.push({ username, tweets: [], error: err.message });
        }
    }

    return results;
}

module.exports = { fetchUserTweets, fetchAllAccountTweets };
