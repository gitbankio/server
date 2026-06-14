import { pgTable, serial, bigint, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const installationsTable = pgTable("installations", {
  id: serial("id").primaryKey(),
  installationId: bigint("installation_id", { mode: "number" }).notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  githubId: bigint("github_id", { mode: "number" }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertInstallationSchema = createInsertSchema(installationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertInstallation = z.infer<typeof insertInstallationSchema>;
export type Installation = typeof installationsTable.$inferSelect;
