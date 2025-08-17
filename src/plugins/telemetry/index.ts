// src/plugins/telemetry/index.ts
import type { IAgentRuntime, Plugin, UUID, Task, RegisterTaskWorkerOptions } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";

// Helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureTable(runtime: IAgentRuntime) {
  const adapter: any = (runtime as any).adapter;
  if (!adapter?.query) {
    logger.warn("[telemetry] SQL adapter not ready; snapshots disabled");
    return false;
  }
  await adapter.query(`
    CREATE TABLE IF NOT EXISTS telemetry_snapshots (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      portfolio_usd NUMERIC,
      sol_balance NUMERIC,
      sol_price NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_snapshots_agent_created
      ON telemetry_snapshots (agent_id, created_at DESC);
  `);
  return true;
}

async function getSolBalanceLamports(rpcUrl: string, pubkey: string) {
  const conn = new Connection(rpcUrl, "confirmed");
  const lamports = await conn.getBalance(new PublicKey(pubkey));
  return lamports;
}

async function getSolPriceUsd(birdeyeKey: string) {
  // Birdeye single-price endpoint (SOL mint): So11111111111111111111111111111111111111112
  const url = "https://public-api.birdeye.so/defi/price?chain=solana&address=So11111111111111111111111111111111111111112";
  const res = await fetch(url, { headers: { "X-API-KEY": birdeyeKey, accept: "application/json" } });
  if (!res.ok) throw new Error(`Birdeye price failed: ${res.status}`);
  const json = await res.json();
  // typical shape: { success: true, data: { value: 123.45 } }
  const price = json?.data?.value ?? json?.data?.price ?? json?.data;
  if (typeof price !== "number") throw new Error("Unexpected Birdeye price response");
  return price;
}

async function writeSnapshot(runtime: IAgentRuntime, data: {
  portfolioUsd: number,
  solBalance: number,
  solPrice: number,
}) {
  const adapter: any = (runtime as any).adapter;
  if (!adapter?.query) return;
  await adapter.query(
    `INSERT INTO telemetry_snapshots (agent_id, portfolio_usd, sol_balance, sol_price)
     VALUES ($1, $2, $3, $4);`,
    [runtime.agentId, data.portfolioUsd, data.solBalance, data.solPrice]
  );
}

const workerName = "TELEMETRY_SNAPSHOT";

export const telemetryPlugin: Plugin = {
  name: "telemetry",
  description: "Collect periodic wallet/portfolio telemetry and expose a simple HTTP endpoint.",
  init: async (runtime: IAgentRuntime) => {
    // Ensure DB table
    const ok = await ensureTable(runtime);
    if (!ok) return;

    // Add a simple route: GET /telemetry/latest -> latest row
    try {
      // App/server is provided by @elizaos/server (brought by your stack).
      // We defensively attach to a global router if present.
      const anyRt = runtime as any;
      const app = anyRt?.server?.app || anyRt?.web?.app || anyRt?.router;
      if (app?.get) {
        app.get("/telemetry/latest", async (_req: any, res: any) => {
          try {
            const adapter: any = (runtime as any).adapter;
            const rows = await adapter.query(
              `SELECT * FROM telemetry_snapshots
               WHERE agent_id = $1
               ORDER BY created_at DESC
               LIMIT 1;`,
              [runtime.agentId]
            );
            res.status(200).json({ success: true, data: rows?.[0] ?? null });
          } catch (e) {
            res.status(500).json({ success: false, error: String(e) });
          }
        });
        logger.info("[telemetry] HTTP route GET /telemetry/latest registered");
      } else {
        logger.warn("[telemetry] No HTTP app/router found; endpoint disabled");
      }
    } catch (e) {
      logger.warn("[telemetry] Failed to attach HTTP route", e);
    }

    // Register worker
    runtime.registerTaskWorker({
      name: workerName,
      validate: async () => {
        const rpc = runtime.getSetting("SOLANA_RPC_URL") || process.env.SOLANA_RPC_URL;
        const pub = runtime.getSetting("SOLANA_PUBLIC_KEY") || process.env.SOLANA_PUBLIC_KEY;
        const be = runtime.getSetting("BIRDEYE_API_KEY") || process.env.BIRDEYE_API_KEY;
        if (!rpc || !pub || !be) {
          logger.warn("[telemetry] Missing SOLANA_RPC_URL / SOLANA_PUBLIC_KEY / BIRDEYE_API_KEY");
          return false;
        }
        return true;
      },
      execute: async (rt) => {
        try {
          const rpc = rt.getSetting("SOLANA_RPC_URL") || process.env.SOLANA_RPC_URL!;
          const pub = rt.getSetting("SOLANA_PUBLIC_KEY") || process.env.SOLANA_PUBLIC_KEY!;
          const bird = rt.getSetting("BIRDEYE_API_KEY") || process.env.BIRDEYE_API_KEY!;

          const lamports = await getSolBalanceLamports(rpc, pub);
          const solBalance = lamports / 1e9;
          const solPrice = await getSolPriceUsd(bird);
          const portfolioUsd = solBalance * solPrice;

          await writeSnapshot(rt, { portfolioUsd, solBalance, solPrice });
          logger.info(`[telemetry] Snapshot => USD:${portfolioUsd.toFixed(2)}  SOL:${solBalance.toFixed(4)} @ $${solPrice.toFixed(2)}`);
        } catch (e) {
          logger.warn("[telemetry] Snapshot failed", e);
        }
      },
    });

    // Create the repeating task (5m) if it doesn't exist
    try {
      const tasks = await runtime.getTasksByName(workerName);
      if (!tasks?.length) {
        await runtime.createTask({
          name: workerName,
          description: "Record wallet telemetry snapshot",
          worldId: runtime.agentId as UUID,
          metadata: {
            createdAt: Date.now(),
            updatedAt: Date.now(),
            updateInterval: 1000 * 60 * 5, // 5 minutes
          },
          tags: ["queue", "repeat", "telemetry", "immediate"],
        });
        logger.info("[telemetry] Task created");
      } else {
        logger.info("[telemetry] Task already exists");
      }
    } catch (e) {
      logger.warn("[telemetry] Failed to create task (will retry on next boot)", e);
    }
  },
};

export default telemetryPlugin;
