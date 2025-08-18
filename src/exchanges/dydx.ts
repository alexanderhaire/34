// ESM module
// Free & decentralized data source for funding: dYdX v4 Indexer (no API key).
// Docs: https://docs.dydx.exchange/api_integration-indexer/indexer_api  (see “Get Historical Funding”)

export type DydxFunding = {
    venue: 'dydx';
    // dYdX tickers like "SOL-USD", "ETH-USD"
    market: string;
    // hourly funding, percent (e.g., 0.12 means +0.12% / hour)
    hourlyPct: number;
    // simple annualized APR (hourly * 24 * 365), percent
    aprPct: number;
    // raw payload details
    raw: {
      ticker: string;
      // funding rate as a decimal (e.g., 0.001 = 0.1% per hour)
      rate: number;
      price?: number | null;
      effectiveAt?: string;
      effectiveAtHeight?: number;
    };
  };
  
  /**
   * Map our internal perp symbol (e.g., "SOL-PERP") to dYdX’s ticker (e.g., "SOL-USD").
   * Adjust or extend this mapping as you add more markets.
   */
  function toDydxTicker(perpSymbol: string): string {
    const upper = perpSymbol.toUpperCase();
    if (upper.endsWith('-PERP')) {
      const base = upper.replace('-PERP', '');
      return `${base}-USD`;
    }
    // already a dYdX ticker? pass through
    if (/-USD$/.test(upper)) return upper;
    throw new Error(`Unsupported market symbol for dYdX: ${perpSymbol}`);
  }
  
  const INDEXER_BASE =
    (process.env.DYDX_INDEXER_BASE?.replace(/\/$/, '') ||
      'https://indexer.dydx.trade/v4') as string;
  
  /**
   * Fetch the most recent hourly funding rate for a given perp market from dYdX.
   * Returns hourly % and APR % (simple annualization).
   *
   * Example:
   *   const fr = await getDydxFunding('SOL-PERP');
   *   // fr.hourlyPct ~ 0.12 means +0.12% per hour; fr.aprPct ~ 0.12 * 24 * 365
   */
  export async function getDydxFunding(
    perpMarket: string
  ): Promise<DydxFunding> {
    const ticker = toDydxTicker(perpMarket);
  
    // Endpoint pattern follows other Indexer routes:
    // /perpetualMarkets/{ticker}/historicalFunding?limit=1
    const url = `${INDEXER_BASE}/perpetualMarkets/${encodeURIComponent(
      ticker
    )}/historicalFunding?limit=1`;
  
    const res = await fetch(url, {
      // dYdX indexer is public; no auth required
      method: 'GET',
      headers: { 'accept': 'application/json' },
    });
  
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `dYdX Indexer error ${res.status}: ${text || res.statusText}`
      );
    }
  
    const json = await res.json();
  
    // Response shape per docs: array of objects with { ticker, effective_at, price, rate, effective_at_height }
    // We'll handle a couple of possible wrappers defensively.
    const arr: any[] =
      (Array.isArray(json) && json) ||
      json?.historicalFunding ||
      json?.data ||
      [];
  
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`dYdX Indexer returned no historical funding for ${ticker}`);
    }
  
    // Most recent entry should be first for "?limit=1"
    const last = arr[0] || arr[arr.length - 1];
  
    // Rate is a decimal per hour (e.g., 0.001 = 0.1% / hr)
    const rateRaw =
      typeof last.rate === 'string' ? parseFloat(last.rate) : Number(last.rate);
  
    if (!Number.isFinite(rateRaw)) {
      throw new Error(`Bad funding rate payload for ${ticker}: ${JSON.stringify(last)}`);
    }
  
    const hourlyPct = rateRaw * 100;
    const aprPct = rateRaw * 24 * 365 * 100;
  
    return {
      venue: 'dydx',
      market: ticker,
      hourlyPct,
      aprPct,
      raw: {
        ticker: String(last.ticker ?? ticker),
        rate: rateRaw,
        price:
          last.price != null
            ? typeof last.price === 'string'
              ? parseFloat(last.price)
              : Number(last.price)
            : null,
        effectiveAt: last.effective_at || last.effectiveAt || null,
        effectiveAtHeight:
          typeof last.effective_at_height === 'number'
            ? last.effective_at_height
            : typeof last.effectiveAtHeight === 'number'
            ? last.effectiveAtHeight
            : undefined,
      },
    };
  }
  