import { pgTable, text, jsonb, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scaffoldsTable = pgTable("scaffolds", {
  id: text("id").primaryKey(),
  githubId: bigint("github_id", { mode: "number" }).notNull(),
  prompt: text("prompt").notNull(),
  files: jsonb("files").$type<Array<{ path: string; content: string }>>().notNull().default([]),
  status: text("status", { enum: ["generating", "ready", "deployed"] }).notNull().default("generating"),
  repoUrl: text("repo_url"),
  pagesUrl: text("pages_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertScaffoldSchema = createInsertSchema(scaffoldsTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertScaffold = z.infer<typeof insertScaffoldSchema>;
export type Scaffold = typeof scaffoldsTable.$inferSelect;
