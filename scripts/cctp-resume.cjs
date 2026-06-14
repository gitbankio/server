/**
 * CCTP Bridge Recovery Script
 * Resumes a CCTP Base→Solana bridge that burned USDC but didn't finish receiveMessage on Solana.
 *
 * Usage:
 *   node scripts/cctp-resume.cjs [depositForBurnTxHash]
 *
 * Circle CCTP V1 API returns { attestation, status } — NO message field.
 * We decode the raw message bytes from the Base tx receipt ourselves.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

// ── Dynamic package resolution ─────────────────────────────────────────────────

const PNPM = "/home/runner/workspace/node_modules/.pnpm";

function findPkg(prefix) {
  const dir = fs.readdirSync(PNPM).find((d) => d.startsWith(prefix));
  if (!dir) throw new Error(`Package not found: ${prefix}`);
  return path.join(PNPM, dir, "node_modules");
}

const solanaDir = findPkg("@solana+web3.js@");
const bs58Dir   = findPkg("bs58@6");
const hashesDir = findPkg("@noble+hashes@");

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } =
  require(path.join(solanaDir, "@solana/web3.js/lib/index.cjs.js"));
const bs58 = require(path.join(bs58Dir, "bs58/src/cjs/index.cjs"));
const { keccak_256 } = require(path.join(hashesDir, "@noble/hashes/sha3.js"));

// ── Constants ──────────────────────────────────────────────────────────────────

const BASE_RPC       = process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
const SOLANA_RPC     = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const CIRCLE_API     = "https://iris-api.circle.com";
const MESSAGE_SENT_TOPIC = "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036";

const SOLANA_TOKEN_MESSENGER_PROGRAM    = "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3";
const SOLANA_MESSAGE_TRANSMITTER_PROGRAM = "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd";
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NONCES_PER_ACCOUNT = 6400n;

const SPL_TOKEN_PROGRAM   = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOC_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv4");
const SYSTEM_PROGRAM_ID   = SystemProgram.programId;

const DISC_RECEIVE_MESSAGE = Buffer.from([0x26, 0x90, 0x7f, 0xe1, 0x1f, 0xe1, 0xee, 0x19]);

// ── Helpers ────────────────────────────────────────────────────────────────────

function keccak256hex(buf) {
  return "0x" + Buffer.from(keccak_256(buf)).toString("hex");
}

/**
 * Decode ABI-encoded bytes: 32-byte offset + 32-byte length + data.
 * Returns the raw inner bytes (what CCTP actually emits as the message).
 */
function decodeAbiBytes(hexData) {
  const buf = Buffer.from(hexData.replace("0x", ""), "hex");
  const length = parseInt(buf.slice(32, 64).toString("hex"), 16);
  return buf.slice(64, 64 + length);
}

function getAssociatedTokenAddress(wallet, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOC_TOKEN_PROGRAM,
  );
  return ata;
}

function parseCctpMessage(msgBuf) {
  const sourceDomain  = msgBuf.readUInt32BE(4);
  const nonce         = msgBuf.readBigUInt64BE(12);
  const burnToken     = msgBuf.slice(116 + 4, 116 + 4 + 32);
  const mintRecipient = msgBuf.slice(116 + 4 + 32, 116 + 4 + 64);
  return { sourceDomain, nonce, burnToken, mintRecipient };
}

function messageTransmitterPdas(sourceDomain, nonce, tokenMessengerProgram, messageTransmitterProgram) {
  // Wormhole SDK: seeds are UTF-8 strings, NOT raw LE bytes.
  // calculateFirstNonce: (((nonce - 1) / 6400) * 6400) + 1
  const firstNonce = (((nonce - 1n) / NONCES_PER_ACCOUNT) * NONCES_PER_ACCOUNT + 1n);

  const [authorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter_authority"), tokenMessengerProgram.toBuffer()],
    messageTransmitterProgram,
  );
  const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")], messageTransmitterProgram,
  );
  const [usedNonces] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("used_nonces"),
      Buffer.from(sourceDomain.toString()),   // UTF-8 "6", not LE4 bytes
      Buffer.from(firstNonce.toString()),      // UTF-8 "793601", not LE8 bytes
    ],
    messageTransmitterProgram,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], messageTransmitterProgram,
  );
  return { authorityPda, messageTransmitterAccount, usedNonces, eventAuthority };
}

function tokenMessengerPdas(sourceDomain, burnTokenBytes32, usdcMint, tokenMessengerProgram) {
  // Wormhole SDK: domain seed is UTF-8 string, not LE4 bytes
  const srcDomainStr = Buffer.from(sourceDomain.toString());

  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")], tokenMessengerProgram,
  );
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), srcDomainStr], tokenMessengerProgram,
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_minter")], tokenMessengerProgram,
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), usdcMint.toBuffer()], tokenMessengerProgram,
  );
  const [tokenPair] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_pair"), srcDomainStr, burnTokenBytes32], tokenMessengerProgram,
  );
  const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("custody"), usdcMint.toBuffer()], tokenMessengerProgram,
  );
  const [tokenMessengerEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], tokenMessengerProgram,
  );
  return { tokenMessenger, remoteTokenMessenger, tokenMinter, localToken, tokenPair, custodyTokenAccount, tokenMessengerEventAuthority };
}

function jsonRpcPost(url, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = require("https").request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data).result); } catch (e) { reject(new Error(data.slice(0, 200))); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data.slice(0, 100))); } });
    }).on("error", reject);
  });
}

/**
 * Poll Circle Iris V1 attestation endpoint.
 * Circle CCTP V1 returns { attestation, status } — no message field.
 * The message bytes come from the Base tx receipt, not from Circle.
 */
async function pollAttestation(messageHash, maxMs = 900_000) {
  const start = Date.now();
  console.log(`  Polling Circle Iris API (up to ${maxMs / 60000} min)...`);
  let attempt = 0;
  while (Date.now() - start < maxMs) {
    attempt++;
    try {
      const data = await fetchJson(`${CIRCLE_API}/v1/attestations/${messageHash}`);
      if (data.status === "complete" && data.attestation) {
        console.log(`  Attestation complete! (attempt=${attempt}, elapsed=${Math.round((Date.now() - start) / 1000)}s)`);
        return data.attestation;
      }
      // status is pending_confirmations or pending
      if (attempt % 6 === 0) {
        console.log(`  status=${data.status} (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      }
    } catch {
      // transient — keep polling
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Attestation timeout after ${maxMs / 1000}s`);
}

async function receiveOnSolana(msgBuf, attestationHex) {
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const relayerKey = process.env.SOLANA_RELAYER_KEY;
  if (!relayerKey) throw new Error("SOLANA_RELAYER_KEY not set");
  const relayer = Keypair.fromSecretKey(bs58.default.decode(relayerKey));

  const attBuf = Buffer.from(attestationHex.replace("0x", ""), "hex");
  const fields  = parseCctpMessage(msgBuf);

  const usdcMint                  = new PublicKey(USDC_SOLANA);
  const tokenMessengerProgram     = new PublicKey(SOLANA_TOKEN_MESSENGER_PROGRAM);
  const messageTransmitterProgram = new PublicKey(SOLANA_MESSAGE_TRANSMITTER_PROGRAM);

  const { authorityPda, messageTransmitterAccount, usedNonces, eventAuthority } =
    messageTransmitterPdas(fields.sourceDomain, fields.nonce, tokenMessengerProgram, messageTransmitterProgram);
  const { tokenMessenger, remoteTokenMessenger, tokenMinter, localToken, tokenPair, custodyTokenAccount, tokenMessengerEventAuthority } =
    tokenMessengerPdas(fields.sourceDomain, fields.burnToken, usdcMint, tokenMessengerProgram);

  const mintRecipientPubkey   = new PublicKey(fields.mintRecipient);
  const recipientTokenAccount = getAssociatedTokenAddress(mintRecipientPubkey, usdcMint);

  console.log(`  sourceDomain: ${fields.sourceDomain}, nonce: ${fields.nonce}`);
  console.log(`  mintRecipient: ${mintRecipientPubkey.toBase58()}`);
  console.log(`  recipientATA:  ${recipientTokenAccount.toBase58()}`);
  console.log(`  feePayer (relayer): ${relayer.publicKey.toBase58()}`);

  const msgLen = Buffer.alloc(4); msgLen.writeUInt32LE(msgBuf.length);
  const attLen = Buffer.alloc(4); attLen.writeUInt32LE(attBuf.length);
  const data = Buffer.concat([DISC_RECEIVE_MESSAGE, msgLen, msgBuf, attLen, attBuf]);

  const ix = new TransactionInstruction({
    programId: messageTransmitterProgram,
    keys: [
      { pubkey: relayer.publicKey,              isSigner: true,  isWritable: true  },
      { pubkey: relayer.publicKey,              isSigner: true,  isWritable: false },
      { pubkey: authorityPda,                   isSigner: false, isWritable: false },
      { pubkey: messageTransmitterAccount,      isSigner: false, isWritable: true  },
      { pubkey: usedNonces,                     isSigner: false, isWritable: true  },
      { pubkey: tokenMessengerProgram,          isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID,              isSigner: false, isWritable: false },
      { pubkey: eventAuthority,                 isSigner: false, isWritable: false },
      { pubkey: messageTransmitterProgram,      isSigner: false, isWritable: false },
      { pubkey: tokenMessenger,                 isSigner: false, isWritable: false },
      { pubkey: remoteTokenMessenger,           isSigner: false, isWritable: false },
      { pubkey: tokenMinter,                    isSigner: false, isWritable: false },
      { pubkey: localToken,                     isSigner: false, isWritable: true  },
      { pubkey: tokenPair,                      isSigner: false, isWritable: false },
      { pubkey: recipientTokenAccount,          isSigner: false, isWritable: true  },
      { pubkey: custodyTokenAccount,            isSigner: false, isWritable: true  },
      { pubkey: SPL_TOKEN_PROGRAM,              isSigner: false, isWritable: false },
      { pubkey: tokenMessengerEventAuthority,   isSigner: false, isWritable: false },
      { pubkey: tokenMessengerProgram,          isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = relayer.publicKey;
  tx.add(ix);
  tx.sign(relayer);

  console.log("  Sending receiveMessage to Solana...");
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log(`  Confirming...`);
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const txHash = process.argv[2] ?? "0xc9ea0a3012aaa179c784c447544aa2a2a8fe4d9431090411fb2c0527ec413dde";
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  CCTP Bridge Recovery — receiveMessage on Solana`);
  console.log(`  depositForBurn tx: ${txHash}`);
  console.log(`${"═".repeat(70)}\n`);

  // 1. Get receipt + decode raw message from MessageSent event
  console.log("1. Fetching depositForBurn receipt from Base mainnet...");
  const receipt = await jsonRpcPost(BASE_RPC, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) throw new Error("Receipt not found — tx may not be confirmed yet");

  const log = receipt.logs.find((l) => l.topics[0] === MESSAGE_SENT_TOPIC);
  if (!log) throw new Error("MessageSent event not found in receipt — wrong tx?");

  // Decode ABI-encoded bytes: skip 32-byte offset + 32-byte length prefix
  const rawMessage = decodeAbiBytes(log.data);
  const messageHash = keccak256hex(rawMessage);
  console.log(`  rawMessage: ${rawMessage.length} bytes`);
  console.log(`  messageHash: ${messageHash}`);
  console.log(`  Basescan: https://basescan.org/tx/${txHash}\n`);

  // 2. Poll Circle for attestation (returns { attestation, status } — no message)
  console.log("2. Fetching Circle attestation...");
  const attestation = await pollAttestation(messageHash);
  console.log(`  attestation: ${attestation.slice(0, 42)}...\n`);

  // 3. receiveMessage on Solana (SOLANA_RELAYER_KEY pays fee)
  console.log("3. Calling receiveMessage on Solana CCTP program...");
  const solanaSig = await receiveOnSolana(rawMessage, attestation);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  CCTP BRIDGE COMPLETE`);
  console.log(`  Base depositForBurn: https://basescan.org/tx/${txHash}`);
  console.log(`  Solana receiveMsg:   https://solscan.io/tx/${solanaSig}`);
  console.log(`  5 USDC now in Solana custody wallet 4PFWSUkXH4FDC7bt4B64r1t93KKAe3wpKFeXg5v7CKfw`);
  console.log(`  (PK stored encrypted in solana_wallets DB table for GH ID 11111111)`);
  console.log(`${"═".repeat(70)}\n`);
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
