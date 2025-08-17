// src/executions/jupiter.ts
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { env } from '../env';

const JUP = 'https://quote-api.jup.ag/v6'; // :contentReference[oaicite:11]{index=11}

/** Quote a swap (ExactIn) via Jupiter. Returns the raw quote JSON. */
export async function jupQuote(params: {
  inputMint: string;   // e.g., SOL mint = So11111111111111111111111111111111111111112
  outputMint: string;  // e.g., USDC = EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  amount: string;      // integer (in smallest units)
  slippageBps?: number;
}) {
  const u = new URL(`${JUP}/quote`);
  Object.entries({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps ?? 50),
    onlyDirectRoutes: 'false',
  }).forEach(([k, v]) => u.searchParams.set(k, v as string));

  const res = await fetch(u.toString(), {
    headers: env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {},
  });
  if (!res.ok) throw new Error(`Jupiter quote error ${res.status}`);
  return res.json();
}

/** Build & execute a Jupiter swap transaction from a prior quote. */
export async function jupSwap(opts: {
  keypair: Keypair;
  quoteResponse: any;
}) {
  const connection = new Connection(env.SOLANA_RPC_URL, 'confirmed');
  const body = {
    quoteResponse: opts.quoteResponse,
    userPublicKey: opts.keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    useSharedAccounts: true
  };

  const res = await fetch(`${JUP}/swap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jupiter swap build error ${res.status}`);

  const { swapTransaction } = await res.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));

  if (String(process.env.FRA_PAPER).toLowerCase() === 'true') {
    console.log('[PAPER] Built Jupiter swap (not signing/sending)');
    return;
  }

  tx.sign([opts.keypair]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true });
  console.log(`[LIVE] Jupiter swap sent: ${sig}`);
}
