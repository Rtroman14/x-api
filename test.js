require("dotenv/config");
const { fetchAllAccountTweets } = require("./fetch-tweets.js");

(async () => {
    try {
        const results = await fetchAllAccountTweets(3);
        for (const { username, tweets } of results) {
            console.log(`\n@${username}: ${tweets.length} tweets`);
            for (const tweet of tweets) {
                console.log(`  - [${tweet.created_at}] ${tweet.fullText.slice(0, 120)}`);
            }
        }
    } catch (err) {
        console.error("Error:", err.message);
        process.exit(1);
    }
})();
