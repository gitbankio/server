import crypto from "crypto";
import { logger } from "./logger";

const BASE_URL = "https://api.twitter.com/2";

export interface XMention {
  id: string;
  text: string;
  authorId: string;
  authorUsername: string;
  authorCreatedAt: string;
  conversationId: string;
  parentTweetId?: string;
  mediaUrl?: string;
  parentMediaUrl?: string;
  parentAuthorPfp?: string;
}

interface XUser {
  id: string;
  username: string;
  created_at: string;
  profile_image_url?: string;
}

interface XTweet {
  id: string;
  text: string;
  author_id: string;
  conversation_id: string;
  referenced_tweets?: { type: string; id: string }[];
  attachments?: { media_keys?: string[] };
}

interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
}

interface XMentionsResponse {
  data?: XTweet[];
  includes?: { users?: XUser[]; tweets?: XTweet[]; media?: XMedia[] };
  meta?: { newest_id?: string; result_count?: number };
}

// ── OAuth 1.0a signing ────────────────────────────────────────────────────────

function oauthHeader(
  method: string,
  url: string,
  extraParams: Record<string, string> = {},
): string {
  const consumerKey    = process.env["X_API_KEY"]            ?? "";
  const consumerSecret = process.env["X_API_SECRET"]         ?? "";
  const accessToken    = process.env["X_BOT_ACCESS_TOKEN"]   ?? "";
  const tokenSecret    = process.env["X_BOT_ACCESS_SECRET"]  ?? "";

  const oauthParams: Record<string, string> = {
    oauth_consumer_key:     consumerKey,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            accessToken,
    oauth_version:          "1.0",
  };

  const allParams = { ...extraParams, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramStr = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k]!)}`)
    .join("&");

  const sigBase = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramStr),
  ].join("&");

  const sigKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", sigKey).update(sigBase).digest("base64");
  oauthParams["oauth_signature"] = signature;

  return "OAuth " + Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k]!)}"`)
    .join(", ");
}

// ── Public API ────────────────────────────────────────────────────────────────

function mapTweetsResponse(body: XMentionsResponse): XMention[] {
  if (!body.data?.length) return [];
  const usersMap = new Map<string, XUser>(
    (body.includes?.users ?? []).map(u => [u.id, u]),
  );
  const mediaMap = new Map<string, XMedia>(
    (body.includes?.media ?? []).map(m => [m.media_key, m]),
  );
  const tweetsMap = new Map<string, XTweet>(
    (body.includes?.tweets ?? []).map(t => [t.id, t]),
  );
  return body.data.map(t => {
    const author    = usersMap.get(t.author_id);
    const parentRef = t.referenced_tweets?.find(r => r.type === "replied_to");

    // Own tweet media
    const mediaKey  = t.attachments?.media_keys?.[0];
    const media     = mediaKey ? mediaMap.get(mediaKey) : undefined;
    const mediaUrl  = media?.url ?? media?.preview_image_url;

    // Parent tweet media + parent author pfp
    let parentMediaUrl: string | undefined;
    let parentAuthorPfp: string | undefined;
    if (parentRef?.id) {
      const parentTweet = tweetsMap.get(parentRef.id);
      if (parentTweet) {
        const parentMediaKey = parentTweet.attachments?.media_keys?.[0];
        const parentMedia    = parentMediaKey ? mediaMap.get(parentMediaKey) : undefined;
        parentMediaUrl       = parentMedia?.url ?? parentMedia?.preview_image_url;
        const parentAuthor   = usersMap.get(parentTweet.author_id);
        parentAuthorPfp      = parentAuthor?.profile_image_url;
      }
    }

    return {
      id: t.id,
      text: t.text,
      authorId: t.author_id,
      authorUsername: author?.username ?? "",
      authorCreatedAt: author?.created_at ?? new Date().toISOString(),
      conversationId: t.conversation_id,
      parentTweetId: parentRef?.id,
      mediaUrl,
      parentMediaUrl,
      parentAuthorPfp,
    };
  });
}

const TWEET_FIELDS_PARAMS = {
  "tweet.fields": "author_id,text,created_at,conversation_id,referenced_tweets,attachments",
  expansions:     "author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys",
  "user.fields":  "username,created_at,profile_image_url",
  "media.fields": "url,preview_image_url,type",
};

/**
 * Fetch mentions of the bot account since a given tweet ID.
 * Returns newest first.
 */
export async function fetchMentions(botUserId: string, sinceId?: string): Promise<XMention[]> {
  const bearerToken = process.env["X_BEARER_TOKEN"];
  if (!bearerToken) {
    logger.warn("X_BEARER_TOKEN not set — skipping mention fetch");
    return [];
  }

  const params = new URLSearchParams({ max_results: "10", ...TWEET_FIELDS_PARAMS });
  if (sinceId) params.set("since_id", sinceId);

  try {
    const res = await fetch(`${BASE_URL}/users/${botUserId}/mentions?${params}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (res.status === 429) { logger.warn("X API rate limit hit on mentions"); return []; }
    if (!res.ok) { logger.warn({ status: res.status }, "X mentions fetch failed"); return []; }
    return mapTweetsResponse(await res.json() as XMentionsResponse);
  } catch (err) {
    logger.error({ err }, "fetchMentions error");
    return [];
  }
}

/**
 * Search recent tweets matching a query (e.g. "to:gitbankbot -is:retweet").
 * Used to pick up replies to bot tweets that don't explicitly @mention the bot.
 * Returns newest first.
 */
export async function fetchSearchRecent(query: string, sinceId?: string): Promise<XMention[]> {
  const bearerToken = process.env["X_BEARER_TOKEN"];
  if (!bearerToken) return [];

  const params = new URLSearchParams({ query, max_results: "10", ...TWEET_FIELDS_PARAMS });
  if (sinceId) params.set("since_id", sinceId);

  try {
    const res = await fetch(`${BASE_URL}/tweets/search/recent?${params}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (res.status === 429) { logger.warn("X search rate limit hit"); return []; }
    if (!res.ok) { logger.warn({ status: res.status }, "X search/recent failed"); return []; }
    return mapTweetsResponse(await res.json() as XMentionsResponse);
  } catch (err) {
    logger.error({ err }, "fetchSearchRecent error");
    return [];
  }
}

/**
 * Strip crypto addresses, tx hashes, and blockchain explorer URLs from text.
 * Used as a fallback when Twitter rejects posts containing crypto content.
 */
function stripCryptoContent(text: string): string {
  return text
    // Remove basescan / etherscan / blockchain explorer URLs
    .replace(/https?:\/\/[a-z.]*scan\.org\/tx\/0x[0-9a-fA-F]+/gi, "[tx]")
    .replace(/https?:\/\/[a-z.]*scan\.org\/[^\s]*/gi, "[explorer]")
    // Remove full tx hashes (64 hex chars after 0x)
    .replace(/0x[0-9a-fA-F]{60,}/gi, "[hash]")
    // Remove wallet/contract addresses (40 hex chars after 0x)
    .replace(/0x[0-9a-fA-F]{38,42}/gi, "[addr]")
    .trim();
}

/**
 * Post a tweet, optionally as a reply.
 * If Twitter rejects due to "Crypto addresses are prohibited" (new account restriction),
 * automatically retries with crypto content stripped.
 * Returns the new tweet ID or null on failure.
 */
export async function postTweet(text: string, replyToId?: string): Promise<string | null> {
  const url = `${BASE_URL}/tweets`;

  const attemptPost = async (tweetText: string): Promise<{ id: string | null; cryptoBlocked: boolean }> => {
    const body: Record<string, unknown> = { text: tweetText.replace(/\u2014/g, "-") };
    if (replyToId) body["reply"] = { in_reply_to_tweet_id: replyToId };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   oauthHeader("POST", url),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      const cryptoBlocked = res.status === 403 && errText.includes("Crypto addresses are prohibited");
      logger.warn({ status: res.status, err: errText, cryptoBlocked }, "postTweet failed");
      return { id: null, cryptoBlocked };
    }

    const data = await res.json() as { data?: { id?: string } };
    return { id: data.data?.id ?? null, cryptoBlocked: false };
  };

  try {
    const result = await attemptPost(text);
    if (result.id) return result.id;

    if (result.cryptoBlocked) {
      logger.warn("postTweet: crypto address restriction — retrying with stripped content");
      const stripped = stripCryptoContent(text);
      const retry = await attemptPost(stripped);
      return retry.id;
    }

    return null;
  } catch (err) {
    logger.error({ err }, "postTweet error");
    return null;
  }
}

/**
 * Post a long message as a thread (splits at 270 chars with numbering).
 */
export async function postThread(text: string, replyToId?: string): Promise<void> {
  const chunks = splitIntoTweets(text);
  let currentReplyTo = replyToId;
  for (const chunk of chunks) {
    const id = await postTweet(chunk, currentReplyTo);
    if (id) currentReplyTo = id;
  }
}

function splitIntoTweets(text: string): string[] {
  if (text.length <= 275) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= 275) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = line.length > 275 ? line.slice(0, 272) + "..." : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Fetch a single tweet by ID — returns { text, authorUsername } or null.
 * Used to resolve parent tweet context ("send to this guy").
 */
export async function fetchTweet(tweetId: string): Promise<{ text: string; authorUsername: string } | null> {
  const bearerToken = process.env["X_BEARER_TOKEN"];
  if (!bearerToken) return null;

  try {
    const params = new URLSearchParams({
      "tweet.fields": "author_id,text",
      expansions:     "author_id",
      "user.fields":  "username",
    });
    const res = await fetch(`${BASE_URL}/tweets/${tweetId}?${params}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      data?: { text: string; author_id: string };
      includes?: { users?: XUser[] };
    };
    if (!body.data) return null;
    const author = body.includes?.users?.find(u => u.id === body.data!.author_id);
    return { text: body.data.text, authorUsername: author?.username ?? "" };
  } catch {
    return null;
  }
}

/**
 * Test OAuth 1.0a write credentials by calling GET /2/users/me with user-context auth.
 * Returns { ok: true } if credentials are valid, { ok: false, reason } otherwise.
 * Does NOT post anything — safe to call on startup.
 */
export async function checkXOAuthCredentials(): Promise<{ ok: boolean; reason?: string }> {
  const key    = process.env["X_API_KEY"]           ?? "";
  const secret = process.env["X_API_SECRET"]        ?? "";
  const token  = process.env["X_BOT_ACCESS_TOKEN"]  ?? "";
  const tsecret = process.env["X_BOT_ACCESS_SECRET"] ?? "";

  const missing: string[] = [];
  if (!key)    missing.push("X_API_KEY");
  if (!secret) missing.push("X_API_SECRET");
  if (!token)  missing.push("X_BOT_ACCESS_TOKEN");
  if (!tsecret) missing.push("X_BOT_ACCESS_SECRET");
  if (missing.length) return { ok: false, reason: `missing env vars: ${missing.join(", ")}` };

  const url = "https://api.twitter.com/2/users/me";
  try {
    const res = await fetch(url, {
      headers: { Authorization: oauthHeader("GET", url) },
    });
    if (res.ok) return { ok: true };
    const body = await res.text();
    return { ok: false, reason: `HTTP ${res.status}: ${body.slice(0, 400)}` };
  } catch (err) {
    return { ok: false, reason: `network error: ${String(err)}` };
  }
}

/**
 * Lookup a user by @username — returns { id, username, created_at }.
 */
export async function lookupUser(username: string): Promise<{ id: string; username: string; created_at: string } | null> {
  const bearerToken = process.env["X_BEARER_TOKEN"];
  if (!bearerToken) return null;

  try {
    const res = await fetch(
      `${BASE_URL}/users/by/username/${encodeURIComponent(username)}?user.fields=created_at`,
      { headers: { Authorization: `Bearer ${bearerToken}` } },
    );
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string; username: string; created_at: string } };
    return data.data ?? null;
  } catch {
    return null;
  }
}
