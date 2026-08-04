# AI News Digest

This project fetches tweets from a curated list of X accounts and checks AI-related blogs, then generates a briefing summary and posts it to Slack.

## About Ryan

Ryan is a technical founder and AI engineer. He builds AI agents with JavaScript/Node.js using Vercel's AI SDK and directly through LLM provider APIs. He uses LLMs across work and personal life to automate workflows, streamline processes/operations, and build agent-based systems.

He's interested in: prompt engineering, AI agent harnesses, agent tools/skills/workflows, new model releases and capabilities, AI coding tools, and LLM best practices. He wants to stay ahead of the curve on anything that affects how he builds with AI day-to-day.

He also runs a side business, Romey, an AI sales agent for contractors. Its core feature is an AI receptionist that handles inbound calls and books appointments, built on Vapi voice agents. So anything affecting how Vapi voice agents are built, priced, or operated is directly relevant: new models and voices available to assistants, latency and cost changes, call transfer and telephony behavior, tool/function calling, testing and evals, and monitoring. Treat Vapi platform changes as production concerns, not general industry news.

## Scheduled Task: AI Briefing

Runs every Monday, Wednesday, and Friday.

### Step 1: Determine the fetch window

Read `briefing-history.json` in this project directory. Calculate how many days have passed since `lastRunDate`. If `lastRunDate` is null (first run), default to 5 days.

### Step 2: Fetch tweets

Run the tweet fetcher to pull posts from all accounts listed in `accounts.json`:

```bash
node -e "
  const { fetchAllAccountTweets } = require('./fetch-tweets.js');
  fetchAllAccountTweets(DAYS_SINCE_LAST_RUN).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Replace `DAYS_SINCE_LAST_RUN` with the number calculated in Step 1. The X API key is available as an environment variable — no `.env` file is needed.

### Step 3: Check blog watchlist

Run the blog fetcher. Do not fetch these pages directly with WebFetch: blog index pages go stale and Vapi renders client side, so direct fetches silently miss posts.

```bash
node -e "
  const { fetchAllBlogUpdates } = require('./fetch-blogs.js');
  fetchAllBlogUpdates(DAYS_SINCE_LAST_RUN).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Replace `DAYS_SINCE_LAST_RUN` with the number calculated in Step 1. Each source is fetched independently, so one failing does not stop the others. Watch the output for `Failed to fetch` lines and mention any dead source in the briefing rather than reporting it as "nothing new."

The watchlist:

| Source | Covers | Returned as |
| --- | --- | --- |
| https://claude.com/blog | Anthropic product updates, model releases, feature announcements | `claude` |
| https://vercel.com/blog | AI SDK updates, AI-related platform features | `vercel` |
| https://vapi.ai/blog/category/agent_building | voice agent building techniques | `vapi.blogPosts` |
| https://vapi.ai/blog/category/features | new Vapi product features | `vapi.blogPosts` |
| https://docs.vapi.ai/whats-new | the weekly Vapi changelog | `vapi.changelog` |

`claude`, `vercel`, and `vapi.blogPosts` each return the title, URL, and date of every post in the window. Only include posts genuinely relevant to Ryan's interests.

`vapi.changelog` returns the full Markdown of each weekly entry, which is usually a batch of many small items (new models, new voices, bug fixes, API changes). Do not summarize a whole week as one story. Pull out only the individual items that matter for Romey and write each as its own story, or group closely related items into one. Cite the weekly entry URL as the source. Ignore items that don't touch how Romey's receptionist runs, such as changes to unrelated providers or SDKs Ryan doesn't use.

Vercel's feed also carries their `/changelog`, which is deliberately excluded from the watchlist.

### Step 4: Filter the results

Include tweets and blog posts that:
- Announce something new (product launch, model release, feature, tool)
- Teach a technique or share a practical workflow
- Share a tool, repo, or resource worth knowing about
- Contain meaningful AI engineering insights
- Change how Vapi voice agents get built, priced, or operated (relevant to Romey)

Skip anything that is:
- Hot takes, engagement bait, or personal drama
- AI chip/hardware news (Nvidia earnings, GPU specs)
- AI policy, regulation, or government news
- Academic papers without clear practical application
- Funding rounds or VC news unless the product itself is notable
- Already covered in a previous briefing (check `coveredStoryIds` in `briefing-history.json`)

No story count limit — include everything that passes the filter. If nothing noteworthy happened, send a short briefing saying so.

### Step 5: Write the briefing

Format each story like this:

```
**{Headline}**
> {Concise summary with key takeaways. Not a wall of text, but enough to understand what's new and why it matters.}
Source: [Display Name](url)
```

For tweet sources, link directly to the tweet and use the person's name as the display text:
```
Source: [Matt Pocock](https://x.com/mattpocockuk/status/123456)
```

For blog sources, link to the specific post and use the blog name:
```
Source: [Claude Blog](https://claude.com/blog/post-slug)
```

For Vapi sources, use the blog or the dated changelog entry:
```
Source: [Vapi Blog](https://vapi.ai/blog/post-slug)
Source: [Vapi Changelog](https://docs.vapi.ai/whats-new/2026/7/27)
```

Formatting rules:
- Opening line: **AI Briefing — [Day, Month Date]**
- Use double asterisks for bold (Slack rendering)
- Summaries inside blockquotes using > at the start of each line
- Source links use standard markdown: `[text](url)`
- Leave a blank line between each story
- No emojis, no dividers, no em dashes
- Closing line (italicized): _Next briefing: [next scheduled day]._

### Step 6: Send to Slack

Search for the #ai-news channel using slack_search_channels with query "ai-news". Post the full formatted briefing to that channel using slack_send_message.

### Step 7: Update briefing history

After sending, update `briefing-history.json`:
- Set `lastRunDate` to today's date (YYYY-MM-DD format)
- Append all tweet IDs, blog URLs, and Vapi changelog entry URLs from this briefing to `coveredStoryIds`

When several stories come from one weekly Vapi changelog entry, record that entry's URL once.

Commit and push the updated `briefing-history.json` directly to the `main` branch. Do not create a separate branch or pull request — push straight to main. This file is the deduplication record. Stories listed here must not be re-covered in future briefings.
