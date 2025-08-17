// src/solana/wallet.ts
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

export function loadKeypair(secret: string): Keypair {
  // Base58?
  try {
    const raw = bs58.decode(secret);
    if (raw.length === 64) return Keypair.fromSecretKey(raw);
  } catch (_) { /* fall through */ }

  // JSON array?
  try {
    const arr = JSON.parse(secret);
    if (Array.isArray(arr)) {
      const bytes = Uint8Array.from(arr);
      return Keypair.fromSecretKey(bytes);
    }
  } catch (_) { /* ignore */ }

  throw new Error('SOLANA_PRIVATE_KEY is neither base58 nor JSON array');
}
