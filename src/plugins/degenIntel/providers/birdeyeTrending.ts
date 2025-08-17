import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { logger } from '@elizaos/core';

/**
 * Provider for trending coins (using cached CoinMarketCap data).
 *
 * This provider reads the `coinmarketcap_sync` cache populated by the
 * CoinMarketCap plugin (if present) and returns a list of trending tokens.
 * No Birdeye API calls are made.
 */
export const birdeyeTrendingProvider: Provider = {
  name: 'TRENDING_CRYPTOCURRENCY',
  description: 'Trending cryptocurrencies (CoinMarketCap)',
  dynamic: true,
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ) => {
    console.log('intel:provider – get trending tokens');

    // Fetch tokens from the CoinMarketCap cache instead of BirdEye.
    // If the cache is empty, we return `false` to indicate no results.
    const tokens = (await runtime.getCache('coinmarketcap_sync')) || [];
    if (!tokens.length) {
      logger.warn('intel:provider – no trending token data found');
      return false;
    }

    // Format a readable text block and reduce tokens to essential fields.
    let latestTxt = '\nCurrent Trending list:';
    const reduceTokens = tokens.map((t: any) => {
      const obj: any = {
        name: t.name,
        rank: t.rank,
        chain: t.chain,
        priceUsd: t.price,
        symbol: t.symbol,
        address: t.address,
        volume24hUSD: t.volume24hUSD,
        price24hChangePercent: t.price24hChangePercent,
      };
      if (t.liquidity !== null) obj.liquidity = t.liquidity;
      if (t.marketcap !== 0) obj.marketcap = t.marketcap;
      return obj;
    });

    // Combine into final output.
    latestTxt += '\n' + JSON.stringify(reduceTokens) + '\n';
    const data = { tokens };
    const values = {};
    const text = latestTxt + '\n';

    return {
      data,
      values,
      text,
    };
  },
};

