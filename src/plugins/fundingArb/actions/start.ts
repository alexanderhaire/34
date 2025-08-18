// src/plugins/fundingArb/actions/start.ts
import type { Action, IAgentRuntime, Memory } from '@elizaos/core';
import { FundingArbService } from '../service';

export const startFundingArbAction: Action = {
  name: 'FUNDING_ARB_START',
  description: 'Start the Solana funding-rate arbitrage loop.',
  examples: [
    [{ user: 'user', content: { text: 'start funding arb' } }],
    [{ user: 'user', content: { text: 'enable funding rate arbitrage' } }],
    [{ user: 'user', content: { text: 'run the drift carry strategy' } }]
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const t = message?.content?.text?.toLowerCase() ?? '';
    return /(^|\b)(start|enable|run)\b.*(funding|fund|arb)/.test(t);
  },
  handler: async (runtime: IAgentRuntime) => {
    const svc = runtime.getService?.('funding-arb') as FundingArbService | undefined;
    if (!svc) {
      return { success: false, text: 'FundingArbService not available. Is the plugin loaded?' };
    }
    await svc.begin();
    const st = svc.getStatus();
    return {
      success: true,
      text: `Funding‑arb loop started in ${st.mode} mode with threshold ${st.thresholdApr}% APR.`
    };
  }
};
