import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const groupAccounts = pgTable("group_accounts", {
  displayName: text("display_name").primaryKey(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GroupAccount = typeof groupAccounts.$inferSelect;
export type InsertGroupAccount = typeof groupAccounts.$inferInsert;
