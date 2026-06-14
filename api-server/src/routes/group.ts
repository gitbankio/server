import { Router, type Request, type Response } from "express";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import { groupMessages, groupAccounts } from "@workspace/db/schema";
import { eq, isNull, desc } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

// ── Moderation ────────────────────────────────────────────────────────────────

const BLOCKED_KEYWORDS: RegExp[] = [
  /\bscam\b/i,
  /\brug\b/i,
  /\brugpull\b/i,
  /\bhoneypot\b/i,
  /\bfarm\b/i,
  /\bdrain\b/i,
  /\bexploit\b/i,
  /\bairdrop\b/i,
  /\bgiveaway\b/i,
  /free\s+money/i,
  /\bpresale\b/i,
  /\b100x\b/i,
  /\bguaranteed\b/i,
  /\bdm\s+me\b/i,
  /\bdm\s+for\b/i,
  /\bcontact\s+me\b/i,
  /dead\s+project/i,
  /dev\s+ran/i,
  /\babandoned\b/i,
];

const LINK_WHITELIST_DOMAINS = [
  "x.com",
  "twitter.com",
  "gitbank.io",
  "github.com",
  "basescan.org",
];

const LINK_WHITELIST_PATHS: Record<string, string> = {
  "github.com": "/gitbankio",
};

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

function moderate(content: string): "ok" | "blocked" {
  for (const re of BLOCKED_KEYWORDS) {
    if (re.test(content)) return "blocked";
  }

  const urls = content.match(URL_PATTERN);
  if (urls) {
    for (const raw of urls) {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        return "blocked";
      }
      const host = parsed.hostname.replace(/^www\./, "");
      const allowed = LINK_WHITELIST_DOMAINS.includes(host);
      if (!allowed) return "blocked";
      const requiredPath = LINK_WHITELIST_PATHS[host];
      if (requiredPath && !parsed.pathname.startsWith(requiredPath)) {
        return "blocked";
      }
    }
  }

  return "ok";
}

// ── SSE client registry ───────────────────────────────────────────────────────

const sseClients = new Set<Response>();

function broadcast(data: unknown) {
  const str = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(str);
  }
}

// ── Admin auth ────────────────────────────────────────────────────────────────

function requireAdmin(req: Request, res: Response, next: () => void) {
  const secret = req.headers["x-admin-secret"];
  const adminSecret = process.env["GROUP_ADMIN_SECRET"];
  if (!adminSecret || secret !== adminSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// ── Admin verify ──────────────────────────────────────────────────────────────

router.post("/group/admin/verify", (req: Request, res: Response) => {
  const secret = req.headers["x-admin-secret"];
  const adminSecret = process.env["GROUP_ADMIN_SECRET"];
  if (!adminSecret || secret !== adminSecret) {
    res.status(401).json({ ok: false });
    return;
  }
  res.json({ ok: true });
});

// ── User token auth ───────────────────────────────────────────────────────────

async function validateUserToken(author: string, token: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(groupAccounts)
    .where(eq(groupAccounts.displayName, author))
    .limit(1);
  return rows.length > 0 && rows[0].token === token;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/group/accounts/join — register or verify account
router.post("/group/accounts/join", async (req: Request, res: Response) => {
  const body = z
    .object({
      displayName: z.string().min(1).max(40).trim(),
      token: z.string().length(64),
    })
    .parse(req.body);

  const existing = await db
    .select()
    .from(groupAccounts)
    .where(eq(groupAccounts.displayName, body.displayName))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(groupAccounts).values({
      displayName: body.displayName,
      token: body.token,
    });
    res.json({ ok: true, created: true });
    return;
  }

  if (existing[0].token !== body.token) {
    res.status(401).json({ ok: false, error: "Wrong password for this display name." });
    return;
  }

  res.json({ ok: true, created: false });
});

// GET /api/group/messages — list messages (no auth)
router.get("/group/messages", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(groupMessages)
    .where(isNull(groupMessages.deletedAt))
    .orderBy(desc(groupMessages.createdAt))
    .limit(200);

  res.json(rows.reverse());
});

// GET /api/group/stream — SSE real-time stream
router.get("/group/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  sseClients.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// POST /api/group/messages — send user message (token auth)
router.post("/group/messages", async (req: Request, res: Response) => {
  const body = z
    .object({
      author: z.string().min(1).max(40).trim(),
      content: z.string().min(1).max(2000).trim(),
      replyToId: z.string().uuid().optional(),
      token: z.string().length(64),
    })
    .parse(req.body);

  const valid = await validateUserToken(body.author, body.token);
  if (!valid) {
    res.status(401).json({ error: "Invalid credentials." });
    return;
  }

  if (moderate(body.content) === "blocked") {
    res.status(400).json({ error: "Message blocked." });
    return;
  }

  const [msg] = await db
    .insert(groupMessages)
    .values({
      author: body.author,
      content: body.content,
      replyToId: body.replyToId ?? null,
      isTeam: false,
    })
    .returning();

  broadcast({ type: "new_message", message: msg });
  res.json(msg);
});

// POST /api/group/messages/team — send team message (admin only)
router.post(
  "/group/messages/team",
  requireAdmin as any,
  async (req: Request, res: Response) => {
    const body = z
      .object({
        author: z.string().min(1).max(40).trim().default("Team"),
        content: z.string().min(1).max(2000).trim(),
        replyToId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const [msg] = await db
      .insert(groupMessages)
      .values({
        author: body.author,
        content: body.content,
        replyToId: body.replyToId ?? null,
        isTeam: true,
      })
      .returning();

    broadcast({ type: "new_message", message: msg });
    res.json(msg);
  },
);

// PATCH /api/group/messages/:id/pin — pin or unpin (admin only)
router.patch(
  "/group/messages/:id/pin",
  requireAdmin as any,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { pinned } = z.object({ pinned: z.boolean() }).parse(req.body);

    const [msg] = await db
      .update(groupMessages)
      .set({ pinned })
      .where(eq(groupMessages.id, id as string))
      .returning();

    broadcast({ type: "pin_update", message: msg });
    res.json(msg);
  },
);

// DELETE /api/group/messages/:id — soft delete (admin only)
router.delete(
  "/group/messages/:id",
  requireAdmin as any,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    await db
      .update(groupMessages)
      .set({ deletedAt: new Date() })
      .where(eq(groupMessages.id, id as string));

    broadcast({ type: "delete_message", id });
    res.json({ ok: true });
  },
);

export { sha256 };
export default router;
