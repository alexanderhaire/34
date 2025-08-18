// src/executions/jupiter.ts
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'node:buffer';
import { env } from '../env';

const JUP = 'https://quote-api.jup.ag/v6';

export interface QuoteParams {
  inputMint: string;    // e.g., SOL mint = So11111111111111111111111111111111111111112
  outputMint: string;   // e.g., USDC = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  amount: string;       // integer in smallest units (lamports / atoms)
  slippageBps?: number; // default 50 = 0.50%
  onlyDirectRoutes?: boolean;
}

/** Get a swap quote (ExactIn) from Jupiter. */
export async function jupQuote(params: QuoteParams): Promise<any> {
  const u = new URL(`${JUP}/quote`);
  const search = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps ?? 50),
    onlyDirectRoutes: String(params.onlyDirectRoutes ?? false),
  } as const;

  Object.entries(search).forEach(([k, v]) => u.searchParams.set(k, v));

  const res = await fetch(u.toString(), {
    headers: env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {},
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jupiter quote error ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }

  return res.json();
}

export interface SwapOpts {
  keypair: Keypair;
  quoteResponse: any; // structured object returned by /quote
}

/** Build & (if live) execute a Jupiter swap transaction based on a prior quote. */
export async function jupSwap(opts: SwapOpts): Promise<string | void> {
  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed');

  const body = {
    quoteResponse: opts.quoteResponse,
    userPublicKey: opts.keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    useSharedAccounts: true,
    // You may add computeUnitPriceMicroLamports here if you want priority fees
  };

  const res = await fetch(`${JUP}/swap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Jupiter swap build error ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  const { swapTransaction } = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

  // ✅ Make paper-mode consistent across the codebase
  if (String(env.FRA_PAPER).toLowerCase() === 'true') {
    console.log('[PAPER] Built Jupiter swap (not signing/sending)');
    return;
  }

  tx.sign([opts.keypair]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true });
  console.log(`[LIVE] Jupiter swap sent: ${sig}`);
  return sig;
}
