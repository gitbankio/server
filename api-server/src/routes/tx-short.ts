import { Router } from "express";

const router = Router();

const EXPLORER_TX = process.env["BASE_NETWORK"] === "mainnet"
  ? "https://basescan.org/tx"
  : "https://sepolia.basescan.org/tx";

/**
 * GET /api/t/:encoded
 * Short tx URL for X bot replies — base64url-encoded tx hash, redirects to basescan.
 * Avoids embedding raw 0x tx hashes in tweets (Twitter new-account restriction).
 *
 * Encode: Buffer.from(txHash.slice(2), "hex").toString("base64url")
 * Decode: "0x" + Buffer.from(encoded, "base64url").toString("hex")
 */
router.get("/t/:encoded", (req, res) => {
  const { encoded } = req.params;
  try {
    const hex = Buffer.from(encoded!, "base64url").toString("hex");
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      res.status(400).send("Invalid tx reference.");
      return;
    }
    res.redirect(302, `${EXPLORER_TX}/0x${hex}`);
  } catch {
    res.status(400).send("Invalid tx reference.");
  }
});

export default router;
