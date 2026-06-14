import { pgTable, text, integer, bigint, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const contestEntriesTable = pgTable("contest_entries", {
  id: text("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  wallet: text("wallet").notNull(),
  templateTitle: text("template_title").notNull(),
  appType: text("app_type").notNull().unique(),
  prNumber: integer("pr_number").notNull(),
  prUrl: text("pr_url").notNull(),
  txHash: text("tx_hash"),
  entryNumber: integer("entry_number").notNull(),
  status: text("status", { enum: ["pending", "paid", "failed"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("contest_entries_entry_number_unique").on(t.entryNumber),
]);

export const insertContestEntrySchema = createInsertSchema(contestEntriesTable).omit({
  createdAt: true,
});

export type InsertContestEntry = z.infer<typeof insertContestEntrySchema>;
export type ContestEntry = typeof contestEntriesTable.$inferSelect;
