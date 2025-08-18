// src/plugins/fundingArb/service.ts
import type { IAgentRuntime } from '@elizaos/core';
import { Service } from '@elizaos/core';
import { env } from '../../env';
import { loadKeypair } from '../../solana/wallet';
import {
  getHourlyFundingPctAndApr,
  decideSide,
  openPerpPositionLive
} from '../../exchanges/drift';
import { jupQuote, jupSwap } from '../../executions/jupiter';
import type { FundingArbStatus } from './types';

// Let Eliza know we have a plugin-defined service type
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    FUNDING_ARB: 'funding-arb';
  }
}

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export class FundingArbService extends Service {
  static serviceType = 'funding-arb' as const;
  capabilityDescription = 'Runs the Solana funding-rate arbitrage loop (Drift + Jupiter).';

  private runtime!: IAgentRuntime;
  private timer?: NodeJS.Timeout;
  private readonly status: FundingArbStatus = {
    running: false,
    mode: String(env.FRA_PAPER).toLowerCase() === 'true' ? 'PAPER' : 'LIVE',
    thresholdApr: env.FRA_MIN_APR,
    startedAt: null,
    lastRunAt: null,
    markets: [],
    lastMessage: ''
  };

  // Eliza calls static start() when registering services.
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const svc = new FundingArbService(runtime);
    return svc; // do not auto-begin; wait for action
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
    await this.tick(); // run one immediately
    this.timer = setInterval(
      () => this.tick().catch(err => this.runtime.logger?.error('fundingArb tick', err)),
      env.FRA_POLL_SECONDS * 1000
    );
  }

  /** Stop the loop (idempotent). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.status.running = false;
  }

  getStatus(): FundingArbStatus {
    return { ...this.status };
  }

  private async tick(): Promise<void> {
    const kp = loadKeypair(env.SOLANA_PRIVATE_KEY);
    const markets = env.FRA_MARKETS.split(',').map(s => s.trim()).filter(Boolean);
    this.status.lastRunAt = new Date();
    this.status.markets = [];

    for (const market of markets) {
      const { hourlyPct, aprPct } = await getHourlyFundingPctAndApr(market);
      this.runtime.logger?.info(`[FUNDING] ${market}: hr=${hourlyPct.toFixed(5)}% apr≈${aprPct.toFixed(2)}%`);
      this.status.markets.push({ market, hourlyPct, aprPct });

      if (Math.abs(aprPct) < env.FRA_MIN_APR) continue;

      const side = decideSide(hourlyPct); // hourly < 0 => LONG_PERP_SHORT_SPOT
      const notionUSDC = 500; // KEEP SMALL; tune later

      // Hedge spot leg on SOL market via Jupiter (optional)
      if (market === 'SOL-PERP') {
        if (side === 'LONG_PERP_SHORT_SPOT') {
          // Sell SOL -> USDC (short spot)
          const approxPrice = 200; // consider replacing with oracle price
          const solAmt = Math.max(0.001, notionUSDC / approxPrice);
          const lamports = Math.floor(solAmt * 1e9).toString();
          const quote = await jupQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: lamports });
          this.runtime.logger?.info(`[JUP] SOL→USDC out=${quote.outAmount} [mode=${this.status.mode}]`);
          await jupSwap({ keypair: kp, quoteResponse: quote });
        } else {
          // Buy SOL with USDC (long spot)
          const usdcAtoms = (notionUSDC * 1_000_000).toString();
          const quote = await jupQuote({ inputMint: USDC_MINT, outputMint: SOL_MINT, amount: usdcAtoms });
          this.runtime.logger?.info(`[JUP] USDC→SOL out=${quote.outAmount} [mode=${this.status.mode}]`);
          await jupSwap({ keypair: kp, quoteResponse: quote });
        }
      }

      await openPerpPositionLive({
        keypair: kp,
        marketName: market,
        quoteSizeUSDC: notionUSDC,
        side: side === 'LONG_PERP_SHORT_SPOT' ? 'long' : 'short'
      });
    }
  }
}
