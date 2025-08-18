#!/usr/bin/env bun
/**
 * backtestFundingArb.ts - Spartan Funding Rate Arbitrage Backtester
 * 
 * Usage: bun run backtestFundingArb.ts [options]
 * Options can be provided via env or CLI, e.g.:
 *   FRA_MARKETS="SOL-PERP,ETH-PERP" FRA_ENTER_APR=10 FRA_EXIT_APR=6 FRA_NOTIONAL=500 bun run backtestFundingArb.ts
 */

import { getHourlyFundingPctAndApr } from '../exchanges/drift';
import { getDydxFunding } from '../exchanges/dydx';
import * as fs from 'fs';

// Configurable parameters (with defaults matching live bot where applicable)
const MARKETS = (process.env.FRA_MARKETS ?? 'SOL-PERP,ETH-PERP,BTC-PERP')
  .split(',').map(m => m.trim()).filter(Boolean);
const ENTER_APR = Number(process.env.FRA_ENTER_APR ?? process.env.FRA_MIN_APR ?? 10); // e.g. 10 (%):contentReference[oaicite:31]{index=31}
const EXIT_APR  = process.env.FRA_EXIT_APR ? Number(process.env.FRA_EXIT_APR) 
               : Math.max(0, Math.round(ENTER_APR * 0.6 * 100) / 100);             // default 60% of enter:contentReference[oaicite:32]{index=32}
const COOLDOWN_SEC = Number(process.env.FRA_COOLDOWN_SEC ?? 300);  // default 300s (5m):contentReference[oaicite:33]{index=33}
const QUOTE_NOTIONAL = Number(process.env.FRA_NOTIONAL ?? 500);    // default $500 per leg:contentReference[oaicite:34]{index=34}
const PERP_PERP = (process.env.FRA_PERP_PERP ?? 'true').toLowerCase() === 'true';  // allow cross-venue
const VENUE_B   = (process.env.FRA_EXCH_B ?? 'dydx').toLowerCase(); // second venue ('dydx' or 'mango')

// Define data structures for funding and position state
interface FundingSnapshot { venue: string; market: string; hourlyPct: number; aprPct: number; ts: number; }
interface TradeEvent { ts: number; market: string; type: 'CROSS'|'SINGLE'; action: 'ENTER'|'EXIT'|'FLIP'; 
                       driftSide?: 'LONG'|'SHORT'; venueBSide?: 'LONG'|'SHORT'; spotSide?: 'BUY'|'SELL';
                       driftApr?: number; venueBApr?: number; netApr?: number; pnl?: number; }

// Position state tracking (similar to live bot):contentReference[oaicite:35]{index=35}:contentReference[oaicite:36]{index=36}
type SinglePos = { open: boolean; perpSide: 'LONG'|'SHORT'; spotSide: 'BUY'|'SELL'; openedAt: number; lastActionAt: number; lastApr: number; };
type CrossPos  = { open: boolean; driftSide: 'LONG'|'SHORT'; venueBSide: 'LONG'|'SHORT'; openedAt: number; lastActionAt: number; lastNetApr: number; };
const singlePositions = new Map<string, SinglePos>();
const crossPositions  = new Map<string, CrossPos>();

// Helper: normalize a percentage string or number (e.g. "10%" -> 10)
function normPct(val: string|number): number {
  const s = (val ?? '').toString().trim().replace('%','');
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  throw new Error(`Bad percentage value: "${val}"`);
}

// Strategy decision helpers (from fundingArb.ts)
function decideReceivePerpSide(hourlyPct: number): 'LONG'|'SHORT' {
  // If funding > 0, shorts receive; if funding < 0, longs receive:contentReference[oaicite:37]{index=37}
  return hourlyPct >= 0 ? 'SHORT' : 'LONG';
}
function spotSideForPerp(perpSide: 'LONG'|'SHORT'): 'BUY'|'SELL' {
  // If perp is SHORT, we went short perp & long spot (so we BUY base); if perp LONG, we SELL base:contentReference[oaicite:38]{index=38}
  return perpSide === 'SHORT' ? 'BUY' : 'SELL';
}

/** 
 * Compute cross-venue net APR and optimal sides, mirroring live logic:contentReference[oaicite:39]{index=39}:contentReference[oaicite:40]{index=40}.
 * Returns net APR (%) and which side to take on each venue to receive funding.
 */
function crossDecision(driftHourly: number, driftApr: number, venueBHourly: number, venueBApr: number) {
  const EPS = 1e-6;
  const sgn = (x: number) => (Math.abs(x) <= EPS ? 0 : x > 0 ? 1 : -1);
  const sA = sgn(driftHourly);
  const sB = sgn(venueBHourly);
  const absA = Math.abs(driftApr);
  const absB = Math.abs(venueBApr);
  let netApr: number;
  let driftSide: 'LONG'|'SHORT';
  let venueBSide: 'LONG'|'SHORT';
  let reason: string;
  if (sA !== 0 && sB !== 0 && sA !== sB) {
    // Opposite signs: receive on both:contentReference[oaicite:41]{index=41}
    netApr = absA + absB;
    driftSide = decideReceivePerpSide(driftHourly);
    venueBSide = decideReceivePerpSide(venueBHourly);
    reason = 'opposite signs → receive both';
  } else if ((sA === 0) !== (sB === 0)) {
    // One side ~0: treat as single receive (take the non-zero side):contentReference[oaicite:42]{index=42}
    driftSide = decideReceivePerpSide(driftHourly);
    venueBSide = decideReceivePerpSide(venueBHourly);
    netApr = Math.max(absA, absB);
    reason = 'one side ~0 → receive single';
  } else {
    // Same sign (or both ~0): receive larger, pay smaller:contentReference[oaicite:43]{index=43}
    const driftPays = absA >= absB;  // drift has larger magnitude if true
    if (driftPays) {
      driftSide = driftHourly >= 0 ? 'SHORT' : 'LONG';    // take larger: Drift
      venueBSide = driftHourly >= 0 ? 'LONG'  : 'SHORT';  // take opposite on venueB
    } else {
      driftSide = driftHourly >= 0 ? 'LONG'  : 'SHORT';   // take opposite on Drift
      venueBSide = driftHourly >= 0 ? 'SHORT' : 'LONG';   // take larger: VenueB
    }
    // net APR is difference between larger and smaller APRs
    netApr = Math.abs(absA - absB);
    reason = 'same sign → receive larger, pay smaller';
  }
  return { netApr, driftSide, venueBSide, reason };
}

// Containers for collected historical funding data
type FundingSeries = { drift: FundingSnapshot[]; dydx: FundingSnapshot[]; };
const historyData = new Map<string, FundingSeries>();  // market -> series data

/**
 * Fetch historical hourly funding data for all configured markets.
 * This could use Drift's data API (e.g., fundingRates endpoint or S3 files) and dYdX's indexer API.
 */
async function collectHistoricalData(startTime: number, endTime: number) {
  // For simplicity, assume startTime and endTime are UNIX timestamps (ms) bounding the period of interest.
  // We'll fetch data by looping hour-by-hour or using bulk endpoints if available.
  for (const market of MARKETS) {
    const driftSeries: FundingSnapshot[] = [];
    const dydxSeries: FundingSnapshot[] = [];
    let currentTime = startTime;
    while (currentTime <= endTime) {
      // Fetch Drift funding for this hour (could batch by day in a real implementation)
      try {
        const driftFunding = await getHourlyFundingPctAndApr(market);
        driftSeries.push({ venue: 'drift', market, hourlyPct: driftFunding.hourlyPct, aprPct: driftFunding.aprPct, ts: currentTime });
      } catch (e) {
        console.error(`Error fetching Drift funding for ${market} at ${new Date(currentTime).toISOString()}: ${e}`);
      }
      // Fetch dYdX funding for this hour (if cross-venue enabled)
      if (PERP_PERP && VENUE_B === 'dydx') {
        try {
          const dydxFunding = await getDydxFunding(market);
          dydxSeries.push({ venue: 'dydx', market, hourlyPct: dydxFunding.hourlyPct, aprPct: dydxFunding.aprPct, ts: currentTime });
        } catch (e) {
          console.warn(`Warning: dYdX funding fetch failed for ${market} at ${new Date(currentTime).toISOString()}: ${e}`);
        }
      }
      // Increment time by one hour
      currentTime += 3600_000;
    }
    historyData.set(market, { drift: driftSeries, dydx: dydxSeries });
    console.log(`Collected ${driftSeries.length} Drift and ${dydxSeries.length} dYdX data points for ${market}.`);
  }
}

/**
 * Run the backtest simulation over the collected data.
 * Populates tradeEvents array with all trade entries, exits, and flips.
 */
function runSimulation(): { tradeEvents: TradeEvent[]; pnlSeries: { ts: number, pnl: number }[]; } {
  const tradeEvents: TradeEvent[] = [];
  let cumulativePnl = 0;
  const pnlSeries: { ts: number, pnl: number }[] = [];

  for (const market of MARKETS) {
    const series = historyData.get(market);
    if (!series) continue;
    const { drift: driftData, dydx: dydxData } = series;
    // Ensure both series are sorted by timestamp
    driftData.sort((a,b)=> a.ts - b.ts);
    dydxData.sort((a,b)=> a.ts - b.ts);
    // Pointers for dYdX data (if any)
    let j = 0;
    for (let i = 0; i < driftData.length; i++) {
      const snap = driftData[i];
      const ts = snap.ts;
      // If dYdX data exists, advance index to match timestamps (assuming near alignment)
      while (j < dydxData.length - 1 && dydxData[j].ts < ts) j++;
      const driftHourly = snap.hourlyPct;
      const driftApr = snap.aprPct;
      const dydxHourly = (dydxData[j] && Math.abs(dydxData[j].ts - ts) < 1800_000) ? dydxData[j].hourlyPct : 0;
      const dydxApr = (dydxData[j] && Math.abs(dydxData[j].ts - ts) < 1800_000) ? dydxData[j].aprPct : 0;
      
      // Prepare single and cross position references
      const pos = singlePositions.get(market);
      const crossPos = crossPositions.get(market);
      const now = ts;
      // Cooldown checks
      const coolingSV = pos && (now - (pos.lastActionAt || 0) < COOLDOWN_SEC * 1000);
      const coolingCross = crossPos && (now - (crossPos.lastActionAt || 0) < COOLDOWN_SEC * 1000);

      // Decision logic for cross-venue (if enabled)
      if (PERP_PERP && VENUE_B !== 'none') {
        // Compute cross funding decision
        const dec = crossDecision(driftHourly/100, driftApr, dydxHourly/100, dydxApr);  // driftHourly/100 to convert % to fractional for consistency
        // Note: driftApr and dydxApr are already %/year values.
        if (!crossPos || !crossPos.open) {
          if (dec.netApr >= ENTER_APR) {
            if (!coolingCross) {
              // Enter cross-venue position
              const newCross: CrossPos = { open: true, driftSide: dec.driftSide, venueBSide: dec.venueBSide, openedAt: now, lastActionAt: now, lastNetApr: dec.netApr };
              crossPositions.set(market, newCross);
              tradeEvents.push({ ts: now, market, type: 'CROSS', action: 'ENTER', driftSide: dec.driftSide, venueBSide: dec.venueBSide, 
                                 driftApr: driftApr, venueBApr: dydxApr, netApr: dec.netApr, pnl: 0 });
            } // if coolingCross, skip entry due to cooldown:contentReference[oaicite:44]{index=44}
          }
          // If not entering cross, we'll consider single-venue below
        } else {  // crossPos exists and is open
          // Recalculate optimal sides each hour (dec) and decide to close/flip/hold
          const flipNeeded = (crossPos.driftSide !== dec.driftSide || crossPos.venueBSide !== dec.venueBSide);
          const shouldClose = dec.netApr <= EXIT_APR || (flipNeeded && dec.netApr < ENTER_APR);
          const shouldFlip  = flipNeeded && dec.netApr >= ENTER_APR;
          if (shouldClose && !coolingCross) {
            // Close cross position
            crossPositions.set(market, { ...crossPos, open: false, lastActionAt: now, lastNetApr: dec.netApr });
            // Calculate PnL accumulated during this trade (funding * duration). For simplicity, we can compute from entry to now.
            const hoursHeld = (now - crossPos.openedAt) / 3600_000;
            // Approx funding earned: use avg of entry and exit netApr or just lastNetApr * hoursHeld (simplified)
            const avgApr = (crossPos.lastNetApr + dec.netApr) / 2;
            const pnlEarned = avgApr/100 * (hoursHeld/8760) * QUOTE_NOTIONAL;  // hoursHeld/8760 year fraction
            cumulativePnl += pnlEarned;
            tradeEvents.push({ ts: now, market, type: 'CROSS', action: 'EXIT', driftSide: crossPos.driftSide, venueBSide: crossPos.venueBSide,
                               driftApr: driftApr, venueBApr: dydxApr, netApr: dec.netApr, pnl: pnlEarned });
          } else if (shouldFlip && !coolingCross) {
            // Flip positions: close current and open new sides
            // Close current first
            const hoursHeld = (now - crossPos.lastActionAt) / 3600_000;
            const avgApr = (crossPos.lastNetApr + dec.netApr) / 2;
            const pnlEarned = avgApr/100 * (hoursHeld/8760) * QUOTE_NOTIONAL;
            cumulativePnl += pnlEarned;
            tradeEvents.push({ ts: now, market, type: 'CROSS', action: 'EXIT', driftSide: crossPos.driftSide, venueBSide: crossPos.venueBSide,
                               driftApr: driftApr, venueBApr: dydxApr, netApr: dec.netApr, pnl: pnlEarned });
            // Open new flipped position
            crossPositions.set(market, { open: true, driftSide: dec.driftSide, venueBSide: dec.venueBSide, openedAt: now, lastActionAt: now, lastNetApr: dec.netApr });
            tradeEvents.push({ ts: now, market, type: 'CROSS', action: 'ENTER', driftSide: dec.driftSide, venueBSide: dec.venueBSide,
                               driftApr: driftApr, venueBApr: dydxApr, netApr: dec.netApr, pnl: 0 });
          } 
          // If holding, no action (just continue accumulating funding PnL, which we'll do below)
        }
      }

      // Decision logic for single-venue (if no cross trade entered this hour)
      const crossOpen = crossPositions.get(market)?.open;
      if (!crossOpen) {
        const absApr = Math.abs(driftApr);
        const desiredPerpSide = decideReceivePerpSide(driftHourly/100);  // which perp side would receive funding
        const desiredSpotSide = spotSideForPerp(desiredPerpSide);
        if (!pos || !pos.open) {
          if (absApr >= ENTER_APR && !coolingSV) {
            // Enter single-venue position
            const newPos: SinglePos = { open: true, perpSide: desiredPerpSide, spotSide: desiredSpotSide, openedAt: now, lastActionAt: now, lastApr: driftApr };
            singlePositions.set(market, newPos);
            tradeEvents.push({ ts: now, market, type: 'SINGLE', action: 'ENTER', 
                               driftSide: desiredPerpSide, spotSide: desiredSpotSide, driftApr: driftApr, pnl: 0 });
          }
          // else: no action if below enter threshold or cooling:contentReference[oaicite:45]{index=45}
        } else if (pos.open) {
          // Manage open single-venue position
          const signalFlipped = desiredPerpSide !== pos.perpSide;
          const shouldClose = absApr <= EXIT_APR || (signalFlipped && absApr < ENTER_APR);
          const shouldFlip  = signalFlipped && absApr >= ENTER_APR;
          if (shouldClose && !coolingSV) {
            // Close single-venue position
            singlePositions.set(market, { ...pos, open: false, lastActionAt: now, lastApr: driftApr });
            // Calculate funding PnL earned during the position
            const hoursHeld = (now - pos.openedAt) / 3600_000;
            const avgApr = (Math.abs(pos.lastApr) + absApr) / 2;
            const pnlEarned = avgApr/100 * (hoursHeld/8760) * QUOTE_NOTIONAL;
            cumulativePnl += pnlEarned;
            tradeEvents.push({ ts: now, market, type: 'SINGLE', action: 'EXIT', 
                               driftSide: pos.perpSide, spotSide: pos.spotSide, driftApr: driftApr, pnl: pnlEarned });
          } else if (shouldFlip && !coolingSV) {
            // Flip single-venue position
            // Close old:
            const hoursHeld = (now - pos.lastActionAt) / 3600_000;
            const avgApr = (Math.abs(pos.lastApr) + absApr) / 2;
            const pnlEarned = avgApr/100 * (hoursHeld/8760) * QUOTE_NOTIONAL;
            cumulativePnl += pnlEarned;
            tradeEvents.push({ ts: now, market, type: 'SINGLE', action: 'EXIT', 
                               driftSide: pos.perpSide, spotSide: pos.spotSide, driftApr: driftApr, pnl: pnlEarned });
            // Open new:
            singlePositions.set(market, { open: true, perpSide: desiredPerpSide, spotSide: desiredSpotSide, openedAt: now, lastActionAt: now, lastApr: driftApr });
            tradeEvents.push({ ts: now, market, type: 'SINGLE', action: 'ENTER', 
                               driftSide: desiredPerpSide, spotSide: desiredSpotSide, driftApr: driftApr, pnl: 0 });
          }
          // else: if holding, no immediate log (PnL accrues over time until close)
          pos.lastApr = driftApr;  // update lastApr continuously for more accurate PnL calc
        }
      }

      // Accumulate continuous PnL for open positions (per hour increment)
      // This will account for funding earned each hour when holding positions.
      let hourlyPnl = 0;
      // Single-venue: if a position is open, funding PnL = driftHourly% * notional (with correct sign).
      const currentPos = singlePositions.get(market);
      if (currentPos && currentPos.open) {
        // If we are short perp (receiving positive funding) or long perp (receiving negative funding)
        const sign = currentPos.perpSide === 'SHORT' ? 1 : -1;
        hourlyPnl += (driftHourly/100) * QUOTE_NOTIONAL * sign;
      }
      // Cross-venue: if a cross position is open, funding PnL = sum from both perps.
      const currentCross = crossPositions.get(market);
      if (currentCross && currentCross.open) {
        // For cross, determine which side we have on each:
        const driftSign = currentCross.driftSide === 'SHORT' ? 1 : -1;   // short receives if funding >0, long receives if funding <0
        const venueSign = currentCross.venueBSide === 'SHORT' ? 1 : -1;
        hourlyPnl += (driftHourly/100) * QUOTE_NOTIONAL * driftSign;
        hourlyPnl += (dydxHourly/100) * QUOTE_NOTIONAL * venueSign;
      }
      if (hourlyPnl !== 0) {
        cumulativePnl += hourlyPnl;
      }
      // Record PnL time series
      pnlSeries.push({ ts: ts, pnl: cumulativePnl });
    } // end for each hour in drift series
  } // end for each market
  return { tradeEvents, pnlSeries };
}

/**
 * Generate output files: trade log (CSV), summary stats (printed), and charts (PNG).
 */
async function generateOutputs(tradeEvents: TradeEvent[], pnlSeries: {ts:number,pnl:number}[]) {
  // 1. Save trade log to CSV
  const csvLines: string[] = [];
  csvLines.push('timestamp,market,type,action,drift_side,venueB_side,spot_side,drift_APR(%),venueB_APR(%),net_APR(%),PnL');
  for (const ev of tradeEvents) {
    const timeISO = new Date(ev.ts).toISOString();
    const line = [
      timeISO,
      ev.market,
      ev.type,
      ev.action,
      ev.driftSide ?? '',
      ev.venueBSide ?? '',
      ev.spotSide ?? '',
      ev.driftApr?.toFixed(2) ?? '',
      ev.venueBApr?.toFixed(2) ?? '',
      ev.netApr?.toFixed(2) ?? '',
      ev.pnl?.toFixed(2) ?? ''
    ].join(',');
    csvLines.push(line);
  }
  fs.writeFileSync('trade_log.csv', csvLines.join('\n'), 'utf-8');
  console.log(`Saved trade log to trade_log.csv (${tradeEvents.length} events).`);

  // 2. Summary statistics
  const totalTrades = tradeEvents.filter(ev => ev.action === 'ENTER').length;
  const totalProfit = pnlSeries.length ? pnlSeries[pnlSeries.length-1].pnl : 0;
  const crossTrades = tradeEvents.filter(ev => ev.type === 'CROSS' && ev.action === 'ENTER').length;
  const singleTrades = tradeEvents.filter(ev => ev.type === 'SINGLE' && ev.action === 'ENTER').length;
  let avgApr = 0;
  const aprSamples: number[] = [];
  tradeEvents.forEach(ev => { if (ev.action==='ENTER' && ev.netApr) aprSamples.push(ev.netApr); });
  if (aprSamples.length) {
    avgApr = aprSamples.reduce((a,b)=>a+b, 0) / aprSamples.length;
  }
  console.log(`\nBacktest Summary:`);
  console.log(`- Total Profit: $${totalProfit.toFixed(2)}`);
  console.log(`- Total Trades: ${totalTrades} (Cross-Venue: ${crossTrades}, Single-Venue: ${singleTrades})`);
  if (aprSamples.length) {
    console.log(`- Average Entry Net APR: ${avgApr.toFixed(2)}%`);
  }
  // (More stats like median APR, avg duration, win rate can be added similarly)

  // 3. Generate charts using QuickChart (for simplicity)
  try {
    const QuickChart = (await import('quickchart-js')).default;
    const qc1 = new QuickChart();
    qc1.setConfig({
      type: 'line',
      data: {
        labels: pnlSeries.map(pt => new Date(pt.ts).toISOString().slice(0,19).replace('T',' ')),
        datasets: [{ label: 'Cumulative PnL (USD)', data: pnlSeries.map(pt => pt.pnl), fill: false, borderColor: 'teal' }]
      },
      options: { title: { display: true, text: 'Cumulative PnL Over Time' }, scales: { xAxes: [{ display: false }] } }
    });
    qc1.setWidth(800).setHeight(400).setBackgroundColor('white');
    await qc1.toFile('cumulative_pnl.png');
    console.log(`Saved PnL chart to cumulative_pnl.png`);

    const qc2 = new QuickChart();
    // Prepare funding spread data (e.g. Drift APR minus dYdX APR for cross, or Drift APR for single)
    const spreadSeries: { ts: number, spread: number }[] = [];
    historyData.forEach((series, market) => {
      series.drift.forEach((d, idx) => {
        const t = d.ts;
        let spread = d.aprPct;
        if (PERP_PERP && VENUE_B === 'dydx' && series.dydx[idx]) {
          spread = d.aprPct - series.dydx[idx].aprPct;
        }
        spreadSeries.push({ ts: t, spread });
      });
    });
    spreadSeries.sort((a,b)=> a.ts - b.ts);
    qc2.setConfig({
      type: 'line',
      data: {
        labels: spreadSeries.map(pt => new Date(pt.ts).toISOString().slice(0,19).replace('T',' ')),
        datasets: [
          { label: (PERP_PERP ? 'Drift APR - dYdX APR' : 'Drift APR'), data: spreadSeries.map(pt => pt.spread), fill: false, borderColor: 'orange' },
          { label: `Enter APR (${ENTER_APR}%)`, data: spreadSeries.map(() => ENTER_APR), borderDash: [5,5], borderColor: 'green', fill: false },
          { label: `Exit APR (${EXIT_APR}%)`, data: spreadSeries.map(() => EXIT_APR), borderDash: [5,5], borderColor: 'red', fill: false }
        ]
      },
      options: { title: { display: true, text: 'Funding Rate Spread & Thresholds' }, scales: { xAxes: [{ display: false }] } }
    });
    qc2.setWidth(800).setHeight(400).setBackgroundColor('white');
    await qc2.toFile('funding_spread.png');
    console.log(`Saved funding spread chart to funding_spread.png`);
  } catch (err) {
    console.error(`Chart generation failed: ${err}`);
    console.log(`(Ensure 'quickchart-js' is installed or skip chart generation.)`);
  }
}

// Main execution sequence
(async function main() {
  console.log(`Starting backtest for markets: ${MARKETS.join(', ')} | ENTER_APR=${ENTER_APR}% EXIT_APR=${EXIT_APR}% Cooldown=${COOLDOWN_SEC}s`);
  console.log(`Cross-venue mode: ${PERP_PERP && VENUE_B!=='none' ? 'ENABLED (venueB='+VENUE_B.toUpperCase()+')' : 'DISABLED'}`);
  // Define backtest period (e.g., last 30 days by default)
  const endTime = Date.now();
  const startTime = endTime - 30 * 24 * 3600_000;  // 30 days ago
  await collectHistoricalData(startTime, endTime);
  const { tradeEvents, pnlSeries } = runSimulation();
  await generateOutputs(tradeEvents, pnlSeries);
  console.log(`Backtest complete. Total PnL: $${(pnlSeries[pnlSeries.length-1]?.pnl ?? 0).toFixed(2)}`);
})();
