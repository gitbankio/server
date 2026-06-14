import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const mcpPendingTable = pgTable("mcp_pending_commands", {
  id: serial("id").primaryKey(),
  githubUsername: text("github_username").notNull(),
  command: text("command").notNull(),
  params: jsonb("params").notNull(),
  confirmCode: text("confirm_code").notNull().unique(),
  status: text("status").notNull().default("pending"),
  resultText: text("result_text"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  executionMode: text("execution_mode").notNull().default("relayer"),
  executeToken: text("execute_token").unique(),
  executeCalldata: jsonb("execute_calldata"),
  executeTokenExpiresAt: timestamp("execute_token_expires_at", { withTimezone: true }),
});

export const insertMcpPendingSchema = createInsertSchema(mcpPendingTable).omit({
  id: true,
  createdAt: true,
});

export type InsertMcpPending = z.infer<typeof insertMcpPendingSchema>;
export type McpPending = typeof mcpPendingTable.$inferSelect;
