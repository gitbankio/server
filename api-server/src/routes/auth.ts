import { Router } from "express";
import { db, usersTable, installationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { generateAppJWT } from "../lib/github-app";

const router = Router();

const GITHUB_CLIENT_ID = process.env["GITHUB_CLIENT_ID"] ?? "";
const GITHUB_CLIENT_SECRET = process.env["GITHUB_CLIENT_SECRET"] ?? "";
const APP_BASE_URL = (() => {
  const domains = process.env["ALLOWED_DOMAINS"] ?? process.env["ALLOWED_DOMAINS"] ?? "";
  const first = domains.split(",")[0]?.trim();
  return first ? `https://${first}` : "http://localhost:3000";
})();

// GitHub OAuth redirect
router.get("/auth/github", (_req, res) => {
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${APP_BASE_URL}/api/auth/callback`,
    scope: "read:user,public_repo",
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

// GitHub OAuth callback
router.get("/auth/callback", async (req, res) => {
  const code = req.query["code"] as string | undefined;

  if (!code) {
    res.status(400).json({ error: "Missing code" });
    return;
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${APP_BASE_URL}/api/auth/callback`,
      }),
    });

    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenData.access_token) {
      req.log.error({ tokenData }, "OAuth token exchange failed");
      res.status(400).json({ error: "OAuth failed" });
      return;
    }

    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "Gitbank" },
    });
    const ghUser = (await userRes.json()) as { id: number; login: string };

    const existing = await db.select().from(usersTable).where(eq(usersTable.githubId, ghUser.id)).limit(1);
    if (existing.length === 0) {
      await db.insert(usersTable).values({
        githubId: ghUser.id,
        githubLogin: ghUser.login,
        role: "member",
      });
    } else {
      await db.update(usersTable)
        .set({ githubLogin: ghUser.login })
        .where(eq(usersTable.githubId, ghUser.id));
    }

    req.session.githubId = ghUser.id;
    req.session.githubLogin = ghUser.login;
    req.session.accessToken = tokenData.access_token;

    const existing2 = await db.select().from(usersTable).where(eq(usersTable.githubId, ghUser.id)).limit(1);
    const user = existing2[0];
    const target = user?.vaultAddress ? "/app/dashboard" : "/app/onboarding";

    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.redirect(target);
  } catch (err) {
    req.log.error({ err }, "OAuth callback error");
    res.status(500).json({ error: "Internal error" });
  }
});

// GitHub App installation callback
// GitHub redirects here after user installs the app on a repo
router.get("/auth/github/installed", async (req, res) => {
  const installationId = parseInt(req.query["installation_id"] as string ?? "", 10);
  const setupAction = req.query["setup_action"] as string | undefined;

  if (!installationId || isNaN(installationId)) {
    res.redirect("/app/dashboard");
    return;
  }

  try {
    // Fetch installation details from GitHub App API
    const jwt = generateAppJWT();
    const installRes = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Gitbank",
      },
    });
    const installData = (await installRes.json()) as {
      account?: { login: string; type: string };
      suspended_at?: string | null;
    };

    const accountLogin = installData.account?.login ?? "unknown";
    const accountType = installData.account?.type ?? "User";
    const suspendedAt = installData.suspended_at ? new Date(installData.suspended_at) : null;

    // Save or update installation in DB
    await db
      .insert(installationsTable)
      .values({
        installationId,
        accountLogin,
        accountType,
        githubId: req.session.githubId ?? null,
        suspendedAt,
      })
      .onConflictDoUpdate({
        target: installationsTable.installationId,
        set: {
          accountLogin,
          accountType,
          githubId: req.session.githubId ?? null,
          suspendedAt,
        },
      });

    req.log.info({ installationId, accountLogin, setupAction }, "GitHub App installed");
  } catch (err) {
    req.log.error({ err, installationId }, "Failed to save installation");
  }

  res.redirect("/app/dashboard?installed=1");
});

// Get current user
router.get("/auth/me", requireAuth, async (req, res) => {
  const row = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.githubId, req.session.githubId!))
    .limit(1);

  if (!row[0]) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const u = row[0];
  res.json({
    githubId: u.githubId,
    githubLogin: u.githubLogin,
    role: u.role,
    vaultAddress: u.vaultAddress ?? null,
    ownerAddress: u.ownerAddress ?? null,
  });
});

// Logout
router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ message: "Logged out" });
  });
});

export default router;
