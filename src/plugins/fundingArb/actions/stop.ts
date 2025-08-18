// src/plugins/fundingArb/actions/stop.ts
import type { Action, IAgentRuntime, Memory } from '@elizaos/core';
import { FundingArbService } from '../service';

export const stopFundingArbAction: Action = {
  name: 'FUNDING_ARB_STOP',
  description: 'Stop the funding-rate arbitrage loop.',
  examples: [
    [{ user: 'user', content: { text: 'stop funding arb' } }],
    [{ user: 'user', content: { text: 'disable funding carry' } }]
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const t = message?.content?.text?.toLowerCase() ?? '';
    return /(^|\b)(stop|disable|halt)\b.*(funding|fund|arb)/.test(t);
  },
  handler: async (runtime: IAgentRuntime) => {
    const svc = runtime.getService?.('funding-arb') as FundingArbService | undefined;
    if (!svc) return { success: false, text: 'FundingArbService not available.' };
    await svc.stop();
    return { success: true, text: 'Funding‑arb loop stopped.' };
  }
};
