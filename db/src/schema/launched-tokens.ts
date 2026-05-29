import { pgTable, serial, text, bigint, integer, timestamp, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const launchedTokensTable = pgTable("launched_tokens", {
  id: serial("id").primaryKey(),
  tokenName: text("token_name").notNull(),
  tokenSymbol: text("token_symbol").notNull(),
  contractAddress: text("contract_address").notNull().unique(),
  deployerGithubLogin: text("deployer_github_login").notNull(),
  deployerGithubId: bigint("deployer_github_id", { mode: "number" }).notNull(),
  txHash: text("tx_hash"),
  chainId: integer("chain_id").notNull().default(8453),
  websiteUrl: text("website_url"),
  twitterUrl: text("twitter_url"),
  imageUrl: text("image_url"),
  marketCapUsd: doublePrecision("market_cap_usd").default(0),
  githubCommentUrl: text("github_comment_url"),
  launchedAt: timestamp("launched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertLaunchedTokenSchema = createInsertSchema(launchedTokensTable).omit({
  id: true,
  launchedAt: true,
});

export type InsertLaunchedToken = z.infer<typeof insertLaunchedTokenSchema>;
export type LaunchedToken = typeof launchedTokensTable.$inferSelect;
