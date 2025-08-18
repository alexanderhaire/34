// src/plugins/fundingArb/actions/status.ts
import type { Action, IAgentRuntime, Memory } from '@elizaos/core';
import { FundingArbService } from '../service';

export const statusFundingArbAction: Action = {
  name: 'FUNDING_ARB_STATUS',
  description: 'Show current state and latest funding snapshots.',
  examples: [
    [{ user: 'user', content: { text: 'funding arb status' } }],
    [{ user: 'user', content: { text: 'what is the funding carry status?' } }]
  ],
  validate: async (_rt: IAgentRuntime, msg: Memory) => {
    const t = msg?.content?.text?.toLowerCase() ?? '';
    return /status|state|running|health/.test(t) && /(funding|fund|arb)/.test(t);
  },
  handler: async (runtime: IAgentRuntime) => {
    const svc = runtime.getService?.('funding-arb') as FundingArbService | undefined;
    if (!svc) return { success: false, text: 'FundingArbService not available.' };
    const st = svc.getStatus();
    const lines = [
      `Mode: ${st.mode} | Running: ${st.running ? 'yes' : 'no'}`,
      `Threshold: ${st.thresholdApr}% APR`,
      `Started: ${st.startedAt ?? '—'}`,
      `Last run: ${st.lastRunAt ?? '—'}`,
      st.markets.length
        ? 'Markets:\n' + st.markets.map(m => `• ${m.market}: hr=${m.hourlyPct.toFixed(5)}% apr≈${m.aprPct.toFixed(2)}%`).join('\n')
        : 'No market snapshots yet.'
    ];
    return { success: true, text: lines.join('\n') };
  }
};
