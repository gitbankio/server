/**
 * get-x-token.mjs
 * Run: node scripts/get-x-token.mjs
 *
 * This script does the OAuth 1.0a dance to get an Access Token + Secret
 * for whichever X account you authorize (log in as @gitbankbot when prompted).
 *
 * Requirements: X_API_KEY and X_API_SECRET must be set as env vars first.
 */

import crypto from "crypto";
import readline from "readline";

const API_KEY    = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;

if (!API_KEY || !API_SECRET) {
  console.error("\nERROR: Set X_API_KEY and X_API_SECRET env vars first.\n");
  console.error("Example:");
  console.error("  X_API_KEY=xxx X_API_SECRET=yyy node scripts/get-x-token.mjs\n");
  process.exit(1);
}

function oauthSign(method, url, params, tokenSecret = "") {
  const oauthParams = {
    oauth_consumer_key:     API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_version:          "1.0",
    ...params,
  };

  const allParams = { ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramStr = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join("&");

  const sigBase = [method, encodeURIComponent(url), encodeURIComponent(paramStr)].join("&");
  const sigKey  = `${encodeURIComponent(API_SECRET)}&${encodeURIComponent(tokenSecret)}`;
  const sig     = crypto.createHmac("sha1", sigKey).update(sigBase).digest("base64");
  oauthParams["oauth_signature"] = sig;

  return "OAuth " + Object.keys(oauthParams)
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(", ");
}

async function getRequestToken() {
  const url = "https://api.twitter.com/oauth/request_token";
  const res  = await fetch(url, {
    method:  "POST",
    headers: { Authorization: oauthSign("POST", url, { oauth_callback: "oob" }) },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`request_token failed: ${res.status} ${err}`);
  }
  const body   = await res.text();
  const params = Object.fromEntries(new URLSearchParams(body));
  return params.oauth_token;
}

async function getAccessToken(requestToken, verifier) {
  const url = "https://api.twitter.com/oauth/access_token";
  const res  = await fetch(url, {
    method:  "POST",
    headers: {
      Authorization: oauthSign("POST", url, {
        oauth_token:    requestToken,
        oauth_verifier: verifier,
      }),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`access_token failed: ${res.status} ${err}`);
  }
  const body   = await res.text();
  const params = Object.fromEntries(new URLSearchParams(body));
  return { token: params.oauth_token, secret: params.oauth_token_secret, userId: params.user_id, screenName: params.screen_name };
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function main() {
  console.log("\n=== Gitbank X Bot Token Generator ===\n");
  console.log("Step 1: Getting request token...");

  const requestToken = await getRequestToken();
  const authUrl      = `https://twitter.com/oauth/authorize?oauth_token=${requestToken}`;

  console.log("\nStep 2: Open this URL in your browser.");
  console.log("        Log in as @gitbankbot when prompted.\n");
  console.log("  " + authUrl + "\n");
  console.log("After authorizing, X will show you a 7-digit PIN code.\n");

  const verifier = await prompt("Step 3: Paste the PIN code here: ");
  if (!verifier) { console.error("No PIN entered. Aborting."); process.exit(1); }

  console.log("\nStep 4: Exchanging PIN for access token...");
  const result = await getAccessToken(requestToken, verifier);

  console.log("\n=== SUCCESS ===\n");
  console.log("Account:", result.screenName, "(ID:", result.userId + ")");
  console.log("\nSet these as Replit secrets:\n");
  console.log("  X_BOT_ACCESS_TOKEN  =", result.token);
  console.log("  X_BOT_ACCESS_SECRET =", result.secret);
  console.log("  X_BOT_USER_ID       =", result.userId);
  console.log("\nDone.\n");
}

main().catch(err => { console.error("\nERROR:", err.message, "\n"); process.exit(1); });
