import { pgTable, serial, text, timestamp, uniqueIndex, doublePrecision } from "drizzle-orm/pg-core";

export const rwaPositions = pgTable("rwa_positions", {
  id:                 serial("id").primaryKey(),
  githubId:           text("github_id").notNull(),
  ticker:             text("ticker").notNull(),
  ondaMintAddress:    text("onda_mint_address").notNull(),
  gitStockContract:   text("git_stock_contract").notNull(),
  amount:             text("amount").notNull().default("0"),
  costBasisUsdc:      text("cost_basis_usdc").notNull().default("0"),
  solanaWalletPubkey: text("solana_wallet_pubkey").notNull(),
  buyTxSolana:        text("buy_tx_solana"),
  buyTxBase:          text("buy_tx_base"),
  pnlUsdc:            doublePrecision("pnl_usdc").default(0),
  createdAt:          timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  uniqueIndex("rwa_positions_github_ticker_idx").on(t.githubId, t.ticker),
]);

export type RwaPosition = typeof rwaPositions.$inferSelect;
export type InsertRwaPosition = typeof rwaPositions.$inferInsert;
