import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";

export const x402ResultsTable = pgTable("x402_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  url: text("url").notNull(),
  amountDisplay: text("amount_display").notNull(),
  txHash: text("tx_hash").notNull(),
  payTo: text("pay_to").notNull(),
  payer: text("payer").notNull(),
  senderLogin: text("sender_login").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: text("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type X402Result = typeof x402ResultsTable.$inferSelect;
