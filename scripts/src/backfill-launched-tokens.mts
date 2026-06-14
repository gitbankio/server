/**
 * Backfill launched tokens from Discussion #4 receipts (hardcoded from attached file).
 * Fetches img_url from Clanker API for each token before inserting.
 *
 * Run: pnpm --filter @workspace/scripts exec tsx ./src/backfill-launched-tokens.mts
 */

import pg from "pg";

const { Client } = pg;

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";

// All receipts extracted from Discussion #4 reply threads.
// launched_at timestamps approximated from "X minutes ago" relative to capture time 2026-05-22T00:09Z.
const RECEIPTS = [
  {
    tokenName: "Test Token",
    tokenSymbol: "TEST",
    contractAddress: "0x53e203D60F8F39790C184fC5812b1c5741BB6C71",
    deployerLogin: "imrenone",
    txHash: "0x518396c8e98dd0afac93a8f399b58ef78d5a62b2f14be729ac21a1a27308c33a",
    websiteUrl: "https://gitbank.io",
    twitterUrl: "https://x.com/gitbank",
    launchedAt: new Date("2026-05-21T23:00:00Z"),
  },
  {
    tokenName: "gitbank x clanker",
    tokenSymbol: "GITBANKR",
    contractAddress: "0xAbDEc029105e145C613AB2aAB49D8a74ce1d9AB7",
    deployerLogin: "fcfsprojects",
    txHash: "0x07f8e8745cb12ac560eb2b001287b5eeae14bf1adf8974c6ba8b03d448f7c01d",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:09:00Z"),
  },
  {
    tokenName: "gitbank x clanker",
    tokenSymbol: "GITBANKR",
    contractAddress: "0x8d9306DD625C7462b140E07310b793C21C90dc55",
    deployerLogin: "Dexxcuyy",
    txHash: "0xf8cf9b7a7696e2d53b9f0a19da186c20009f2731e182632e86e62ccab970e91a",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:09:30Z"),
  },
  {
    tokenName: "gitbank",
    tokenSymbol: "GITBANK",
    contractAddress: "0x300e8f33FDDA7E7AbbB04EED3D46c642346e23F4",
    deployerLogin: "Dexxcuyy",
    txHash: "0xc210c75a3e8dbe5351046238130206368b8f3f0f4dfcfa987068570fbe3b5a5f",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:10:00Z"),
  },
  {
    tokenName: "gitbank",
    tokenSymbol: "GITBANK",
    contractAddress: "0x014fbE31A110414e25e5474d1c74601a23153682",
    deployerLogin: "Dexxcuyy",
    txHash: "0xb16dccf64dd4d2968b35ecbea3bd5c228637b2d2612641a28de29b8f1ed057e1",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:10:30Z"),
  },
  {
    tokenName: "gitbankbot",
    tokenSymbol: "GITBANKBOT",
    contractAddress: "0xA56C870285f49175e3e49B613Df6b05d38d0Bc1D",
    deployerLogin: "Dexxcuyy",
    txHash: "0x08d78e775fca475cdc3f3d5f76b904a8da61e17038d0cbded6ee6f4e577b2f74",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:11:00Z"),
  },
  {
    tokenName: "gitbankbot",
    tokenSymbol: "GITBANKBOT",
    contractAddress: "0xCE9334c26b642Cf30a54610Ef29ecFF3b2DD4Ea8",
    deployerLogin: "Dexxcuyy",
    txHash: "0x477e22628e72dc662e5c8b9380f012c5ff6ff521c8c185e0b05be53a4ce4a101",
    websiteUrl: "https://github.com/apps/gitbankbot",
    twitterUrl: null,
    launchedAt: new Date("2026-05-21T23:11:30Z"),
  },
  {
    tokenName: "Gitbank x Clanker",
    tokenSymbol: "GXC",
    contractAddress: "0x6B615DBdbdb00E7B8B11d875D5e1102ac575b370",
    deployerLogin: "clawthedoor",
    txHash: "0xf78e86dac17c54c5000cab5bb416ed83e278ce912d45e1f133158e2f934cdda1",
    websiteUrl: null,
    twitterUrl: null,
    launchedAt: new Date("2026-05-21T23:15:00Z"),
  },
  {
    tokenName: "gitbank",
    tokenSymbol: "GITCLANK",
    contractAddress: "0xeC69f1Cb95791E5648430FAeED9964be9623ed8C",
    deployerLogin: "Dexxcuyy",
    txHash: "0xafb6a6159cef6f9115f6359eed9d54a5737991d76560d83e952b2d96e995c3d5",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:15:30Z"),
  },
  {
    tokenName: "gitbank edu",
    tokenSymbol: "GITBANKDU",
    contractAddress: "0x59509f4051Dac414343b6Fd153911cafe1ab7069",
    deployerLogin: "fcfsprojects",
    txHash: "0xeef974eb10f3037b00d4f9b40b49fca942345c7191d89a1d85e0c0481e80cfb1",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057442529574879540",
    launchedAt: new Date("2026-05-21T23:17:00Z"),
  },
  {
    tokenName: "gitbank",
    tokenSymbol: "GITBANK",
    contractAddress: "0x52A53217F09e4EFA67BDD1ec77589ed176Bf915B",
    deployerLogin: "Dexxcuyy",
    txHash: "0x52c08120d49b26c121fe2eef40fc4038026e398eb05b5447690525165e1f071d",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:21:00Z"),
  },
  {
    tokenName: "gitbank x clanker",
    tokenSymbol: "GITBANKR",
    contractAddress: "0xBc0F5F5021c616381E0847c0B9Bddc37dfFB9209",
    deployerLogin: "Dexxcuyy",
    txHash: "0xc6132a3fc7b82c80058ab035624fbfa8b4cd358f3eb9bb396be8b9571630a486",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:22:00Z"),
  },
  {
    tokenName: "Test Token",
    tokenSymbol: "TEST",
    contractAddress: "0xa78a7C94a25Bb9a364EA6D0fB9e2fabf90aCe2Ed",
    deployerLogin: "Dexxcuyy",
    txHash: "0xc42995f3f425328a325cdfce5cc1de000cb9ec464c000b0d4b2d33e9b2b39762",
    websiteUrl: "https://gitbank.io/",
    twitterUrl: "https://x.com/gitbank",
    launchedAt: new Date("2026-05-21T23:29:00Z"),
  },
  {
    tokenName: "autogit",
    tokenSymbol: "AUTOGIT",
    contractAddress: "0xC9AF202CeAB77080E953f289e6c7CBff9569B344",
    deployerLogin: "fcfsprojects",
    txHash: "0x254879770cd7ee8e2076a55ac1bd36b6c3ef7d8aa7906a0fc4f1e776205607f9",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057370816640069963",
    launchedAt: new Date("2026-05-21T23:34:00Z"),
  },
  {
    tokenName: "gitbankbot",
    tokenSymbol: "BOT",
    contractAddress: "0x4ffd0E30Fec879A405A1043e55652B433b3A7920",
    deployerLogin: "Dexxcuyy",
    txHash: "0xa7962f932f8a8fc75da48eada570830da40f1203471192a0cd9cfd40c31ac489",
    websiteUrl: "https://github.com/apps/gitbankbot",
    twitterUrl: "https://x.com/Gitbank_io/status/2057529327802318979",
    launchedAt: new Date("2026-05-21T23:37:00Z"),
  },
  {
    tokenName: "gitcat",
    tokenSymbol: "GITCAT",
    contractAddress: "0x4159d4F88A6076d3079BC93A6C3befFB0495AD3F",
    deployerLogin: "lupitmoxie",
    txHash: "0x6dd1a8c753026151b93ea4b483d1f0e84eabbd5ac14b7a15503c085bad0d0a30",
    websiteUrl: null,
    twitterUrl: null,
    launchedAt: new Date("2026-05-21T23:49:00Z"),
  },
  {
    tokenName: "gitswap",
    tokenSymbol: "GITSWAP",
    contractAddress: "0x842C75ef06c2906B8f2c51072a1B65FA68d30974",
    deployerLogin: "lupitmoxie",
    txHash: "0x58c41ef96d32ae9c32ab2d378538daf06fb79ad780bb734a541d81da8d2e4364",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057295314264973517",
    launchedAt: new Date("2026-05-21T23:58:00Z"),
  },
  {
    tokenName: "gitbank playground",
    tokenSymbol: "PLAYGROUND",
    contractAddress: "0x18b52E03B2942b0E55611a756174Cf1cba92aC29",
    deployerLogin: "fcfsprojects",
    txHash: "0x1fcaba19d22807a3600d010b442daf747806b6f2aa84277f953c233674515883",
    websiteUrl: "https://github.com/gitbankio/playground/discussions/4",
    twitterUrl: "https://x.com/Gitbank_io/status/2057183177526186461",
    launchedAt: new Date("2026-05-22T00:04:00Z"),
  },
  {
    tokenName: "Test Token",
    tokenSymbol: "TEST",
    contractAddress: "0xEe9865b347C23c0538749cE989D805439ff0AF9C",
    deployerLogin: "Dexxcuyy",
    txHash: "0x8b2a0e817fbca1fb2659339f9f796f3b305c4e6ee646b11430a263aebeca9332",
    websiteUrl: "https://gitbank.io",
    twitterUrl: "https://x.com/gitbank",
    launchedAt: new Date("2026-05-22T00:09:00Z"),
  },
  {
    tokenName: "gitbank vault",
    tokenSymbol: "GITVAULT",
    contractAddress: "0x4dF935963B768aa71B1bC999a48097625611061a",
    deployerLogin: "fcfsprojects",
    txHash: "0xa7122373ff23e79403034dd1f5bc283e60d5a70ad2ea4bc6aa852f0d8d8567de",
    websiteUrl: null,
    twitterUrl: "https://x.com/Gitbank_io/status/2057500946481975400",
    launchedAt: new Date("2026-05-22T00:09:14Z"),
  },
  {
    tokenName: "Zen Browser",
    tokenSymbol: "ZB",
    contractAddress: "0xcA2CA415cFd240Be1688f30A6225e4ACa8Ad79F8",
    deployerLogin: "Dexxcuyy",
    txHash: "0x9983c038fe3aa6d260608600c09718ca4afaa6e7e2ba117d61b80d1764dc2887",
    websiteUrl: "https://zen-browser.app",
    twitterUrl: "https://x.com/zen_browser",
    launchedAt: new Date("2026-05-22T00:10:00Z"),
  },
] as const;

async function fetchClankerImageUrl(contractAddress: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.clanker.world/api/tokens?contractAddress=${contractAddress}`,
      { headers: { "User-Agent": "Gitbank/1.0" } }
    );
    if (!res.ok) return null;
    const data = await res.json() as { data?: { img_url?: string }[] };
    return data?.data?.[0]?.img_url ?? null;
  } catch {
    return null;
  }
}

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  console.log(`Processing ${RECEIPTS.length} receipts...`);

  for (const r of RECEIPTS) {
    process.stdout.write(`  ${r.tokenSymbol} (${r.contractAddress.slice(0, 10)}...)  fetching logo... `);
    const imageUrl = await fetchClankerImageUrl(r.contractAddress);
    console.log(imageUrl ? `got logo` : `no logo`);

    await client.query(
      `INSERT INTO launched_tokens
         (token_name, token_symbol, contract_address, deployer_github_login, deployer_github_id,
          tx_hash, chain_id, website_url, twitter_url, image_url, launched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (contract_address) DO UPDATE
         SET image_url = EXCLUDED.image_url
         WHERE launched_tokens.image_url IS NULL`,
      [
        r.tokenName,
        r.tokenSymbol,
        r.contractAddress,
        r.deployerLogin,
        0,
        r.txHash,
        8453,
        r.websiteUrl,
        r.twitterUrl,
        imageUrl,
        r.launchedAt,
      ]
    );
  }

  await client.end();

  const count = RECEIPTS.length;
  console.log(`\nDone. Inserted/updated ${count} tokens.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
