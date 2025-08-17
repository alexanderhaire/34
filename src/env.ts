// src/env.ts
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),

  SOLANA_RPC_URL: z.string().url(),
  SOLANA_PRIVATE_KEY: z.string(),
  SOLANA_PUBLIC_KEY: z.string(),

  FRA_MARKETS: z.string().default('SOL-PERP,ETH-PERP'),
  FRA_MIN_APR: z.coerce.number().default(25),
  FRA_POLL_SECONDS: z.coerce.number().default(60),
  FRA_PAPER: z.string().default('true'),

  DRIFT_ENV: z.enum(['mainnet-beta', 'devnet']).default('mainnet-beta'),
  DRIFT_SUBACCOUNT_ID: z.coerce.number().default(0),

  JUPITER_API_KEY: z.string().optional(),
  PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().default(10000),
});

export const env = EnvSchema.parse(process.env);
