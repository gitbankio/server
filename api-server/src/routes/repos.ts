import { Router } from "express";
import { db, installationsTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { getInstallationToken } from "../lib/github-app";

// Discover installations from GitHub using user OAuth token, upsert into DB
async function discoverAndSaveInstallations(
  accessToken: string,
  githubId: number,
  githubLogin: string,
): Promise<void> {
  const resp = await fetch("https://api.github.com/user/installations?per_page=100", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Gitbank",
    },
  });
  if (!resp.ok) return;
  const data = (await resp.json()) as {
    installations?: Array<{
      id: number;
      account?: { login: string; type: string };
      suspended_at?: string | null;
    }>;
  };
  for (const inst of data.installations ?? []) {
    await db
      .insert(installationsTable)
      .values({
        installationId: inst.id,
        accountLogin: inst.account?.login ?? githubLogin,
        accountType: inst.account?.type ?? "User",
        githubId,
        suspendedAt: inst.suspended_at ? new Date(inst.suspended_at) : null,
      })
      .onConflictDoUpdate({
        target: installationsTable.installationId,
        set: {
          githubId,
          accountLogin: inst.account?.login ?? githubLogin,
          suspendedAt: inst.suspended_at ? new Date(inst.suspended_at) : null,
        },
      });
  }
}

const router = Router();

// GET /repos -- list repos for all of user's installations
router.get("/repos", requireAuth, async (req, res) => {
  try {
    // Auto-claim installations that were saved without a githubId (cross-site
    // redirect from GitHub means session cookie may not have been present).
    // Match by accountLogin == user's github login and link them now.
    if (req.session.githubLogin && req.session.githubId) {
      await db
        .update(installationsTable)
        .set({ githubId: req.session.githubId })
        .where(
          and(
            eq(installationsTable.accountLogin, req.session.githubLogin),
            isNull(installationsTable.githubId),
          ),
        );
    }

    let rows = await db
      .select()
      .from(installationsTable)
      .where(eq(installationsTable.githubId, req.session.githubId!));

    // Fallback: discover installations from GitHub API using the user's OAuth token.
    // This handles cases where the installation was done outside of our callback flow
    // (e.g. directly from GitHub settings page, or session cookie was missing during redirect).
    if (rows.length === 0 && req.session.accessToken && req.session.githubId && req.session.githubLogin) {
      await discoverAndSaveInstallations(
        req.session.accessToken,
        req.session.githubId,
        req.session.githubLogin,
      );
      rows = await db
        .select()
        .from(installationsTable)
        .where(eq(installationsTable.githubId, req.session.githubId!));
    }

    if (rows.length === 0) {
      res.json([]);
      return;
    }

    const result: Array<{
      installationId: number;
      accountLogin: string;
      repoId: number;
      fullName: string;
      private: boolean;
      htmlUrl: string;
    }> = [];

    for (const installation of rows) {
      try {
        const token = await getInstallationToken(installation.installationId);
        const resp = await fetch(
          "https://api.github.com/installation/repositories?per_page=100",
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Gitbank",
            },
          },
        );
        if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
        const data = (await resp.json()) as {
          repositories?: Array<{ id: number; full_name: string; private: boolean; html_url: string }>;
        };
        for (const repo of data.repositories ?? []) {
          result.push({
            installationId: installation.installationId,
            accountLogin: installation.accountLogin ?? "",
            repoId: repo.id,
            fullName: repo.full_name,
            private: repo.private,
            htmlUrl: repo.html_url,
          });
        }
      } catch {
        result.push({
          installationId: installation.installationId,
          accountLogin: installation.accountLogin ?? "",
          repoId: 0,
          fullName: `${installation.accountLogin}/*`,
          private: false,
          htmlUrl: `https://github.com/apps/gitbankbot/installations/${installation.installationId}`,
        });
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "GET /repos error");
    res.status(500).json({ error: "Internal error" });
  }
});

// DELETE /repos/:installationId -- remove installation from our DB
router.delete("/repos/:installationId", requireAuth, async (req, res) => {
  try {
    const installationId = parseInt(String(req.params["installationId"]), 10);
    if (isNaN(installationId)) {
      res.status(400).json({ error: "Invalid installationId" });
      return;
    }

    await db
      .delete(installationsTable)
      .where(
        and(
          eq(installationsTable.installationId, installationId),
          eq(installationsTable.githubId, req.session.githubId!),
        ),
      );

    res.json({ message: "Installation removed" });
  } catch (err) {
    req.log.error({ err }, "DELETE /repos/:id error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
