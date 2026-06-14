import { logger } from "./logger";
import { checkXOAuthCredentials, fetchMentions, fetchSearchRecent, fetchTweet, postTweet } from "./x-client";
import { handleMention, generateShitpost } from "./x-bot";

const BOT_USER_ID  = process.env["X_BOT_USER_ID"] ?? "";
const POLL_INTERVAL = 30_000; // 30 seconds

// ── In-memory state ───────────────────────────────────────────────────────────

let lastMentionId:      string | undefined;
let lastReplyId:        string | undefined;
let initialized         = false;
let repliesInitialized  = false;
const processedIds = new Set<string>();

// ── Shared helpers ────────────────────────────────────────────────────────────

function trackId(id: string): boolean {
  if (processedIds.has(id)) return false;
  processedIds.add(id);
  // Keep set bounded to last 1000 IDs
  if (processedIds.size > 1000) {
    const first = processedIds.values().next().value;
    if (first) processedIds.delete(first);
  }
  return true;
}

function dispatch(mention: { id: string; text: string; authorId: string; authorUsername: string; authorCreatedAt: string; parentTweetId?: string; mediaUrl?: string; parentMediaUrl?: string; parentAuthorPfp?: string }): void {
  logger.info({ tweetId: mention.id, author: mention.authorUsername, parentTweetId: mention.parentTweetId }, "x-poller: processing tweet");

  // Fetch parent tweet context if this is a reply
  const parentTweetPromise = mention.parentTweetId
    ? fetchTweet(mention.parentTweetId)
    : Promise.resolve(null);

  void parentTweetPromise.then(parentTweet =>
    handleMention(
      mention.id,
      mention.text,
      mention.authorId,
      mention.authorUsername,
      mention.authorCreatedAt,
      parentTweet,
      mention.mediaUrl,
      mention.parentMediaUrl,
      mention.parentAuthorPfp,
    )
  ).catch(err => {
    logger.error({ err, tweetId: mention.id }, "x-poller: handleMention threw");
  });
}

// ── Mention poller (explicit @gitbankbot mentions) ────────────────────────────

async function pollMentions(): Promise<void> {
  if (!BOT_USER_ID) return;

  try {
    const mentions = await fetchMentions(BOT_USER_ID, lastMentionId);
    if (!mentions.length) return;

    const newestId = mentions[0]!.id;

    if (!initialized) {
      lastMentionId = newestId;
      initialized   = true;
      logger.info({ lastMentionId }, "x-poller initialized");
      return;
    }

    lastMentionId = newestId;

    for (const mention of mentions) {
      if (!trackId(mention.id)) continue;
      if (mention.authorId === BOT_USER_ID) continue;
      dispatch(mention);
    }
  } catch (err) {
    logger.error({ err }, "x-poller: pollMentions error");
  }
}

// ── Reply poller (replies to bot tweets without explicit @mention) ─────────────
// Uses search/recent with "to:gitbankbot" to catch tweets that are replies to the
// bot but don't include @gitbankbot in the text (e.g. user deleted the mention).

async function pollReplies(): Promise<void> {
  if (!BOT_USER_ID) return;

  try {
    const replies = await fetchSearchRecent("to:gitbankbot -is:retweet", lastReplyId);
    if (!replies.length) return;

    const newestId = replies[0]!.id;

    if (!repliesInitialized) {
      // First run: capture latest ID without processing to avoid replying to old tweets
      lastReplyId        = newestId;
      repliesInitialized = true;
      logger.info({ lastReplyId }, "x-poller replies initialized");
      return;
    }

    lastReplyId = newestId;

    for (const reply of replies) {
      if (!trackId(reply.id)) continue;           // already handled by pollMentions
      if (reply.authorId === BOT_USER_ID) continue;
      dispatch(reply);
    }
  } catch (err) {
    logger.error({ err }, "x-poller: pollReplies error");
  }
}

// ── Shitpost scheduler ────────────────────────────────────────────────────────
// Posts 3x per day at UTC 08:00, 14:00, 20:00

const SHITPOST_HOURS_UTC = [8, 14, 20];
const postedToday        = new Set<number>(); // tracks which hours already posted today
let lastShitpostDate     = "";

function currentDateUTC(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function checkShitpost(): Promise<void> {
  const now       = new Date();
  const hourUTC   = now.getUTCHours();
  const dateUTC   = currentDateUTC();

  // Reset daily tracker on new day
  if (dateUTC !== lastShitpostDate) {
    postedToday.clear();
    lastShitpostDate = dateUTC;
  }

  if (!SHITPOST_HOURS_UTC.includes(hourUTC)) return;
  if (postedToday.has(hourUTC)) return;

  postedToday.add(hourUTC);
  logger.info({ hourUTC, dateUTC }, "x-poller: shitpost time");

  const text = await generateShitpost();
  if (!text) return;

  const id = await postTweet(text);
  if (id) {
    logger.info({ id, hourUTC }, "x-poller: shitpost published");
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startXPoller(): void {
  if (!BOT_USER_ID) {
    logger.warn("X_BOT_USER_ID not set — X poller disabled");
    return;
  }
  if (!process.env["X_BEARER_TOKEN"]) {
    logger.warn("X_BEARER_TOKEN not set — X poller disabled");
    return;
  }

  logger.info({ botUserId: BOT_USER_ID }, "x-poller: starting");

  // Test OAuth write credentials on startup so misconfiguration is caught immediately
  void checkXOAuthCredentials().then(result => {
    if (result.ok) {
      logger.info("x-poller: OAuth credentials OK — posting enabled");
    } else {
      logger.error({ reason: result.reason }, "x-poller: OAuth credentials INVALID — postTweet will fail until fixed");
    }
  });

  // Run immediately on start
  void pollMentions();
  void pollReplies();
  void checkShitpost();

  setInterval(() => void pollMentions(),  POLL_INTERVAL);
  setInterval(() => void pollReplies(),   POLL_INTERVAL);
  setInterval(() => void checkShitpost(), 60_000); // check shitpost every minute
}
