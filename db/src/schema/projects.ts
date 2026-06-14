import { pgTable, serial, text, bigint, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  onchainProjectId: bigint("onchain_project_id", { mode: "number" }).notNull().unique(),
  ownerGithubId: bigint("owner_github_id", { mode: "number" }).notNull(),
  repo: text("repo").notNull(),
  name: text("name").notNull(),
  token: text("token").notNull(),
  totalBudget: text("total_budget").notNull(),
  spentBudget: text("spent_budget").notNull().default("0"),
  status: text("status", { enum: ["active", "completed", "cancelled"] }).notNull().default("active"),
  txHash: text("tx_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
