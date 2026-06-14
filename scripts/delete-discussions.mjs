#!/usr/bin/env node
/**
 * delete-discussions.mjs
 * Deletes all playground Discussions except the latest one.
 * Usage: node scripts/delete-discussions.mjs
 */

import { createSign } from "crypto";

function normalizePem(raw) {
  if (!raw) return "";
  let pem = raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  if (pem.includes("\n")) return pem;
  const match = pem.match(/-----BEGIN ([^-]+)-----\s*([\s\S]+?)\s*-----END \1-----/);
  if (!match) throw new Error("Invalid PEM");
  const type = match[1];
  const b64 = match[2].replace(/\s+/g, "");
  const body = (b64.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----\n`;
}

const APP_ID = process.env.GITHUB_APP_ID;
const PEM    = normalizePem(process.env.GITHUB_APP_PEM ?? "");
const ORG    = process.env.GITHUB_ORG ?? "gitbankio";
const REPO   = "playground";

if (!APP_ID || !PEM) { console.error("GITHUB_APP_ID and GITHUB_APP_PEM required"); process.exit(1); }

const now     = Math.floor(Date.now() / 1000);
const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: APP_ID })).toString("base64url");
const data    = `${header}.${payload}`;
const sign    = createSign("RSA-SHA256");
sign.update(data);
const jwt = `${data}.${sign.sign({ key: PEM, format: "pem", type: "pkcs1" }, "base64url")}`;

const listRes = await fetch("https://api.github.com/app/installations?per_page=100", {
  headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
});
const installations = await listRes.json();
const inst = installations.find((i) => i.account?.login?.toLowerCase() === ORG.toLowerCase());
if (!inst) throw new Error(`No installation found for ${ORG}`);

const tokRes = await fetch(`https://api.github.com/app/installations/${inst.id}/access_tokens`, {
  method: "POST",
  headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json" },
});
const { token } = await tokRes.json();

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const repoData = await gql(`
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      discussions(first: 20, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes { id number title }
      }
    }
  }
`, { owner: ORG, name: REPO });

const all = repoData.repository.discussions.nodes;
console.log(`Found ${all.length} discussion(s):`);
all.forEach((d) => console.log(`  #${d.number}: ${d.title}`));

if (all.length <= 1) {
  console.log("Nothing to delete.");
  process.exit(0);
}

// Keep only the latest (highest number), delete the rest
const latest = all.reduce((a, b) => (a.number > b.number ? a : b));
const toDelete = all.filter((d) => d.id !== latest.id);

console.log(`\nKeeping #${latest.number}. Deleting ${toDelete.length} old discussion(s)...`);
for (const d of toDelete) {
  await gql(`mutation($id: ID!) { deleteDiscussion(input: { id: $id }) { clientMutationId } }`, { id: d.id });
  console.log(`  Deleted #${d.number}: ${d.title}`);
}

console.log("\nDone. Only the latest discussion remains.");
