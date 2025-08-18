// src/init.ts
import {
  type Action,
  ChannelType,
  type Evaluator,
  type IAgentRuntime,
  type OnboardingConfig,
  type Provider,
  type UUID,
  type World,
  createUniqueUuid,
  initializeOnboarding,
  logger,
} from "@elizaos/core";

/**
 * Minimal Guild shape so we don't depend on discord.js types in public dts.
 * We only use the fields below in this module.
 */
export interface MinimalGuild {
  id: string;
  name: string;
  ownerId: string;
  members: {
    fetch: (id: string) => Promise<{
      id: string;
      user: { username: string };
      send: (msg: string) => Promise<any>;
    }>;
  };
}

/**
 * Initializes the character with the provided runtime, configuration, actions, providers, and evaluators.
 * Registers actions, providers, and evaluators to the runtime. Registers runtime events for Discord and Telegram.
 */
export async function initCharacter({
  runtime,
  config,
  actions,
  providers,
  evaluators,
}: {
  runtime: IAgentRuntime;
  config: OnboardingConfig;
  actions?: Action[];
  providers?: Provider[];
  evaluators?: Evaluator[];
}): Promise<void> {
  if (actions) for (const a of actions) runtime.registerAction(a);
  if (providers) for (const p of providers) runtime.registerProvider(p);
  if (evaluators) for (const e of evaluators) runtime.registerEvaluator(e);

  // Discord: when we join a server
  runtime.registerEvent(
    "DISCORD_WORLD_JOINED",
    async (params: { server: MinimalGuild }) => {
      await initializeAllSystems(runtime, [params.server], config);
    }
  );

  // Discord: when we reconnect to an existing server
  runtime.registerEvent(
    "DISCORD_SERVER_CONNECTED",
    async (params: { server: MinimalGuild }) => {
      await initializeAllSystems(runtime, [params.server], config);
    }
  );

  // Telegram: when we join a chat/group
  runtime.registerEvent(
    "TELEGRAM_WORLD_JOINED",
    async (params: {
      world: World;
      entities: any[];
      chat: any;
      botUsername: string;
    }) => {
      await initializeOnboarding(runtime, params.world, config);
      await startTelegramOnboarding(
        runtime,
        params.world,
        params.chat,
        params.entities,
        params.botUsername
      );
    }
  );
}

/**
 * Initializes all systems for the given servers with the provided runtime, servers, and onboarding configuration.
 */
export async function initializeAllSystems(
  runtime: IAgentRuntime,
  servers: MinimalGuild[],
  config: OnboardingConfig
): Promise<void> {
  // small delay to allow adapters to come online
  await new Promise((r) => setTimeout(r, 2000));

  try {
    for (const server of servers) {
      const worldId = createUniqueUuid(runtime, server.id);
      const ownerId = createUniqueUuid(runtime, server.ownerId);

      const existingWorld = await runtime.getWorld(worldId);
      if (!existingWorld) {
        logger.debug("Onboarding not initialized for server", server.id);
        continue;
      }
      if (existingWorld?.metadata?.settings) {
        logger.debug("Onboarding already initialized for server", server.id);
        continue;
      }

      const world: World = {
        id: worldId,
        name: server.name,
        serverId: server.id,
        agentId: runtime.agentId,
        metadata: {
          roles: { [ownerId]: 0 /* Role.OWNER enum value */ },
          ownership: { ownerId },
        },
      };

      await runtime.ensureWorldExists(world);
      // Optionally kick off onboarding DM here if desired
      logger.info("World ensured:", world.id, world.name);
    }
  } catch (error) {
    logger.error("Error initializing systems:", error);
    throw error;
  }
}

/**
 * Starts the settings DM with the server owner (Discord)
 */
export async function startOnboardingDM(
  runtime: IAgentRuntime,
  guild: MinimalGuild,
  worldId: UUID
): Promise<void> {
  logger.info("startOnboardingDM - worldId", worldId);
  try {
    const owner = await guild.members.fetch(guild.ownerId);
    if (!owner) {
      logger.error(`Could not fetch owner with ID ${guild.ownerId} for server ${guild.id}`);
      throw new Error(`Could not fetch owner with ID ${guild.ownerId}`);
    }

    const onboardingMessages = [
      "Hi! I need to collect some information to get set up. Is now a good time?",
      "Hey there! I need to configure a few things. Do you have a moment?",
      "Hello! Could we take a few minutes to get everything set up?",
    ];
    const text = onboardingMessages[Math.floor(Math.random() * onboardingMessages.length)];
    const msg = await owner.send(text);
    const roomId = createUniqueUuid(runtime, msg.channel.id);

    await runtime.ensureRoomExists({
      id: roomId,
      name: `Chat with ${owner.user.username}`,
      source: "discord",
      type: ChannelType.DM,
      channelId: msg.channelId,
      serverId: guild.id,
      worldId,
    });

    const entity = await runtime.getEntityById(runtime.agentId);
    if (!entity) {
      await runtime.createEntity({
        id: runtime.agentId,
        names: [runtime.character.name],
        agentId: runtime.agentId,
      });
    }

    await runtime.createMemory(
      {
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId,
        content: { text, actions: ["BEGIN_ONBOARDING"] },
        createdAt: Date.now(),
      },
      "messages"
    );

    logger.info(`Started settings DM with owner ${guild.ownerId} for server ${guild.id}`);
  } catch (error) {
    logger.error(`Error starting DM with owner: ${String(error)}`);
    throw error;
  }
}

/**
 * Telegram deep-link onboarding nudge in a group chat.
 */
export async function startTelegramOnboarding(
  runtime: IAgentRuntime,
  world: World,
  chat: any,
  entities: any[],
  botUsername: string
): Promise<void> {
  let ownerUsername: string | null = null;

  for (const entity of entities) {
    if (entity?.metadata?.telegram?.adminTitle === "Owner") {
      ownerUsername = entity?.metadata?.telegram?.username ?? null;
      break;
    }
  }

  const telegramClient = runtime.getService("telegram") as any;

  const deepLink = [
    ownerUsername ? `Hello @${ownerUsername}!` : "Hello!",
    `Could we take a few minutes to get everything set up?`,
    `Tap to start: https://t.me/${botUsername}?start=onboarding`,
  ].join(" ");

  await telegramClient.messageManager.sendMessage(chat.id, { text: deepLink });
  logger.info(`Sent deep-link to group ${chat.id} (world ${world.id})`);
}
