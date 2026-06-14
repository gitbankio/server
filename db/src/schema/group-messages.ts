import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const groupMessages = pgTable("group_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  author: text("author").notNull(),
  isTeam: boolean("is_team").default(false).notNull(),
  content: text("content").notNull(),
  pinned: boolean("pinned").default(false).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  replyToId: uuid("reply_to_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type GroupMessage = typeof groupMessages.$inferSelect;
export type InsertGroupMessage = typeof groupMessages.$inferInsert;
