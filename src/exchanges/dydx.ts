// src/exchanges/dydx.ts
// dYdX v4 Indexer adapter: fetch latest funding, normalize to hourly% + APR%.
// Works under Bun/Node with global fetch.
//
// Reads:
//   FRA_DYDX_INDEXER_BASE   (default: https://indexer.dydx.trade)
//   FRA_DYDX_SYMBOL_<BASE>  (optional overrides per asset, e.g. FRA_DYDX_SYMBOL_SOL=SOL-USD)

export type DydxFunding = {
    venue: 'dydx';
    market: string;     // your local name (e.g. "SOL-PERP")
    hourlyPct: number;  // percent (e.g. 0.0123 => 0.0123% per hour)
    aprPct: number;     // percent per year (hourly * 24 * 365)
    ts: number;
    raw?: unknown;      // raw payload for debugging
  };
  
  // Prefer base host without trailing /v4; we add /v4 in paths below.
  const BASE = (process.env.FRA_DYDX_INDEXER_BASE || 'https://indexer.dydx.trade').replace(/\/+$/, '');
  
  // Map "SOL-PERP" -> "SOL-USD" (override per-asset via FRA_DYDX_SYMBOL_<BASE>)
  function toDydxTicker(perpSymbol: string): string {
    const upper = perpSymbol.toUpperCase();
    if (/-PERP$/.test(upper)) {
      const base = upper.replace(/-PERP$/, '');
      const override = process.env[`FRA_DYDX_SYMBOL_${base}`];
      return (override && override.trim()) || `${base}-USD`;
    }
    if (/-USD$/.test(upper)) return upper; // already a dYdX ticker
    throw new Error(`Unsupported dYdX market symbol: ${perpSymbol}`);
  }
  
  // Try a few REST shapes to be resilient across deployments.
  async function fetchHistoricalFundingOnce(ticker: string) {
    const urls = [
      `${BASE}/v4/historicalFunding/${encodeURIComponent(ticker)}?limit=1`,
      `${BASE}/v4/perpetualMarkets/${encodeURIComponent(ticker)}/historicalFunding?limit=1`,
      `${BASE}/v4/markets/${encodeURIComponent(ticker)}/historicalFunding?limit=1`,
    ];
  
    let lastErr: any;
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } });
        if (!r.ok) throw new Error(`Indexer error ${r.status}: ${await r.text().catch(()=>'')}`);
        const json = await r.json();
        // Handle shapes: list, {historicalFunding: [...]}, or {data: [...]}
        const arr: any[] =
          (Array.isArray(json) && json) ||
          json?.historicalFunding ||
          json?.data ||
          [];
        if (Array.isArray(arr) && arr.length > 0) return { url, arr, json };
        lastErr = new Error(`Unexpected response shape at ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('dYdX Indexer: no usable historical funding endpoint found');
  }
  
  // As a fallback, pull market details and try to infer a funding-rate field
  async function fetchMarketFundingFallback(ticker: string) {
    const urls = [
      `${BASE}/v4/markets?market=${encodeURIComponent(ticker)}`,
      `${BASE}/v4/perpetualMarkets/${encodeURIComponent(ticker)}`,
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } });
        if (!r.ok) continue;
        const j = await r.json();
        const m =
          j?.markets?.[ticker] ??
          j?.market ??
          j?.perpetualMarket ??
          j?.[ticker];
        if (!m) continue;
  
        // Common keys; convert fraction→percent where appropriate
        const candidates: Array<[unknown, string]> = [
          [m.nextFundingRate, 'nextFundingRate'],
          [m.currentFundingRate, 'currentFundingRate'],
          [m.fundingRate, 'fundingRate'],
          [m.fundingRateHourly, 'fundingRateHourly'],
          [m.funding_1h, 'funding_1h'],
          [m.fundingRate8H, 'fundingRate8H'], // 8h fraction → hourly
          [m.funding_8h, 'funding_8h'],
        ];
        for (const [raw, key] of candidates) {
          if (raw == null) continue;
          const num = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
          if (!Number.isFinite(num)) continue;
  
          // If key mentions 8h, assume FRACTION per 8h → convert to hourly fraction then percent
          // Else if small magnitude, assume fraction per hour → percent
          // Else assume already a percent value
          const hourlyPct =
            /8h/i.test(key) ? (num / 8) * 100 :
            Math.abs(num) < 0.05 ? num * 100 : num;
  
          return { hourlyPct, json: j, url };
        }
      } catch {
        // try next
      }
    }
    return null;
  }
  
  /**
   * getDydxFunding("SOL-PERP")
   * - Maps to "SOL-USD"
   * - Pulls most recent funding rate, returns hourly% and apr%
   */
  export async function getDydxFunding(perpMarket: string): Promise<DydxFunding> {
    const ticker = toDydxTicker(perpMarket);
  
    // 1) Preferred: historicalFunding (top-level or nested)
    try {
      const { arr, json, url } = await fetchHistoricalFundingOnce(ticker);
      const last = arr[0] ?? arr[arr.length - 1];
      const rateRaw = typeof last.rate === 'string' ? parseFloat(last.rate) : Number(last.rate);
      if (!Number.isFinite(rateRaw)) throw new Error(`Bad funding rate payload at ${url}`);
  
      // Rates are typically FRACTIONS per hour (e.g., 0.001 = 0.1%/hr)
      const hourlyPct = rateRaw * 100;
      const aprPct = hourlyPct * 24 * 365;
      return { venue: 'dydx', market: perpMarket, hourlyPct, aprPct, ts: Date.now(), raw: { url, last, json } };
    } catch (e) {
      // 2) Fallback: infer from market details if present
      const fb = await fetchMarketFundingFallback(ticker);
      if (fb) {
        const aprPct = fb.hourlyPct * 24 * 365;
        return { venue: 'dydx', market: perpMarket, hourlyPct: fb.hourlyPct, aprPct, ts: Date.now(), raw: { from: fb.url } };
      }
      throw e;
    }
  }
  