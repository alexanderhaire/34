// ESM/TS node worker
// Path: src/workers/fundingArb.ts
// Run:  bun run arb   (paper by default)

import 'dotenv/config';

// -------------------------------
// Env + constants
// -------------------------------
// Support both FRA_POLL_SECONDS and FRA_POLL_SEC for convenience
const POLL_SEC = Number(
  process.env.FRA_POLL_SECONDS ??
  process.env.FRA_POLL_SEC ??
  60
);
const MIN_APR_PCT = normPctEnv(process.env.FRA_MIN_APR ?? '10%'); // percent, e.g. "10%" or "10"
const PAPER = process.env.FRA_PAPER?.toLowerCase() !== 'false';    // default true
const MARKETS = (process.env.FRA_MARKETS ?? 'SOL-PERP,ETH-PERP,BTC-PERP')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Cross-venue toggles (Solana-only by default)
// FRA_PERP_PERP=true enables perp-perp checks.
// FRA_EXCH_B can be "mango" later; currently stubbed so it stays decentralized & free without extra deps.
const PERP_PERP = process.env.FRA_PERP_PERP?.toLowerCase() === 'true';
const EXCH_B = (process.env.FRA_EXCH_B ?? 'none').toLowerCase();

// Notional sizing (paper): quote-size per leg in USDC
const QUOTE_NOTIONAL = Number(process.env.FRA_NOTIONAL ?? 500);

// -------------------------------
// Contracts with your existing service layer
// (These are the *only* things you may need to align with your current service.ts)
// -------------------------------

type Funding = {
  venue: string;          // "drift" | "mango" | etc
  market: string;         // "SOL-PERP", "BTC-PERP", ...
  hourlyPct: number;      // e.g. +0.0012% => 0.0012
  aprPct: number;         // annualized percent (hourlyPct * 24 * 365)
  ts: number;
};

type PerpDirection = 'LONG' | 'SHORT';
type SpotSide = 'BUY' | 'SELL';

//
// REQUIRED: supply a Drift funding fetcher.
// Your existing worker already prints live Drift funding, so keep your current implementation.
// If you followed the earlier service.ts we drafted, just import it:
//   import { getDriftFunding } from '../plugins/fundingArb/service';
// To avoid import breakage here, we inline a minimal adapter that calls your existing code path.
// Replace the body of getDriftFunding() with your real function if needed.
//
async function getDriftFunding(market: string): Promise<Funding> {
  // TODO: replace with your real Drift funding query (kept simple so this file is drop-in).
  // For continuity with your current logs, we read from a tiny built-in mapping when env FRA_MOCK is set.
  const mock = process.env.FRA_MOCK?.toLowerCase() === 'true';
  if (mock) {
    const mockHourly: Record<string, number> = {
      'SOL-PERP': -0.00178, // %
      'ETH-PERP': +0.00118, // %
      'BTC-PERP': +0.00041, // %
    };
    const hourlyPct = mockHourly[market] ?? 0;
    return fundingSnapshot('drift', market, hourlyPct);
  }

  // If you already have working code, call it here instead of throwing:
  // return await realGetDriftFunding(market);
  throw new Error(
    `getDriftFunding("${market}") not wired in this file. 
Replace the function body with your existing Drift funding fetcher (the one already powering your logs).`
  );
}

//
// OPTIONAL: second venue funding (kept decentralized).
// For now we *simulate* or return null so you can run today with Solana-only.
// Later, implement "mango" here using Mango v4 public indexers/SDK and flip FRA_EXCH_B=mango.
//
async function getSecondaryVenueFunding(market: string): Promise<Funding | null> {
  if (!PERP_PERP || EXCH_B === 'none') return null;

  if (EXCH_B === 'mango') {
    // TODO: implement Mango v4 funding fetch here (free & decentralized).
    // Return `fundingSnapshot('mango', market, hourlyPct)` when implemented.
    return null; // keep disabled until you add Mango SDK/indexer wiring
  }

  // Unknown venue
  return null;
}

// Paper-mode "execution" placeholders so you can run safely now
async function openPerpOnDriftPaper(market: string, dir: PerpDirection, quoteNotional: number) {
  console.log(`[PAPER] Drift ${dir} ${market} notional≈$${quoteNotional}`);
}

async function openPerpOnVenueBPaper(venue: string, market: string, dir: PerpDirection, quoteNotional: number) {
  console.log(`[PAPER] ${venue.toUpperCase()} ${dir} ${market} notional≈$${quoteNotional}`);
}

// Single-venue hedge: use Jupiter for spot leg (paper build only here)
async function buildJupiterHedgePaper(baseSymbol: string, side: SpotSide, quoteNotional: number) {
  // In your live code you already build a Jupiter swap; we just mirror your log style.
  // We print a deterministic-ish placeholder "out" amount for continuity.
  const pseudoOut = Math.floor(4.66e8 + (Date.now() / 1000) % 50_000); // ~466,xxx,xxx
  const arrow = side === 'BUY' ? `${baseSymbol}→USDC` : `USDC→${baseSymbol}`;
  console.log(`    [PAPER=true] Jupiter ${arrow} out=${pseudoOut}`);
  console.log(`[PAPER] Built Jupiter swap (not signing/sending)`);
}

// -------------------------------
// Arb math helpers
// -------------------------------
function fundingSnapshot(venue: string, market: string, hourlyPct: number): Funding {
  return {
    venue,
    market,
    hourlyPct, // in percent
    aprPct: hourlyPct * 24 * 365,
    ts: Date.now(),
  };
}

function normPctEnv(s: string): number {
  const t = (s ?? '').toString().trim().replace('%', '');
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`Bad percent: "${s}"`);
  return n;
}

function fmtPct(pct: number): string {
  const sign = pct >= 0 ? '' : '';
  // Show 5 decimals like your current worker (e.g., 0.00118%)
  return `${sign}${pct.toFixed(5)}%`;
}

function decideReceiveSide(hourlyPct: number): PerpDirection {
  // If funding>0, shorts receive; if funding<0, longs receive.
  return hourlyPct >= 0 ? 'SHORT' : 'LONG';
}

function oppositeDir(d: PerpDirection): PerpDirection {
  return d === 'LONG' ? 'SHORT' : 'LONG';
}

// -------------------------------
async function oneMarketTick(market: string) {
  // 1) Drift funding
  const drift = await getDriftFunding(market);

  // Print same style as your logs
  console.log(
    `[${market}] hourly=${fmtPct(drift.hourlyPct)}  apr≈${fmtPct(drift.aprPct)}`
  );

  // 2) Optional perp-perp cross-venue check (kept decentralized & free)
  const venueB = await getSecondaryVenueFunding(market);
  if (venueB) {
    const signsOpposite = Math.sign(drift.hourlyPct) !== Math.sign(venueB.hourlyPct);
    const combinedApr = Math.abs(drift.aprPct) + Math.abs(venueB.aprPct);

    if (signsOpposite && combinedApr >= MIN_APR_PCT) {
      // Both sides can be set to "receive" funding and remain largely delta-neutral
      const driftDir = decideReceiveSide(drift.hourlyPct);   // e.g., funding>0 => SHORT on Drift
      const bDir = decideReceiveSide(venueB.hourlyPct);      // the opposite if signs are opposite

      console.log(
        `  → cross-venue threshold hit. Venues=${drift.venue}+${venueB.venue} Combined≈${fmtPct(combinedApr)}`
      );
      console.log(
        `    Plan: Drift=${driftDir}  ${market}  |  ${venueB.venue.toUpperCase()}=${bDir}  ${market}`
      );

      if (PAPER) {
        await openPerpOnDriftPaper(market, driftDir, QUOTE_NOTIONAL);
        await openPerpOnVenueBPaper(venueB.venue, market, bDir, QUOTE_NOTIONAL);
      } else {
        // TODO: wire live Drift open here and implement venueB trade when you add Mango.
        console.log(`[LIVE] TODO: open Drift ${driftDir}, then ${venueB.venue} ${bDir}`);
      }
      return; // Do not also run single-venue path
    }
  }

  // 3) Fallback: single-venue Drift funding vs spot hedge (your existing path)
  if (Math.abs(drift.aprPct) >= MIN_APR_PCT) {
    const perpSide: PerpDirection = drift.aprPct >= 0 ? 'SHORT' : 'LONG'; // receive funding
    const spotSide: SpotSide = drift.aprPct >= 0 ? 'BUY' : 'SELL';        // hedge with spot
    const base = market.replace('-PERP', '');

    console.log(`  → threshold hit. Side=${perpSide === 'SHORT' ? 'SHORT_PERP_LONG_SPOT' : 'LONG_PERP_SHORT_SPOT'}`);

    if (PAPER) {
      await buildJupiterHedgePaper(base, spotSide, QUOTE_NOTIONAL);
      console.log(`[PAPER] Skipping live Drift trade`);
    } else {
      console.log(`[LIVE] TODO: open Drift ${perpSide} ${market} and Jupiter ${spotSide} ${base}`);
      // Wire your real live execution here (Drift SDK + Jupiter swap).
    }
  }
}

// -------------------------------
async function main() {
  console.log(
    `FRA_PAPER=${PAPER}  FRA_MIN_APR=${MIN_APR_PCT}%  Poll=${POLL_SEC}s`
  );

  // Simple loop; can be switched later to Eliza task scheduler if you prefer
  // (the plan keeps a 60s interval polling approach).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const m of MARKETS) {
      try {
        await oneMarketTick(m);
      } catch (err) {
        console.error(`[${m}] error:`, (err as Error).message);
      }
    }
    await sleep(POLL_SEC * 1000);
  }
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
