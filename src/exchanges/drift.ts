// src/exchanges/drift.ts
import { Connection, PublicKey } from '@solana/web3.js';
import type { Keypair } from '@solana/web3.js';
import { env } from '../env';

// Optional live trading (guarded behind FRA_PAPER)
import { Wallet, DriftClient, BN } from '@drift-labs/sdk'; // :contentReference[oaicite:6]{index=6}

const DATA_API = 'https://data.api.drift.trade';

/** Hourly funding %, and extrapolated APR %, from Drift Data API. */
export async function getHourlyFundingPctAndApr(marketName: string) {
  // :contentReference[oaicite:7]{index=7}
  const url = `${DATA_API}/fundingRates?marketName=${encodeURIComponent(marketName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Drift Data API error ${res.status}`);
  const json = await res.json();

  const last = json?.fundingRates?.[json.fundingRates.length - 1];
  if (!last) return { hourlyPct: 0, aprPct: 0 };

  // fundingRate in quote/base (1e9), oraclePriceTwap (1e6)
  const fundingRate = Number(last.fundingRate) / 1e9;
  const oracleTwap  = Number(last.oraclePriceTwap) / 1e6;
  const hourlyPct   = oracleTwap ? (fundingRate / oracleTwap) * 100 : 0; // % per hour
  const aprPct      = hourlyPct * 24 * 365;
  return { hourlyPct, aprPct };
}

export type HedgeSide = 'LONG_PERP_SHORT_SPOT' | 'SHORT_PERP_LONG_SPOT';

/** Decide the hedge direction based on hourly funding. Negative = longs paid. */
export function decideSide(hourlyPct: number): HedgeSide {
  return hourlyPct < 0 ? 'LONG_PERP_SHORT_SPOT' : 'SHORT_PERP_LONG_SPOT';
}

/** Optional: open a perp position on Drift (live only when FRA_PAPER=false). */
export async function openPerpPositionLive(opts: {
  keypair: Keypair;
  marketName: string;           // e.g., "SOL-PERP"
  quoteSizeUSDC: number;        // notional size
  side: 'long' | 'short';
}) {
  if (String(env.FRA_PAPER).toLowerCase() === 'true') {
    console.log('[PAPER] Skipping live Drift trade');
    return;
  }

  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed');
  const wallet = new Wallet(opts.keypair);
  const drift = new DriftClient({ connection, wallet, env: env.DRIFT_ENV as any });
  await drift.subscribe(); // :contentReference[oaicite:8]{index=8}

  // Resolve market index from name (e.g., "SOL-PERP") then place a market order
  const { marketIndex } = drift.getMarketIndexAndType(opts.marketName); // :contentReference[oaicite:9]{index=9}
  const long = opts.side === 'long';

  // Convert USDC notional into base amount heuristically using price
  const pxData = await drift.getOraclePriceDataAndSlot(marketIndex, 0);
  const price = Number(pxData.price) / 1e6 || 0; // PRICE_PRECISION = 1e6
  if (!price) throw new Error('Oracle price unavailable');

  const baseQty = opts.quoteSizeUSDC / price;
  const baseBN = drift.convertToPerpPrecision(baseQty); // 1e9 precision

  // Market order: positive base amount for long, negative for short
  const signed = long ? baseBN : new BN(0).sub(baseBN);
  const sig = await drift.openPosition(marketIndex, signed); // :contentReference[oaicite:10]{index=10}
  console.log(`[LIVE] Drift ${opts.side} ${opts.marketName} ~${baseQty.toFixed(4)} base -> tx ${sig}`);
}
