// src/plugins/fundingArb/index.ts
import type { Plugin } from '@elizaos/core';
import { FundingArbService } from './service';
import { startFundingArbAction } from './actions/start';
import { stopFundingArbAction } from './actions/stop';
import { statusFundingArbAction } from './actions/status';

/**
 * Eliza Plugin: Funding Rate Arbitrage controls for Spartan.
 * Registers a background service and exposes start/stop/status actions.
 *
 * Follows the Eliza plugin schema: export { name, actions, providers?, services?, schema? }.
 * Docs: Plugin Schema Guide. 
 */
export const fundingArbPlugin: Plugin = {
  name: 'funding-arb',
  description: 'Control a Drift+Jupiter funding-rate arbitrage loop from chat.',
  actions: [startFundingArbAction, stopFundingArbAction, statusFundingArbAction],
  services: [FundingArbService]
};
