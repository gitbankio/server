import { pgTable, serial, text, bigint, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pendingDepositsTable = pgTable("pending_deposits", {
  id: serial("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }),
  xUserId: text("x_user_id"),
  trackingAddress: text("tracking_address").notNull(),
  token: text("token").notNull(),
  tokenSymbol: text("token_symbol"),
  amountExpected: text("amount_expected"),
  issueNumber: integer("issue_number"),
  repo: text("repo"),
  installationId: integer("installation_id"),
  senderLogin: text("sender_login"),
  commentId: text("comment_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("pd_vault_token_unique").on(t.trackingAddress, t.token),
]);

export const insertPendingDepositSchema = createInsertSchema(pendingDepositsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertPendingDeposit = z.infer<typeof insertPendingDepositSchema>;
export type PendingDeposit = typeof pendingDepositsTable.$inferSelect;
