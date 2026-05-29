import { pgTable, serial, text, bigint, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  type: text("type", {
    enum: ["lock", "unlock", "swap", "transfer", "bounty_assign", "bounty_payout", "bounty_reclaim", "project_create"],
  }).notNull(),
  githubId: bigint("github_id", { mode: "number" }).notNull(),
  tokenIn: text("token_in"),
  tokenOut: text("token_out"),
  amountIn: text("amount_in"),
  amountOut: text("amount_out"),
  feeAmount: text("fee_amount"),
  txHash: text("tx_hash"),
  status: text("status", { enum: ["pending", "confirmed", "failed"] }).notNull().default("pending"),
  blockNumber: bigint("block_number", { mode: "number" }),
  projectDbId: integer("project_db_id"),
  taskDbId: integer("task_db_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
