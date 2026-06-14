import { Router } from "express";
import { db, x402ResultsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/x402/result/:id", async (req, res) => {
  const { id } = req.params as { id: string };

  let rows: typeof x402ResultsTable.$inferSelect[];
  try {
    rows = await db
      .select()
      .from(x402ResultsTable)
      .where(eq(x402ResultsTable.id, id))
      .limit(1);
  } catch {
    res.status(500).json({ error: "Database error" });
    return;
  }

  if (!rows[0]) {
    res.status(404).json({ error: "Result not found" });
    return;
  }

  res.json(rows[0]);
});

export default router;
