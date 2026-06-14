import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const gitStockContracts = pgTable("git_stock_contracts", {
  id:              serial("id").primaryKey(),
  ticker:          text("ticker").notNull().unique(),
  name:            text("name").notNull(),
  symbol:          text("symbol").notNull(),
  contractAddress: text("contract_address").notNull(),
  chainId:         integer("chain_id").notNull().default(8453),
  deployTxHash:    text("deploy_tx_hash"),
  deployedAt:      timestamp("deployed_at", { withTimezone: true }).defaultNow(),
});

export type GitStockContract = typeof gitStockContracts.$inferSelect;
export type InsertGitStockContract = typeof gitStockContracts.$inferInsert;
