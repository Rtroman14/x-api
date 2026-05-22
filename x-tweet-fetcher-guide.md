# Fetching Tweets with the Official X API (Node.js Guide)

A complete walkthrough for building a scheduled scraper that pulls recent tweets from ~10 accounts twice a week, feeds them to an LLM, and stays under $15/month.

**Stack**: Node.js 20+, native `fetch`, ES modules. Optional: Vercel AI SDK for the summarization step.

---

## What you're building

A script that:
1. Reads a list of X usernames from config
2. Resolves them to user IDs (one time)
3. Fetches tweets newer than the last seen tweet ID
4. Saves results to disk (or a database)
5. Optionally pipes them into an LLM for a digest
6. Runs on a schedule (cron, Cloud Scheduler, or GitHub Actions)

Estimated cost at twice-weekly polling of 10 accounts: **~$10/month** on PAYG.

---

## Step 1: Create an X Developer Account

1. Go to [developer.x.com](https://developer.x.com) and sign in with your X account
2. Click **Sign up** for a developer account
3. Fill out the use case form. For "describe your use case," something honest like:
   > Personal project. Polling a small list of public accounts twice a week and feeding tweets into an LLM to generate a personal AI news digest. Read-only, no posting, no redistribution.
4. Accept the developer agreement and verify your email

Approval is usually instant for read-only personal use.

---

## Step 2: Set up billing (PAYG)

As of February 2026, the free tier is gone for new signups. You'll need to add a payment method.

1. In the developer portal, go to **Products** then **Pay-As-You-Go**
2. Add a credit card
3. Purchase an initial credit pack (usually $10 minimum)
4. Set a monthly spend cap. **Do this**. Set it to $20 so a bug can't drain your account.

**Pricing reminder**:
- Read a tweet: $0.005
- Read a user profile: $0.010
- Capped at 2M reads/month before you need Enterprise

---

## Step 3: Create a Project and App, get your Bearer Token

1. In the portal, **Projects & Apps** then **+ Create Project**
2. Name it something like `ai-news-digest`. Use case: "Exploring the API"
3. Inside the project, create an App. Name it `ai-news-fetcher`
4. On the App's **Keys and Tokens** tab, generate a **Bearer Token**
5. Copy it immediately. You only see it once. Regenerate if you lose it.

You do not need API Key/Secret or OAuth 2.0 Client ID for this. Bearer Token is sufficient for reading public tweets (App-only auth).

---

## Step 4: Initialize the Node project

```bash
mkdir ai-news-digest && cd ai-news-digest
npm init -y
npm pkg set type=module
npm install dotenv
```

Create a `.env` file:

```bash
X_BEARER_TOKEN=AAAAAAAAAAAAAAAAAAAAAxxxxxxxxxxxxxxxxxxxx
```

Add `.env` to `.gitignore`:

```bash
echo ".env" >> .gitignore
echo "state.json" >> .gitignore
```

Create your account list at `accounts.json`:

```json
{
  "accounts": [
    "AnthropicAI",
    "OpenAI",
    "GoogleDeepMind",
    "karpathy",
    "sama",
    "ylecun",
    "miramurati",
    "DrJimFan",
    "AndrewYNg",
    "swyx"
  ]
}
```

---

## Step 5: Resolve usernames to user IDs (one-time)

X's API needs user IDs, not handles. Do this once and cache the result.

Create `resolve-ids.js`:

```javascript
import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';

const BEARER = process.env.X_BEARER_TOKEN;

async function resolveUsernames(usernames) {
  // Batch endpoint: up to 100 usernames per call
  const url = new URL('https://api.x.com/2/users/by');
  url.searchParams.set('usernames', usernames.join(','));
  url.searchParams.set('user.fields', 'id,name,username');

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BEARER}` }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const { data, errors } = await res.json();
  if (errors) console.warn('Resolution errors:', errors);
  return data;
}

const { accounts } = JSON.parse(await readFile('accounts.json', 'utf8'));
const users = await resolveUsernames(accounts);

const map = Object.fromEntries(
  users.map((u) => [u.username.toLowerCase(), { id: u.id, name: u.name }])
);

await writeFile('user-map.json', JSON.stringify(map, null, 2));
console.log(`Resolved ${users.length} users. Saved to user-map.json`);
```

Run it once:

```bash
node resolve-ids.js
```

Cost: 1 batch user lookup. Roughly $0.01 total.

---

## Step 6: Build the tweet fetcher

The key trick to keep costs low: use `since_id` so you only pull tweets newer than the last one you saw. State lives in `state.json`.

Create `fetch-tweets.js`:

```javascript
import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';

const BEARER = process.env.X_BEARER_TOKEN;
const MAX_RESULTS = 25; // per user per run; tweak based on posting frequency

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fetchUserTweets(userId, sinceId) {
  const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
  url.searchParams.set('max_results', String(MAX_RESULTS));
  url.searchParams.set(
    'tweet.fields',
    'created_at,public_metrics,entities,referenced_tweets'
  );
  url.searchParams.set('exclude', 'retweets,replies');
  if (sinceId) url.searchParams.set('since_id', sinceId);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BEARER}` }
  });

  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    throw new Error(`Rate limited. Resets at ${new Date(reset * 1000).toISOString()}`);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

async function main() {
  const userMap = await loadJson('user-map.json', {});
  const state = await loadJson('state.json', { lastSeen: {}, runs: [] });

  const results = [];

  for (const [username, { id, name }] of Object.entries(userMap)) {
    try {
      const since = state.lastSeen[id];
      const { data, meta } = await fetchUserTweets(id, since);

      if (data?.length) {
        console.log(`${username}: ${data.length} new tweets`);
        results.push({ username, name, tweets: data });
        // newest_id is the most recent tweet pulled; save for next run
        state.lastSeen[id] = meta.newest_id;
      } else {
        console.log(`${username}: no new tweets`);
      }
    } catch (err) {
      console.error(`${username} failed:`, err.message);
    }

    // Polite spacing to avoid burst rate limits
    await new Promise((r) => setTimeout(r, 250));
  }

  const runStamp = new Date().toISOString();
  state.runs.push({ at: runStamp, accounts: results.length });
  await writeFile('state.json', JSON.stringify(state, null, 2));

  // Save the digest payload for this run
  const outPath = `digest-${runStamp.slice(0, 10)}.json`;
  await writeFile(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

Run it:

```bash
node fetch-tweets.js
```

**First run** will pull up to 25 tweets per account because there's no `since_id` yet. That's a one-time cost of about ~250 reads = **$1.25**.

**Every subsequent run** only fetches what's new. For accounts that tweet 0 to 5 times between runs, you'll pay $0 to $0.25 per account per run.

---

## Step 7: Schedule it

### Option A: Local cron (simplest)

Add to your crontab (`crontab -e`):

```
# Twice a week: Monday and Thursday at 8 AM
0 8 * * 1,4 cd /path/to/ai-news-digest && /usr/local/bin/node fetch-tweets.js >> run.log 2>&1
```

### Option B: GitHub Actions (free, no server)

`.github/workflows/fetch.yml`:

```yaml
name: Fetch tweets
on:
  schedule:
    - cron: '0 13 * * 1,4'  # 8am ET, twice a week
  workflow_dispatch:

jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: node fetch-tweets.js
        env:
          X_BEARER_TOKEN: ${{ secrets.X_BEARER_TOKEN }}
      - name: Commit state
        run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add state.json digest-*.json
          git commit -m "Run $(date -u +%Y-%m-%d)" || true
          git push
```

State persists by committing it back to the repo. Crude but it works.

### Option C: Cloud Run + Cloud Scheduler

Since you already deploy to Cloud Run, this fits your existing pattern. Wrap the script in a tiny Express handler, deploy as a job, and trigger it via Cloud Scheduler. Store state in a Cloud Storage bucket or your Supabase instance instead of `state.json`.

---

## Step 8: Pipe into an LLM (optional)

Quick sketch using the Vercel AI SDK with Claude or GPT to generate a digest:

```bash
npm install ai @ai-sdk/anthropic zod
```

```javascript
// digest.js
import 'dotenv/config';
import { readFile } from 'fs/promises';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';

const today = new Date().toISOString().slice(0, 10);
const tweets = JSON.parse(await readFile(`digest-${today}.json`, 'utf8'));

const flat = tweets.flatMap(({ username, tweets }) =>
  tweets.map((t) => ({
    author: username,
    text: t.text,
    created_at: t.created_at,
    url: `https://x.com/${username}/status/${t.id}`
  }))
);

const { object } = await generateObject({
  model: anthropic('claude-sonnet-4-5'),
  schema: z.object({
    themes: z.array(
      z.object({
        title: z.string(),
        summary: z.string(),
        sources: z.array(z.string().url())
      })
    ),
    notableLaunches: z.array(z.string()),
    skipList: z.array(z.string()).describe('Tweets not worth surfacing')
  }),
  prompt: `You're an AI news editor. Group these tweets from the last few days into themes. Skip drama, hot takes, and engagement bait. Cite source URLs.\n\n${JSON.stringify(flat, null, 2)}`
});

console.log(JSON.stringify(object, null, 2));
```

Pipe the output into Slack, email, a Notion page, whatever. Postmark to your own inbox is probably the cleanest path given your existing setup.

---

## Cost breakdown for your use case

| Item | Cost |
|---|---|
| One-time username resolution | ~$0.01 |
| First run, 10 accounts × 25 tweets | ~$1.25 |
| Each ongoing run (avg ~10 new tweets across 10 accounts) | ~$0.05 |
| Twice a week × 4 weeks = 8 runs | ~$0.40 |
| **Total ongoing monthly** | **~$0.50 to $2** |

Set your spend cap at $20 and you have wide margin. The first month with the initial backfill will run higher; steady state is well under a dollar.

If you bump `MAX_RESULTS` to 100 or poll daily, you scale linearly. Even at daily polling of 10 accounts pulling 100 tweets each, you're at ~$15/month worst case.

---

## Gotchas to know about

1. **Tweet IDs are strings, not numbers**. They overflow JS `Number`. Always store as strings. The code above does this correctly.
2. **Rate limits still apply under PAYG**. The `users/:id/tweets` endpoint is limited to 900 requests per 15 minutes per app. You won't hit it.
3. **`exclude=retweets,replies`** keeps the digest focused on original content. Remove if you want everything.
4. **`since_id` is exclusive**. The tweet matching `since_id` is not returned, only newer ones. That's what you want.
5. **Deleted tweets stay in `state.json`**. If someone deletes the most recent tweet, your `since_id` still points to it. Tweet IDs are immutable, so the next fetch still works correctly.
6. **Protected/suspended accounts** return errors. Wrap each user's call in try/catch (the code does).
7. **The `x.com` vs `twitter.com` domain**: both work for the API. Use `api.x.com` in new code.

---

## Where to go from here

- Add a SQLite or Supabase table for tweet storage so you can query historically
- Build a small web UI (Next.js) to browse past digests
- Add sentiment/topic classification before the LLM summarization step to pre-filter noise
- Set up a "watchlist" of keywords that trigger immediate alerts via Postmark

Good luck with the build.
