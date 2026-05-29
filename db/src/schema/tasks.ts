import { pgTable, serial, text, bigint, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  issueNumber: integer("issue_number").notNull(),
  repo: text("repo").notNull(),
  projectDbId: integer("project_db_id").notNull(),
  contributorGithubId: bigint("contributor_github_id", { mode: "number" }).notNull(),
  bountyAmount: text("bounty_amount").notNull(),
  token: text("token").notNull(),
  status: text("status", { enum: ["assigned", "completed", "cancelled"] }).notNull().default("assigned"),
  prNumber: integer("pr_number"),
  assignTxHash: text("assign_tx_hash"),
  payoutTxHash: text("payout_tx_hash"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({
  id: true,
  assignedAt: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
