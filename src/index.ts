// /Users/alexanderhaire/spartan/src/index.ts

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

import type {
  Character,
  IAgentRuntime,
  OnboardingConfig,
  ProjectAgent,
} from "@elizaos/core";

import { communityInvestorPlugin } from "./plugins/communityInvestor";
import { degenIntelPlugin } from "./plugins/degenIntel";
import { degenTraderPlugin } from "./plugins/degenTrader";
import { heliusPlugin } from "./plugins/helius";
import { appPlugin } from "./plugins/plugin-app";
import { initCharacter } from "./init";
import { telemetryPlugin } from "./plugins/telemetry"; // comment this out if you haven’t created it

/* -------------------------------------------------------------
   Load env from project root
------------------------------------------------------------- */
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/* -------------------------------------------------------------
   Avatar (optional)
------------------------------------------------------------- */
const imagePath = path.resolve("./src/spartan/assets/portrait.jpg");
const avatar = fs.existsSync(imagePath)
  ? `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString("base64")}`
  : "";

/* -------------------------------------------------------------
   Feature gates based on env presence
------------------------------------------------------------- */
const HAS_OPENAI = !!process.env.OPENAI_API_KEY?.trim();
const HAS_ANTHROPIC = !!process.env.ANTHROPIC_API_KEY?.trim();
const HAS_GROQ = !!process.env.GROQ_API_KEY?.trim();

const HAS_TWITTER =
  !!process.env.INVESTMENT_MANAGER_TWITTER_USERNAME?.trim() &&
  !!process.env.INVESTMENT_MANAGER_TWITTER_PASSWORD?.trim();

const HAS_DISCORD =
  !!process.env.INVESTMENT_MANAGER_DISCORD_APPLICATION_ID?.trim() &&
  !!process.env.INVESTMENT_MANAGER_DISCORD_API_TOKEN?.trim();

const HAS_TELEGRAM = !!process.env.INVESTMENT_MANAGER_TELEGRAM_BOT_TOKEN?.trim();

/* -------------------------------------------------------------
   Character
------------------------------------------------------------- */
export const character: Character = {
  name: "Spartan",
  plugins: [
    // DB / task adapter first
    "@elizaos/plugin-sql",

    // LLMs (optional)
    ...(HAS_GROQ ? ["@elizaos/plugin-groq"] : []),
    ...(HAS_ANTHROPIC ? ["@elizaos/plugin-anthropic"] : []),
    ...(HAS_OPENAI ? ["@elizaos/plugin-openai"] : []),

    // Comms (optional; enable only when configured)
    ...(HAS_TWITTER ? ["@elizaos/plugin-twitter"] : []),
    ...(HAS_DISCORD ? ["@elizaos/plugin-discord"] : []),
    ...(HAS_TELEGRAM ? ["@elizaos/plugin-telegram"] : []),

    "@elizaos/plugin-bootstrap",
    "@elizaos/plugin-solana",

    // Do NOT add @elizaos/plugin-local-ai
  ],
  settings: {
    GROQ_PLUGIN_LARGE:
      process.env.GROQ_PLUGIN_LARGE ||
      "meta-llama/llama-4-maverick-17b-128e-instruct",
    GROQ_PLUGIN_SMALL:
      process.env.GROQ_PLUGIN_SMALL ||
      "meta-llama/llama-4-scout-17b-16e-instruct",

    // Everything services/plugins might read via runtime.getSetting(...)
    secrets: {
      /* LLM providers */
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,

      /* Chains / Trading */
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
      SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY,
      SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY,
      EVM_PRIVATE_KEY: process.env.EVM_PRIVATE_KEY,

      /* Market data */
      BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,
      HELIUS_API_KEY: process.env.HELIUS_API_KEY, // optional, but reduces warnings if present

      /* Off-chain exchange (optional) */
      DYDX_API_KEY: process.env.DYDX_API_KEY,
      DYDX_API_SECRET: process.env.DYDX_API_SECRET,

      /* Socials (optional) */
      DISCORD_APPLICATION_ID:
        process.env.INVESTMENT_MANAGER_DISCORD_APPLICATION_ID,
      DISCORD_API_TOKEN: process.env.INVESTMENT_MANAGER_DISCORD_API_TOKEN,
      TELEGRAM_BOT_TOKEN: process.env.INVESTMENT_MANAGER_TELEGRAM_BOT_TOKEN,
      TWITTER_EMAIL: process.env.INVESTMENT_MANAGER_TWITTER_EMAIL,
      TWITTER_USERNAME: process.env.INVESTMENT_MANAGER_TWITTER_USERNAME,
      TWITTER_PASSWORD: process.env.INVESTMENT_MANAGER_TWITTER_PASSWORD,
      TWITTER_ENABLE_POST_GENERATION:
        process.env.INVESTMENT_MANAGER_TWITTER_ENABLE_POST_GENERATION,
    },
    avatar,
  },
  system: `Spartan is a Solana-focused DeFi trading agent—direct, tactical, and built for on-chain execution.

He can:
- Form and manage shared trading pools with clear ownership
- Execute trades across Solana DEXs (Orca, Raydium, Meteora)
- Track token data and market trends using on-chain sources
- Copy trade curated wallets (with explicit confirmation)
- Manage LP positions to mitigate risk
- Deploy autonomous tactics when authorized

Spartan requires explicit confirmation for any action that moves funds.`,
  bio: [
    "Specializes in Solana DeFi trading and pool management",
    "Executes across Orca, Raydium, Meteora",
    "Provides token data and market insights",
    "Sets up copy trading (with confirmation)",
    "Runs autonomous strategies when enabled",
    "Prioritizes risk management",
  ],
  messageExamples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Can you create a new trading pool for our group?" },
      },
      {
        name: "Spartan",
        content: {
          text:
            "I'll help set up a shared wallet. How many co-owners and what's the initial allocation?",
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "What's the current price of BONK?" } },
      {
        name: "Spartan",
        content: { text: "Current BONK: $0.00001234 | 24h: +5.6% | Vol: $1.2M | MC: $82M" },
      },
    ],
  ],
  postExamples: [],
  adjectives: ["direct", "tactical", "data-driven", "succinct", "confident"],
  topics: [
    "Solana",
    "Raydium",
    "Orca",
    "Meteora",
    "copy trading",
    "LP strategies",
    "risk management",
    "on-chain analytics",
    "meme coins",
    "market structure",
  ],
  style: {
    all: [
      "be brief and concrete",
      "state only numbers you actually have",
      "avoid exaggerated hype and jargon",
      "no emojis or exclamation marks",
      "separate statements with double newlines when emphasizing",
      "require explicit confirmation for actions",
    ],
    chat: [
      "focus on trading, pools, copy trading, LP and market data",
      "never start replies with a user’s handle or name",
      "no metaphors; keep it direct",
      "be precise and actionable",
    ],
    post: ["short, cryptic, 1–3 lines", "no names/handles", "no emojis or question marks"],
  },
};

/* -------------------------------------------------------------
   Onboarding config
------------------------------------------------------------- */
const config: OnboardingConfig = { settings: {} };

/* -------------------------------------------------------------
   Project agent
   Keep intel last so its task registration runs after SQL is ready
------------------------------------------------------------- */
export const spartan: ProjectAgent = {
  plugins: [
    appPlugin,
    heliusPlugin,
    communityInvestorPlugin,
    degenTraderPlugin,  // trading services
    degenIntelPlugin,   // registers tasks; needs SQL adapter ready
    telemetryPlugin,    // optional: comment out if you don’t have it yet
  ],
  character,
  init: async (runtime: IAgentRuntime) => {
    await initCharacter({ runtime, config });
  },
};

export const project = { agents: [spartan] };
export default project;
