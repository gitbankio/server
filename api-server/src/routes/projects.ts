import { Router } from "express";
import { db, usersTable, projectsTable, tasksTable, transactionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { callVault, readVaultNonce } from "../lib/relayer";
import type { Address } from "viem";

const router = Router();

// GET /projects
router.get("/projects", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.ownerGithubId, req.session.githubId!));

    res.json(rows.map((p) => ({
      id: p.id,
      onchainProjectId: p.onchainProjectId,
      name: p.name,
      repo: p.repo,
      token: p.token,
      totalBudget: p.totalBudget,
      spentBudget: p.spentBudget,
      status: p.status,
      txHash: p.txHash ?? null,
      createdAt: p.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "GET /projects error");
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /projects
router.post("/projects", requireAuth, async (req, res) => {
  try {
    const { name, repo, token, totalBudget } = req.body as {
      name?: string; repo?: string; token?: string; totalBudget?: string;
    };
    if (!name || !repo || !token || !totalBudget) {
      res.status(400).json({ error: "name, repo, token, totalBudget required" });
      return;
    }

    const userRows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = userRows[0];
    if (!user?.vaultAddress || !user.encryptedPk) {
      res.status(400).json({ error: "Vault not deployed" });
      return;
    }

    // Generate sequential projectId (use DB id as on-chain projectId)
    const inserted = await db.insert(projectsTable).values({
      onchainProjectId: Date.now(), // temporary, updated after tx
      ownerGithubId: user.githubId,
      repo,
      name,
      token,
      totalBudget,
      spentBudget: "0",
      status: "active",
    }).returning();

    const project = inserted[0]!;
    const onchainProjectId = BigInt(project.id);

    const nonce = await readVaultNonce(user.vaultAddress as Address);
    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "createProject", [
      onchainProjectId, token as Address, BigInt(totalBudget), nonce,
    ]);

    await db.update(projectsTable)
      .set({ onchainProjectId: project.id, txHash: result.txHash })
      .where(eq(projectsTable.id, project.id));

    await db.insert(transactionsTable).values({
      type: "project_create",
      githubId: user.githubId,
      amountIn: totalBudget,
      tokenIn: token,
      txHash: result.txHash,
      status: "pending",
      projectDbId: project.id,
    });

    res.status(201).json({
      id: project.id,
      onchainProjectId: project.id,
      name: project.name,
      repo: project.repo,
      token: project.token,
      totalBudget: project.totalBudget,
      spentBudget: project.spentBudget,
      status: project.status,
      txHash: result.txHash,
      createdAt: project.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "POST /projects error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /projects/:projectId
router.get("/projects/:projectId", requireAuth, async (req, res) => {
  try {
    const projectId = parseInt(String(req.params["projectId"]), 10);
    const projRows = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
    const project = projRows[0];
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    const taskRows = await db.select().from(tasksTable).where(eq(tasksTable.projectDbId, projectId));

    res.json({
      project: {
        id: project.id,
        onchainProjectId: project.onchainProjectId,
        name: project.name,
        repo: project.repo,
        token: project.token,
        totalBudget: project.totalBudget,
        spentBudget: project.spentBudget,
        status: project.status,
        txHash: project.txHash ?? null,
        createdAt: project.createdAt.toISOString(),
      },
      tasks: taskRows.map((t) => ({
        id: t.id,
        issueNumber: t.issueNumber,
        repo: t.repo,
        contributorGithubId: t.contributorGithubId,
        contributorLogin: null,
        bountyAmount: t.bountyAmount,
        token: t.token,
        status: t.status,
        prNumber: t.prNumber ?? null,
        assignTxHash: t.assignTxHash ?? null,
        payoutTxHash: t.payoutTxHash ?? null,
        assignedAt: t.assignedAt.toISOString(),
        completedAt: t.completedAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "GET /projects/:id error");
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /projects/:projectId/tasks
router.post("/projects/:projectId/tasks", requireAuth, async (req, res) => {
  try {
    const projectId = parseInt(String(req.params["projectId"]), 10);
    const { issueNumber, repo, contributorGithubId, contributorLogin, bountyAmount } = req.body as {
      issueNumber?: number; repo?: string; contributorGithubId?: number;
      contributorLogin?: string; bountyAmount?: string;
    };

    if (!issueNumber || !repo || !contributorGithubId || !bountyAmount) {
      res.status(400).json({ error: "issueNumber, repo, contributorGithubId, bountyAmount required" });
      return;
    }

    const userRows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = userRows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const projRows = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).limit(1);
    const project = projRows[0];
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }

    // Find contributor's vault address
    const contribRows = await db.select().from(usersTable).where(eq(usersTable.githubId, contributorGithubId)).limit(1);
    const contribUser = contribRows[0];
    if (!contribUser?.vaultAddress) {
      res.status(400).json({ error: "Contributor has no deployed vault" });
      return;
    }

    const nonce = await readVaultNonce(user.vaultAddress as Address);
    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "assignTaskBounty", [
      BigInt(project.onchainProjectId),
      BigInt(issueNumber),
      contribUser.vaultAddress as Address,
      BigInt(bountyAmount),
      nonce,
    ]);

    const inserted = await db.insert(tasksTable).values({
      issueNumber,
      repo,
      projectDbId: projectId,
      contributorGithubId,
      bountyAmount,
      token: project.token,
      status: "assigned",
      assignTxHash: result.txHash,
    }).returning();

    const task = inserted[0]!;

    await db.insert(transactionsTable).values({
      type: "bounty_assign",
      githubId: user.githubId,
      amountIn: bountyAmount,
      tokenIn: project.token,
      txHash: result.txHash,
      status: "pending",
      projectDbId: projectId,
      taskDbId: task.id,
    });

    res.status(201).json({
      id: task.id,
      issueNumber: task.issueNumber,
      repo: task.repo,
      contributorGithubId: task.contributorGithubId,
      contributorLogin: contributorLogin ?? null,
      bountyAmount: task.bountyAmount,
      token: task.token,
      status: task.status,
      prNumber: null,
      assignTxHash: task.assignTxHash ?? null,
      payoutTxHash: null,
      assignedAt: task.assignedAt.toISOString(),
      completedAt: null,
    });
  } catch (err) {
    req.log.error({ err }, "POST /projects/:id/tasks error");
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /projects/:projectId/tasks/:taskId
router.delete("/projects/:projectId/tasks/:taskId", requireAuth, async (req, res) => {
  try {
    const taskId = parseInt(String(req.params["taskId"]), 10);

    const userRows = await db.select().from(usersTable).where(eq(usersTable.githubId, req.session.githubId!)).limit(1);
    const user = userRows[0];
    if (!user?.vaultAddress || !user.encryptedPk) { res.status(400).json({ error: "Vault not deployed" }); return; }

    const taskRows = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1);
    const task = taskRows[0];
    if (!task || task.status !== "assigned") { res.status(404).json({ error: "Active task not found" }); return; }

    const nonce = await readVaultNonce(user.vaultAddress as Address);
    const result = await callVault(user.encryptedPk, user.vaultAddress as Address, BigInt(user.githubId), "reclaimBounty", [
      BigInt(task.issueNumber), nonce,
    ]);

    await db.update(tasksTable).set({ status: "cancelled" }).where(eq(tasksTable.id, taskId));

    await db.insert(transactionsTable).values({
      type: "bounty_reclaim",
      githubId: user.githubId,
      amountOut: task.bountyAmount,
      tokenOut: task.token,
      txHash: result.txHash,
      status: "pending",
      projectDbId: task.projectDbId,
      taskDbId: task.id,
    });

    res.json({ txHash: result.txHash, status: result.status });
  } catch (err) {
    req.log.error({ err }, "DELETE /projects/:id/tasks/:taskId error");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
