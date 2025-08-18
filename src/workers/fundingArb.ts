// ESM/TS node worker
// Path: src/workers/fundingArb.ts
// Run:  bun run arb   (paper by default)

import 'dotenv/config';
import { getHourlyFundingPctAndApr } from '../exchanges/drift';
import { getDydxFunding } from '../exchanges/dydx';

// -------------------------------
// Env + constants
// -------------------------------
const POLL_SEC = Number(
  process.env.FRA_POLL_SECONDS ??
  process.env.FRA_POLL_SEC ??
  60
);

// Enter/exit hysteresis for *both* single-venue and cross-venue checks
const ENTER_APR = normPctEnv(process.env.FRA_ENTER_APR ?? process.env.FRA_MIN_APR ?? '10%'); // percent
const EXIT_APR  = process.env.FRA_EXIT_APR
  ? normPctEnv(process.env.FRA_EXIT_APR)
  : Math.max(0, Math.round(ENTER_APR * 0.6 * 100) / 100); // default 60% of enter

const COOLDOWN_SEC = Number(process.env.FRA_COOLDOWN_SEC ?? 300); // default 5m
const PAPER = process.env.FRA_PAPER?.toLowerCase() !== 'false';   // default true

const MARKETS = Array.from(
  new Set(
    (process.env.FRA_MARKETS ?? 'SOL-PERP,ETH-PERP,BTC-PERP')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )
);

// Cross-venue toggles
const PERP_PERP = process.env.FRA_PERP_PERP?.toLowerCase() === 'true';
// Second venue: 'dydx' (adapter included), or 'mango' (TODO stub)
const EXCH_B = (process.env.FRA_EXCH_B ?? 'none').toLowerCase();

// Notional sizing (paper): quote-size per leg in USDC
const QUOTE_NOTIONAL = Number(process.env.FRA_NOTIONAL ?? 500);

// Treat very small hourly rates as 0 to avoid noisy sign flips
const EPS = Number(process.env.FRA_EPS ?? 1e-6);
const sgn = (x: number) => (Math.abs(x) <= EPS ? 0 : x > 0 ? 1 : -1);

// -------------------------------
// Types & State
// -------------------------------
type Funding = {
  venue: string;          // "drift" | "dydx" | "mango"
  market: string;         // our key, e.g. "SOL-PERP"
  hourlyPct: number;      // percent per hour (e.g., 0.001 => 0.001%)
  aprPct: number;         // percent per year (hourly * 24 * 365)
  ts: number;
};

type PerpDirection = 'LONG' | 'SHORT';
type SpotSide = 'BUY' | 'SELL';

type PositionState = {
  open: boolean;
  perpSide: PerpDirection;
  spotSide: SpotSide;
  openedAt: number;
  lastActionAt: number;
  lastApr: number;
};

type CrossPos = {
  open: boolean;
  driftSide: PerpDirection;
  venueBSide: PerpDirection;
  openedAt: number;
  lastActionAt: number;
  lastNetApr: number;    // combined net APR when last action occurred
};

const positions = new Map<string, PositionState>(); // single-venue (Drift + spot)
const crossPos  = new Map<string, CrossPos>();      // cross-venue (Drift + VenueB perps)

// -------------------------------
// Live venue funding adapters
// -------------------------------

/**
 * Drift funding (LIVE ONLY) — mock removed on purpose.
 * Uses your adapter: getHourlyFundingPctAndApr(market) => { hourlyPct, aprPct }
 */
async function getDriftFunding(market: string): Promise<Funding> {
  const { hourlyPct, aprPct } = await getHourlyFundingPctAndApr(market);
  return { venue: 'drift', market, hourlyPct, aprPct, ts: Date.now() };
}

/**
 * Venue B funding (currently: dYdX live; Mango stubbed)
 */
async function getVenueBFunding(market: string): Promise<Funding | null> {
  if (!PERP_PERP || EXCH_B === 'none') return null;

  if (EXCH_B === 'dydx') {
    try {
      const f = await getDydxFunding(market);
      return {
        venue: 'dydx',
        market,                 // keep our key name for state map
        hourlyPct: f.hourlyPct, // already %/hr
        aprPct: f.aprPct,
        ts: Date.now(),
      };
    } catch (e: any) {
      console.log(`[${market}] dYdX funding fetch failed: ${e?.message ?? e}`);
      return null;
    }
  }

  if (EXCH_B === 'mango') {
    // TODO: implement Mango v4 funding fetch here (free & decentralized).
    // Return fundingSnapshot('mango', market, hourlyPct) when implemented.
    return null;
  }

  return null;
}

// -------------------------------
// Paper-mode “execution” helpers (safe)
// -------------------------------
async function openPerpOnDriftPaper(market: string, dir: PerpDirection, quoteNotional: number) {
  console.log(`[PAPER] OPEN Drift ${dir} ${market} notional≈$${quoteNotional}`);
}
async function closePerpOnDriftPaper(market: string) {
  console.log(`[PAPER] CLOSE Drift ${market}`);
}
async function openPerpOnVenueBPaper(venue: string, market: string, dir: PerpDirection, quoteNotional: number) {
  console.log(`[PAPER] OPEN ${venue.toUpperCase()} ${dir} ${market} notional≈$${quoteNotional}`);
}
async function closePerpOnVenueBPaper(venue: string, market: string) {
  console.log(`[PAPER] CLOSE ${venue.toUpperCase()} ${market}`);
}

// Single-venue hedge: use Jupiter (paper)
async function buildJupiterHedgePaper(baseSymbol: string, side: SpotSide, quoteNotional: number) {
  const pseudoOut = Math.floor(4.66e8 + (Date.now() / 1000) % 50_000);
  const arrow = side === 'BUY' ? `USDC→${baseSymbol}` : `${baseSymbol}→USDC`;
  console.log(`    [PAPER=true] Jupiter ${arrow} out=${pseudoOut}`);
  console.log(`[PAPER] Built Jupiter swap (not signing/sending)`);
}
async function closeJupiterHedgePaper(baseSymbol: string, sideAtOpen: SpotSide, quoteNotional: number) {
  const side = sideAtOpen === 'BUY' ? 'SELL' : 'BUY';
  const arrow = side === 'BUY' ? `USDC→${baseSymbol}` : `${baseSymbol}→USDC`;
  const pseudoOut = Math.floor(4.66e8 + (Date.now() / 1000) % 50_000);
  console.log(`    [PAPER=true] Jupiter CLOSE ${arrow} out=${pseudoOut}`);
  console.log(`[PAPER] Built Jupiter close swap (not signing/sending)`);
}

// -------------------------------
// Math / Decisions
// -------------------------------
function fundingSnapshot(venue: string, market: string, hourlyPct: number): Funding {
  return {
    venue,
    market,
    hourlyPct,
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
  return `${pct.toFixed(5)}%`;
}
function decideReceivePerpSide(hourlyPct: number): PerpDirection {
  // If funding>0, shorts receive; if funding<0, longs receive.
  return hourlyPct >= 0 ? 'SHORT' : 'LONG';
}
function spotSideForPerp(perpSide: PerpDirection): SpotSide {
  return perpSide === 'SHORT' ? 'BUY' : 'SELL';
}
function nowMs() { return Date.now(); }
function inCooldown(lastActionAt: number, cooldownSec: number) {
  return nowMs() - lastActionAt < cooldownSec * 1000;
}

/**
 * Cross-ex net APR and sides:
 * - Opposite signs (non-zero): you can receive on both sides => net = |A| + |B|
 * - One side ~0: treat as single receive => net = max(|A|, |B|)
 * - Same sign: receive larger, pay smaller => net = |larger| - |smaller|
 */
function crossDecision(
  driftHourly: number, driftApr: number,
  bHourly: number,     bApr: number
): { netApr: number; driftSide: PerpDirection; venueBSide: PerpDirection; reason: string } {
  const sA = sgn(driftHourly);
  const sB = sgn(bHourly);
  const absA = Math.abs(driftApr);
  const absB = Math.abs(bApr);

  // both non-zero and opposite → receive both
  if (sA !== 0 && sB !== 0 && sA !== sB) {
    return {
      netApr: absA + absB,
      driftSide: decideReceivePerpSide(driftHourly),
      venueBSide: decideReceivePerpSide(bHourly),
      reason: 'opposite signs → receive both',
    };
  }

  // exactly one side ~0 → effectively single receive
  if ((sA === 0) !== (sB === 0)) {
    const driftSide = decideReceivePerpSide(driftHourly);
    const venueBSide = decideReceivePerpSide(bHourly);
    return {
      netApr: Math.max(absA, absB),
      driftSide,
      venueBSide,
      reason: 'one side ~0 → receive single',
    };
  }

  // same sign (or both ~0) → receive larger, pay smaller
  const aBigger = absA >= absB;
  const driftSide = sA > 0 ? (aBigger ? 'SHORT' : 'LONG') : (aBigger ? 'LONG' : 'SHORT');
  const venueBSide = sA > 0 ? (aBigger ? 'LONG' : 'SHORT') : (aBigger ? 'SHORT' : 'LONG');
  return {
    netApr: Math.abs(absA - absB),
    driftSide,
    venueBSide,
    reason: 'same sign → receive larger, pay smaller',
  };
}

// -------------------------------
// One market tick
// -------------------------------
async function oneMarketTick(market: string) {
  // DRIFT
  const drift = await getDriftFunding(market);
  console.log(`[${market}] DRIFT hourly=${fmtPct(drift.hourlyPct)}  apr≈${fmtPct(drift.aprPct)}`);

  // VENUE B (dYdX or Mango)
  const venueB = await getVenueBFunding(market);
  if (venueB) {
    console.log(`[${market}] ${venueB.venue.toUpperCase()} hourly=${fmtPct(venueB.hourlyPct)}  apr≈${fmtPct(venueB.aprPct)}`);

    // Cross-venue decision (perp-perp)
    const dec = crossDecision(drift.hourlyPct, drift.aprPct, venueB.hourlyPct, venueB.aprPct);

    // Always show the combined net & suggested sides for transparency
    console.log(`[${market}] CROSS net≈${fmtPct(dec.netApr)} (${dec.reason}) ENTER=${ENTER_APR}% EXIT=${EXIT_APR}%`);
    console.log(`          Plan if trade: Drift=${dec.driftSide} | ${venueB.venue.toUpperCase()}=${dec.venueBSide}`);

    const cp = crossPos.get(market);
    const cooling = cp ? inCooldown(cp.lastActionAt, COOLDOWN_SEC) : false;
    const wait = cp ? Math.ceil(Math.max(0, COOLDOWN_SEC * 1000 - (nowMs() - cp.lastActionAt)) / 1000) : 0;

    if (!cp || !cp.open) {
      if (dec.netApr >= ENTER_APR) {
        if (cooling) {
          console.log(`  ↳ CROSS ENTER gated by cooldown (${wait}s)`);
        } else {
          console.log(`  → [CROSS ENTER] Net≈${fmtPct(dec.netApr)} | ${dec.reason}`);
          if (PAPER) {
            await openPerpOnDriftPaper(market, dec.driftSide, QUOTE_NOTIONAL);
            await openPerpOnVenueBPaper(venueB.venue, market, dec.venueBSide, QUOTE_NOTIONAL);
          } else {
            console.log(`[LIVE] TODO: open Drift ${dec.driftSide}, then ${venueB.venue} ${dec.venueBSide}`);
          }
          crossPos.set(market, {
            open: true,
            driftSide: dec.driftSide,
            venueBSide: dec.venueBSide,
            openedAt: nowMs(),
            lastActionAt: nowMs(),
            lastNetApr: dec.netApr,
          });
          return; // don't also single-venue enter on the same tick
        }
      }
      // If no cross entry, we continue to single-venue logic below
    } else {
      // Cross position open → manage
      const flip =
        cp.driftSide !== dec.driftSide || cp.venueBSide !== dec.venueBSide;
      const shouldClose = dec.netApr <= EXIT_APR || (flip && dec.netApr < ENTER_APR);
      const shouldFlip  = flip && dec.netApr >= ENTER_APR;

      if (shouldClose) {
        if (cooling) {
          console.log(`  ↳ CROSS CLOSE gated by cooldown (${wait}s); holding`);
        } else {
          console.log(`  → [CROSS CLOSE] Net≈${fmtPct(dec.netApr)} (≤${EXIT_APR}% or weak flip)`);
          if (PAPER) {
            await closePerpOnVenueBPaper(venueB.venue, market);
            await closePerpOnDriftPaper(market);
          } else {
            console.log(`[LIVE] TODO: close ${venueB.venue} & Drift perps`);
          }
          crossPos.set(market, {
            ...cp,
            open: false,
            lastActionAt: nowMs(),
            lastNetApr: dec.netApr,
          });
        }
        // After cross close, we can still consider single-venue below
      } else if (shouldFlip) {
        if (cooling) {
          console.log(`  ↳ CROSS FLIP gated by cooldown (${wait}s); holding`);
        } else {
          console.log(`  → [CROSS FLIP] Net≈${fmtPct(dec.netApr)} | ${dec.reason}`);
          if (PAPER) {
            await closePerpOnVenueBPaper(venueB.venue, market);
            await closePerpOnDriftPaper(market);
            await openPerpOnDriftPaper(market, dec.driftSide, QUOTE_NOTIONAL);
            await openPerpOnVenueBPaper(venueB.venue, market, dec.venueBSide, QUOTE_NOTIONAL);
          } else {
            console.log(`[LIVE] TODO: flip ${venueB.venue} & Drift perps`);
          }
          crossPos.set(market, {
            open: true,
            driftSide: dec.driftSide,
            venueBSide: dec.venueBSide,
            openedAt: cp.openedAt,
            lastActionAt: nowMs(),
            lastNetApr: dec.netApr,
          });
        }
        return; // don't also single-venue manage on the same tick
      } else {
        console.log(`  ↳ CROSS holding (Drift=${cp.driftSide} / ${venueB.venue.toUpperCase()}=${cp.venueBSide}). Net≈${fmtPct(dec.netApr)} ENTER=${ENTER_APR}% EXIT=${EXIT_APR}%`);
        return; // if cross is open, we stop here to avoid double exposure
      }
    }
  }

  // If cross either not enabled/not open/not eligible → manage single-venue (Drift + spot) with state.
  const pos = positions.get(market);
  const absApr = Math.abs(drift.aprPct);
  const desiredPerp = decideReceivePerpSide(drift.hourlyPct);
  const desiredSpot = spotSideForPerp(desiredPerp);
  const coolingSV = pos ? inCooldown(pos.lastActionAt, COOLDOWN_SEC) : false;
  const waitSV = pos ? Math.ceil(Math.max(0, COOLDOWN_SEC * 1000 - (nowMs() - pos.lastActionAt)) / 1000) : 0;

  if (!pos || !pos.open) {
    if (absApr >= ENTER_APR) {
      if (coolingSV) {
        console.log(`  ↳ SV ENTER gated by cooldown (${waitSV}s)`);
      } else {
        console.log(
          `  → [SV ENTER] ≥${ENTER_APR}% Side=${desiredPerp === 'SHORT' ? 'SHORT_PERP_LONG_SPOT' : 'LONG_PERP_SHORT_SPOT'}`
        );
        if (PAPER) {
          await buildJupiterHedgePaper(market.replace('-PERP', ''), desiredSpot, QUOTE_NOTIONAL);
          await openPerpOnDriftPaper(market, desiredPerp, QUOTE_NOTIONAL);
        } else {
          console.log(`[LIVE] TODO: open Drift ${desiredPerp} ${market} + Jupiter ${desiredSpot}`);
        }
        positions.set(market, {
          open: true,
          perpSide: desiredPerp,
          spotSide: desiredSpot,
          openedAt: nowMs(),
          lastActionAt: nowMs(),
          lastApr: drift.aprPct,
        });
      }
    } else {
      console.log(`  ↳ below SV ENTER ${ENTER_APR}% → no single-venue action`);
    }
    return;
  }

  // Single-venue position is open → manage it
  const signalFlipped = desiredPerp !== pos.perpSide;
  const shouldClose = absApr <= EXIT_APR || (signalFlipped && absApr < ENTER_APR);
  const shouldFlip = signalFlipped && absApr >= ENTER_APR;

  if (shouldClose) {
    if (coolingSV) {
      console.log(`  ↳ SV CLOSE gated by cooldown (${waitSV}s); holding`);
      return;
    }
    console.log(`  → [SV CLOSE] ≤${EXIT_APR}% or weak flip`);
    if (PAPER) {
      await closeJupiterHedgePaper(market.replace('-PERP', ''), pos.spotSide, QUOTE_NOTIONAL);
      await closePerpOnDriftPaper(market);
    } else {
      console.log(`[LIVE] TODO: close Drift + reverse Jupiter`);
    }
    positions.set(market, {
      ...pos,
      open: false,
      lastActionAt: nowMs(),
      lastApr: drift.aprPct,
    });
    return;
  }

  if (shouldFlip) {
    if (coolingSV) {
      console.log(`  ↳ SV FLIP gated by cooldown (${waitSV}s); holding`);
      return;
    }
    console.log(`  → [SV FLIP] ${pos.perpSide}→${desiredPerp} (≥${ENTER_APR}%)`);
    if (PAPER) {
      await closeJupiterHedgePaper(market.replace('-PERP', ''), pos.spotSide, QUOTE_NOTIONAL);
      await closePerpOnDriftPaper(market);
      await buildJupiterHedgePaper(market.replace('-PERP', ''), desiredSpot, QUOTE_NOTIONAL);
      await openPerpOnDriftPaper(market, desiredPerp, QUOTE_NOTIONAL);
    } else {
      console.log(`[LIVE] TODO: flip Drift + hedge`);
    }
    positions.set(market, {
      open: true,
      perpSide: desiredPerp,
      spotSide: desiredSpot,
      openedAt: pos.openedAt,
      lastActionAt: nowMs(),
      lastApr: drift.aprPct,
    });
    return;
  }

  console.log(`  ↳ SV holding (${pos.perpSide}_PERP / ${pos.spotSide}_SPOT). APR=${fmtPct(drift.aprPct)} ENTER=${ENTER_APR}% EXIT=${EXIT_APR}%`);
}

// -------------------------------
async function main() {
  console.log(
    `FRA_PAPER=${PAPER}  ENTER=${ENTER_APR}%  EXIT=${EXIT_APR}%  Cooldown=${COOLDOWN_SEC}s  Poll=${POLL_SEC}s`
  );
  console.log(`Cross-venue: ${PERP_PERP ? `ON (venueB=${EXCH_B})` : 'OFF'}`);

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

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
