// src/workers/fundingArb.ts
import { Connection, PublicKey } from '@solana/web3.js';
import { env } from '../env';
import { loadKeypair } from '../solana/wallet';
import { getHourlyFundingPctAndApr, decideSide, openPerpPositionLive } from '../exchanges/drift';
import { jupQuote, jupSwap } from '../executions/jupiter';

// SOL & USDC mints for Jupiter hedges
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function cycle() {
  const kp = loadKeypair(env.SOLANA_PRIVATE_KEY);

  const markets = env.FRA_MARKETS.split(',').map(s => s.trim()).filter(Boolean);
  for (const market of markets) {
    try {
      const { hourlyPct, aprPct } = await getHourlyFundingPctAndApr(market);
      console.log(`[${market}] hourly=${hourlyPct.toFixed(5)}%  apr≈${aprPct.toFixed(2)}%`);

      if (Math.abs(aprPct) < env.FRA_MIN_APR) continue;

      const side = decideSide(hourlyPct); // longs paid when hourly < 0
      console.log(`  → threshold hit. Side=${side}`);

      // Example: $500 notional per market (tune later)
      const notionUSDC = 500;

      // Hedge spot leg with Jupiter (simulate by default)
      // For SOL-PERP we hedge in SOL; for others you can map mint addresses similarly.
      if (market === 'SOL-PERP') {
        // If longs are paid, short spot: swap SOL→USDC (sell SOL)
        // If shorts are paid, long spot: swap USDC→SOL (buy SOL)
        if (side === 'LONG_PERP_SHORT_SPOT') {
          // Sell SOL worth ~$notionUSDC
          // Convert $ to lamports; use price from a live quote estimate (kept simple here)
          const approxPrice = 200; // fallback; replace with oracle if desired
          const solAmt = Math.max(0.001, notionUSDC / approxPrice);
          const lamports = Math.floor(solAmt * 1e9).toString();
          const quote = await jupQuote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: lamports });
          console.log(`    [PAPER=${env.FRA_PAPER}] Jupiter SOL→USDC out=${quote.outAmount}`);
          await jupSwap({ keypair: kp, quoteResponse: quote });
        } else {
          // Buy SOL with USDC
          const usdcAtoms = (notionUSDC * 1_000_000).toString();
          const quote = await jupQuote({ inputMint: USDC_MINT, outputMint: SOL_MINT, amount: usdcAtoms });
          console.log(`    [PAPER=${env.FRA_PAPER}] Jupiter USDC→SOL out=${quote.outAmount}`);
          await jupSwap({ keypair: kp, quoteResponse: quote });
        }
      }

      // Perp leg on Drift (simulate by default)
      await openPerpPositionLive({
        keypair: kp,
        marketName: market,
        quoteSizeUSDC: notionUSDC,
        side: side === 'LONG_PERP_SHORT_SPOT' ? 'long' : 'short',
      });
    } catch (e) {
      console.error(`[${market}] cycle error`, e);
    }
  }
}

async function main() {
  console.log(`FRA_PAPER=${env.FRA_PAPER}  FRA_MIN_APR=${env.FRA_MIN_APR}%  Poll=${env.FRA_POLL_SECONDS}s`);
  await cycle();
  setInterval(cycle, env.FRA_POLL_SECONDS * 1000);
}

main().catch(err => {
  console.error('Fatal', err);
  process.exit(1);
});
