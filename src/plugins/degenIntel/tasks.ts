// src/plugins/degenIntel/tasks.ts
import { type IAgentRuntime, type UUID, logger } from '@elizaos/core';

import Birdeye from './tasks/birdeye';
import BuySignal from './tasks/buySignal';
import SellSignal from './tasks/sellSignal';
import Twitter from './tasks/twitter';
import TwitterParser from './tasks/twitterParser';
import type { Sentiment } from './types';

/* ----------------------------- helpers ---------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until @elizaos/plugin-sql has attached the task adapter.
 * The adapter lives at runtime.adapter and exposes getTasks/createTask/etc.
 */
async function waitForTaskAdapter(
  runtime: IAgentRuntime,
  opts?: { tries?: number; delayMs?: number }
) {
  const tries = opts?.tries ?? 100;  // up to ~10s
  const delay = opts?.delayMs ?? 100;
  for (let i = 0; i < tries; i++) {
    const adapter = (runtime as any)?.adapter;
    if (adapter && typeof adapter.getTasks === 'function' && typeof adapter.createTask === 'function') {
      return;
    }
    await sleep(delay);
  }
  throw new Error('Task adapter not ready (is @elizaos/plugin-sql loaded?)');
}

/**
 * Ensure an agent row exists in the DB so task.agent_id FK passes.
 * If the adapter doesn’t expose getAgent/createAgent we just skip (best-effort).
 */
async function ensureAgentRow(runtime: IAgentRuntime): Promise<boolean> {
  const adapter: any = (runtime as any)?.adapter;
  if (!adapter) return false;

  const hasGet = typeof adapter.getAgent === 'function';
  const hasCreate = typeof adapter.createAgent === 'function';
  if (!hasGet || !hasCreate) return true; // nothing we can do; proceed

  for (let i = 0; i < 3; i++) {
    try {
      const existing = await adapter.getAgent(runtime.agentId);
      if (existing) return true;

      await adapter.createAgent({
        id: runtime.agentId,
        name: runtime.character?.name ?? 'Agent',
      });
      return true;
    } catch (err) {
      logger.warn(`[intel] ensureAgentRow attempt ${i + 1} failed; retrying...`, err);
      await sleep(500 * (i + 1));
    }
  }
  return false;
}

/**
 * Create a task with retries and FK guard.
 * If we hit the 23503 agent FK error, we’ll try to create the agent row once and retry.
 */
async function createTaskSafely(
  runtime: IAgentRuntime,
  task: {
    name: string;
    description: string;
    worldId: UUID;
    tags: string[];
    metadata?: Record<string, any>;
  }
) {
  const meta = task.metadata ?? {
    createdAt: Date.now(),
    updatedAt: Date.now(),
    updateInterval: 1000 * 60 * 5,
  };

  for (let i = 0; i < 3; i++) {
    try {
      await runtime.createTask({
        name: task.name,
        description: task.description,
        worldId: task.worldId,
        metadata: meta,
        tags: task.tags,
      });
      return; // success
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // FK error from drizzle/pg: code 23503
      const isAgentFk =
        msg.includes('23503') ||
        msg.includes('tasks_agent_id_fkey') ||
        msg.includes('is not present in table "agents"');

      if (isAgentFk) {
        logger.warn('[intel] createTask FK failed; ensuring agent row then retrying once...', e);
        const ok = await ensureAgentRow(runtime);
        if (!ok) {
          logger.error('[intel] could not ensure agent row; aborting task creation');
          return;
        }
        // fall through to next retry
      } else {
        logger.warn(`[intel] createTask attempt ${i + 1} failed; retrying...`, e);
      }
      await sleep(500 * (i + 1));
    }
  }
  logger.error(`[intel] createTask ultimately failed for ${task.name}`);
}

/* --------------------------- main registrar ------------------------------ */

/**
 * Registers tasks for the agent to perform various Intel-related actions.
 * Safe against racing DB init, missing agent row, and missing services.
 */
export const registerTasks = async (runtime: IAgentRuntime, worldId?: UUID) => {
  try {
    await waitForTaskAdapter(runtime);
  } catch (err) {
    logger.error('[intel] task adapter never became ready; skipping task registration', err);
    return;
  }

  worldId = runtime.agentId; // global scope for this agent

  // Make sure the agent exists so task.agent_id FK won’t fail
  const agentOk = await ensureAgentRow(runtime);
  if (!agentOk) {
    logger.error('[intel] Could not ensure agent row; skipping task registration');
    return;
  }

  // Clean existing intel tasks (best-effort; don’t crash if this fails)
  try {
    const old = await runtime.getTasks({ tags: ['queue', 'repeat', 'degen_intel'] });
    for (const t of old) {
      try {
        await runtime.deleteTask(t.id);
      } catch (e) {
        logger.warn(`[intel] failed to delete task ${t.id}`, e);
      }
    }
  } catch (e) {
    logger.warn('[intel] getTasks/deleteTask failed; continuing without cleanup', e);
  }

  /* ---------------------- INTEL_SYNC_WALLET (Birdeye) ---------------------- */

  runtime.registerTaskWorker({
    name: 'INTEL_SYNC_WALLET',
    validate: async () => true, // add cadence constraints if desired
    execute: async (rt) => {
      const birdeye = new Birdeye(rt);
      try {
        await birdeye.syncWallet();
      } catch (err) {
        logger.error('Failed to sync wallet', err);
      }
    },
  });

  await createTaskSafely(runtime, {
    name: 'INTEL_SYNC_WALLET',
    description: 'Sync wallet from Birdeye',
    worldId,
    tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
    metadata: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateInterval: 1000 * 60 * 5, // 5 minutes
    },
  });

  /* ----------------------------- Twitter tasks ----------------------------- */

  const pluginNames = runtime.plugins.map((p) => p.name);
  const hasTwitterPlugin = pluginNames.includes('twitter');

  if (hasTwitterPlugin) {
    // Raw tweet sync
    runtime.registerTaskWorker({
      name: 'INTEL_SYNC_RAW_TWEETS',
      validate: async (rt) => {
        const twitterService = rt.getService('twitter');
        if (!twitterService) {
          logger.debug('Twitter service not available, removing INTEL_SYNC_RAW_TWEETS task');
          try {
            const tasks = await rt.getTasksByName('INTEL_SYNC_RAW_TWEETS');
            for (const t of tasks) await rt.deleteTask(t.id);
          } catch (e) {
            logger.warn('[intel] failed to prune INTEL_SYNC_RAW_TWEETS tasks', e);
          }
          return false;
        }
        return true;
      },
      execute: async (rt) => {
        try {
          const twitter = new Twitter(rt);
          await twitter.syncRawTweets();
        } catch (err) {
          logger.error('Failed to sync raw tweets', err);
        }
      },
    });

    await createTaskSafely(runtime, {
      name: 'INTEL_SYNC_RAW_TWEETS',
      description: 'Sync raw tweets from Twitter',
      worldId,
      tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 15, // 15 minutes
      },
    });

    // Tweet parsing
    runtime.registerTaskWorker({
      name: 'INTEL_PARSE_TWEETS',
      validate: async (rt) => !!rt.getService('twitter'),
      execute: async (rt) => {
        const twitterParser = new TwitterParser(rt);
        try {
          await twitterParser.parseTweets();
        } catch (err) {
          logger.error('Failed to parse tweets', err);
        }
      },
    });

    await createTaskSafely(runtime, {
      name: 'INTEL_PARSE_TWEETS',
      description: 'Parse tweets',
      worldId,
      tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 60 * 24, // 24 hours
      },
    });
  } else {
    logger.debug(
      'WARNING: Twitter plugin not found, skipping INTEL_SYNC_RAW_TWEETS and INTEL_PARSE_TWEETS'
    );
  }

  /* ------------------------- Trading signal tasks -------------------------- */

  const hasTraderService = !!runtime.getService('degen_trader');

  if (hasTraderService) {
    // BUY
    runtime.registerTaskWorker({
      name: 'INTEL_GENERATE_BUY_SIGNAL',
      validate: async (rt) => {
        const sentimentsData = (await rt.getCache<Sentiment[]>('sentiments')) || [];
        return sentimentsData.length > 0;
      },
      execute: async (rt) => {
        const signal = new BuySignal(rt);
        try {
          await signal.generateSignal();
        } catch (err) {
          logger.error('Failed to generate buy signal', err);
        }
      },
    });

    await createTaskSafely(runtime, {
      name: 'INTEL_GENERATE_BUY_SIGNAL',
      description: 'Generate a buy signal',
      worldId,
      tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 5, // 5 minutes
      },
    });

    // SELL
    runtime.registerTaskWorker({
      name: 'INTEL_GENERATE_SELL_SIGNAL',
      validate: async (rt) => {
        const sentimentsData = (await rt.getCache<Sentiment[]>('sentiments')) || [];
        return sentimentsData.length > 0;
      },
      execute: async (rt) => {
        const signal = new SellSignal(rt);
        try {
          await signal.generateSignal();
        } catch (err) {
          logger.error('Failed to generate sell signal', err);
        }
      },
    });

    await createTaskSafely(runtime, {
      name: 'INTEL_GENERATE_SELL_SIGNAL',
      description: 'Generate a sell signal',
      worldId,
      tags: ['queue', 'repeat', 'degen_intel', 'immediate'],
      metadata: {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateInterval: 1000 * 60 * 5, // 5 minutes
      },
    });
  } else {
    logger.debug('WARNING: Trader service not found, skipping INTEL_GENERATE_*_SIGNAL tasks');
  }
};
