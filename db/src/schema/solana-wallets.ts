import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const solanaWallets = pgTable("solana_wallets", {
  id:              serial("id").primaryKey(),
  githubId:        text("github_id").notNull().unique(),
  encryptedPrivKey: text("encrypted_priv_key").notNull(),
  publicKey:       text("public_key").notNull(),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export type SolanaWallet = typeof solanaWallets.$inferSelect;
export type InsertSolanaWallet = typeof solanaWallets.$inferInsert;
