import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const holderTokenRewardsTable = pgTable("holder_token_rewards", {
  id: serial("id").primaryKey(),
  launchId: integer("launch_id").notNull(),
  holderAddress: text("holder_address").notNull(),
  tokenCa: text("token_ca").notNull(),
  amountWei: text("amount_wei").notNull(),
  txHash: text("tx_hash"),
  distributedAt: timestamp("distributed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertHolderTokenRewardSchema = createInsertSchema(holderTokenRewardsTable).omit({
  id: true,
  distributedAt: true,
});

export type InsertHolderTokenReward = z.infer<typeof insertHolderTokenRewardSchema>;
export type HolderTokenReward = typeof holderTokenRewardsTable.$inferSelect;
