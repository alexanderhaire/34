import { Service, logger } from '@elizaos/core';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DriftClient, PositionDirection, Wallet } from '@drift-labs/sdk';

export class FundingArbitrageService extends Service {
  static serviceType = 'FUNDING_ARBITRAGE';

  private drift: DriftClient | null = null;

  async start(): Promise<void> {
    const rpc = this.runtime.getSetting('SOLANA_RPC_URL');
    const privKeyStr = this.runtime.getSetting('SOLANA_PRIVATE_KEY');
    const keypair = Keypair.fromSecretKey(
      Buffer.from(privKeyStr, 'base58')
    );
    const wallet = new Wallet(keypair);

    // Connect to Drift
    const connection = new Connection(rpc);
    this.drift = new DriftClient({
      connection,
      wallet,
      env: 'mainnet-beta'
    });
    await this.drift.subscribe();

    // Run check every minute
    const interval = this.runtime.getSetting('checkIntervalSeconds') || 60;
    setInterval(() => this.checkFunding(), interval * 1000);
  }

  async checkFunding(): Promise<void> {
    if (!this.drift) return;
    // Example: check SOL-PERP (market index 0)
    const marketIndex = 0;
    const market = this.drift.getPerpMarketAccount(marketIndex);
    const funding = market.amm.cumulativeFundingRateLong.sub(
      market.amm.cumulativeFundingRateShort
    );
    // Basic filter: only act if funding > threshold
    const fundingBps = funding.toNumber() / 1e4;
    const minProfit = this.runtime.getSetting('minProfitThreshold') || 0;
    if (fundingBps > minProfit) {
      // Determine a notional size based on maxPositionNotional
      const notional = Math.min(
        this.runtime.getSetting('maxPositionNotional') || 10000,
        1000 // start with small test size
      );
      // Open a short on Drift
      await this.drift.openPosition(
        PositionDirection.SHORT,
        notional * 1e6, // convert to base units
        marketIndex
      );
      // Hedge via plugin-solana swap
      await this.runtime.executeAction('EXECUTE_SWAP', {
        inputTokenSymbol: 'USDC',
        outputTokenSymbol: 'SOL',
        amount: notional / (await this.drift.getOraclePrice(marketIndex)) // buy equivalent spot
      });
      logger.info('Opened funding arb position', { fundingBps });
    }
  }
}
