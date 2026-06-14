import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const xUsersTable = pgTable("x_users", {
  id: serial("id").primaryKey(),
  xUserId: text("x_user_id").notNull().unique(),
  xUsername: text("x_username").notNull(),
  vaultAddress: text("vault_address"),
  ownerAddress: text("owner_address"),
  encryptedPk: text("encrypted_pk"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type XUser = typeof xUsersTable.$inferSelect;
