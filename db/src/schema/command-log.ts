import { pgTable, serial, text, bigint, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const commandLogTable = pgTable("command_log", {
  id: serial("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull(),
  repo: text("repo").notNull(),
  issueNumber: integer("issue_number").notNull(),
  commandText: text("command_text").notNull(),
  intent: text("intent"),
  result: text("result", { enum: ["success", "failure", "pending", "clarify", "unknown"] }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertCommandLogSchema = createInsertSchema(commandLogTable).omit({
  id: true,
  createdAt: true,
});

export type InsertCommandLog = z.infer<typeof insertCommandLogSchema>;
export type CommandLog = typeof commandLogTable.$inferSelect;
