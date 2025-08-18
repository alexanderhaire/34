// src/plugins/fundingArb/service.ts
import type { IAgentRuntime } from '@elizaos/core';
import { Service } from '@elizaos/core';

import { env } from '../../env';
import { loadKeypair } from '../../solana/wallet';
import {
  getHourlyFundingPctAndApr,
  decideSide,
  openPerpPositionLive,
} from '../../exchanges/drift';
import { jupQuote, jupSwap } from '../../executions/jupiter';
import type { FundingArbStatus } from './types';

// Common mints for SOL market hedging
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Long‑running funding‑rate arbitrage loop (Drift perps + Jupiter spot hedge).
 * Registered as a Service by the plugin, but only started via chat action.
 */
export class FundingArbService extends Service {
  static serviceType = 'funding-arb' as const;
  capabilityDescription =
    'Runs the Solana funding-rate arbitrage loop (Drift + Jupiter).';

  private runtime!: IAgentRuntime;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  private readonly status: FundingArbStatus = {
    running: false,
    mode: String(env.FRA_PAPER).toLowerCase() === 'true' ? 'PAPER' : 'LIVE',
    thresholdApr: env.FRA_MIN_APR,
    startedAt: null,
    lastRunAt: null,
    markets: [],
    lastMessage: '',
  };

  /** Eliza calls static start() when registering services. We don't auto-run. */
  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new FundingArbService(runtime);
  }

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.runtime = runtime;
  }

  /** Begin the repeating loop (idempotent). */
  async begin(): Promise<void> {
    if (this.status.running) return;

    this.status.running = true;
    this.status.startedAt = new Date();
    this.runtime.logger?.info(
      `[funding-arb] begin | mode=${this.status.mode} threshold=${this.status.thresholdApr}% poll=${env.FRA_POLL_SECONDS}s`
    );

    // Run once immediately, then schedule.
    await this.tickSafe();
    this.timer = setInterval(
      () => this.tickSafe(),
      env.FRA_POLL_SECONDS * 1000
    );
  }

  /** Stop the loop (idempotent). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.status.running = false;
    this.runtime.logger?.info('[funding-arb] stopped');
  }

  getStatus(): FundingArbStatus {
    // return a shallow copy so callers can’t mutate internal state
    return { ...this.status, markets: [...this.status.markets] };
  }

  /** Guard against overlapping runs. */
  private async tickSafe(): Promise<void> {
    if (this.inFlight) {
      this.runtime.logger?.warn('[funding-arb] tick skipped (previous run busy)');
      return;
    }
    this.inFlight = true;
    try {
      await this.tick();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.status.lastMessage = `tick error: ${msg}`;
      this.runtime.logger?.error('[funding-arb] tick error', err);
    } finally {
      this.inFlight = false;
    }
  }

  /** One cycle over all configured markets. */
  private async tick(): Promise<void> {
    const keypair = loadKeypair(env.SOLANA_PRIVATE_KEY);

    const markets = env.FRA_MARKETS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    this.status.lastRunAt = new Date();
    this.status.markets = [];

    for (const market of markets) {
      try {
        const { hourlyPct, aprPct } = await getHourlyFundingPctAndApr(market);

        this.runtime.logger?.info(
          `[funding-arb] ${market} | hourly=${hourlyPct.toFixed(
            5
          )}% apr≈${aprPct.toFixed(2)}%`
        );

        // Update status snapshot
        this.status.markets.push({ market, hourlyPct, aprPct });

        // Skip if below threshold
        if (Math.abs(aprPct) < env.FRA_MIN_APR) continue;

        // Decide hedge direction
        const side = decideSide(hourlyPct); // hourly < 0 => LONG_PERP_SHORT_SPOT
        const notionUSDC = 500; // keep small; make configurable later

        // --- Spot hedge (Jupiter) for SOL-PERP only (extendable for others) ---
        if (market === 'SOL-PERP') {
          if (side === 'LONG_PERP_SHORT_SPOT') {
            // Sell SOL -> USDC (short spot)
            const approxPrice = 200; // consider replacing with oracle
            const solAmt = Math.max(0.001, notionUSDC / approxPrice);
            const lamports = Math.floor(solAmt * 1e9).toString();

            const quote = await jupQuote({
              inputMint: SOL_MINT,
              outputMint: USDC_MINT,
              amount: lamports,
            });
            this.runtime.logger?.info(
              `[funding-arb] JUP SOL→USDC out=${quote?.outAmount} [mode=${this.status.mode}]`
            );
            await jupSwap({ keypair, quoteResponse: quote });
          } else {
            // Buy SOL with USDC (long spot)
            const usdcAtoms = (notionUSDC * 1_000_000).toString();

            const quote = await jupQuote({
              inputMint: USDC_MINT,
              outputMint: SOL_MINT,
              amount: usdcAtoms,
            });
            this.runtime.logger?.info(
              `[funding-arb] JUP USDC→SOL out=${quote?.outAmount} [mode=${this.status.mode}]`
            );
            await jupSwap({ keypair, quoteResponse: quote });
          }
        }

        // --- Perp leg on Drift (live only when FRA_PAPER=false) ---
        await openPerpPositionLive({
          keypair,
          marketName: market,
          quoteSizeUSDC: notionUSDC,
          side: side === 'LONG_PERP_SHORT_SPOT' ? 'long' : 'short',
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this.runtime.logger?.error(`[funding-arb] ${market} cycle error`, err);
        this.status.lastMessage = `${market} error: ${msg}`;
        // continue to next market
      }
    }
  }
}
