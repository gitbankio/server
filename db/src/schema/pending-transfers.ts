import { pgTable, serial, text, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pendingTransfersTable = pgTable("pending_transfers", {
  id: serial("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull(),
  initHash: text("init_hash").notNull().unique(),
  initNonce: bigint("init_nonce", { mode: "number" }).notNull(),
  token: text("token").notNull(),
  recipient: text("recipient").notNull(),
  amount: text("amount").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPendingTransferSchema = createInsertSchema(pendingTransfersTable).omit({
  id: true,
  createdAt: true,
});

export type InsertPendingTransfer = z.infer<typeof insertPendingTransferSchema>;
export type PendingTransfer = typeof pendingTransfersTable.$inferSelect;
