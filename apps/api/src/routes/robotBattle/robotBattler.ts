/**
 * Robot battler is a service that handles the logic for robot battles.
 * It is responsible for starting battles, updating battle results, and handling errors.
 */

import type { db } from "@/db/db";
import {
  BattleRobotsTable,
  BattleRoundsTable,
  BattleTable,
} from "@/db/schema/robotBattle.db";
import { env } from "@/env";
import { LiteralClient } from "@literalai/client";
import { executeStepStructured } from "cat-ai";
import type { Logger } from "cat-logger";
import { eq } from "drizzle-orm";
import type { BattleId } from "robot-sdk";
import { generateId, RobotId } from "robot-sdk";
import { z } from "zod";
import { createMediaGenClient } from "cat-media-gen";
/**
 * Battle requirements:
 * - Battle can have 2 or more robots
 * - Battle must have a winner
 * - Battle happens in multuple rounds until a winner is determined
 * - Each round has a damage report
 * - - Damage is substracted from the robot's health until one robot's health is 0 or less, that robot is eliminated
 * - - Rounds are processed recursively until a winner is determined
 */

// Create the client instance
const literalClient = new LiteralClient({
  apiKey: env.LITERAL_AI_API_KEY,
});

const mediaGen = createMediaGenClient({ falApiKey: env.FAL_API_KEY });

const RobotStateSchema = z.object({
  robotId: z.string(),
  currentHealth: z.number(),
  isAlive: z.boolean(),
  status: z.array(z.string()), // For effects like "damaged armor", "weapon malfunction" etc
});

const BattleActionSchema = z.object({
  attackerId: z.string(),
  defenderId: z.string(),
  damage: z.number(),
  description: z.string(),
});

const BattleRoundSchema = z.object({
  roundNumber: z.number(),
  narrative: z.string(),
  actions: z.array(BattleActionSchema),
  tacticalAnalysis: z.string(),
  winnerId: z.string().nullable(),
  imageUrl: z.string().nullable(),
});

type RobotState = z.infer<typeof RobotStateSchema>;

const MAX_ROUNDS = 10; // Prevent infinite battles

export const _resolveBattle = async (props: {
  battleId: BattleId;
  db: db;
  logger: Logger;
}) => {
  const { battleId, db, logger } = props;

  // Get battle and robots data
  const battle = await db.query.BattleTable.findFirst({
    where: eq(BattleTable.id, battleId),
  });

  if (!battle) throw new Error(`Battle ${battleId} not found`);

  // Only proceed if battle is IN_PROGRESS
  if (battle.status !== "IN_PROGRESS") {
    logger.info({
      msg: "Battle not in progress, skipping resolution",
      battleId,
      status: battle.status,
    });
    return;
  }

  const battleRobots = await db.query.BattleRobotsTable.findMany({
    where: eq(BattleRobotsTable.battleId, battleId),
    with: {
      robot: true,
    },
  });

  // Validate we have exactly 2 robots
  if (battleRobots.length !== 2) {
    logger.error({
      msg: "Invalid number of robots for battle",
      battleId,
      robotCount: battleRobots.length,
      robots: battleRobots.map((br) => br.robotId),
    });
    throw new Error(
      `Battle requires exactly 2 robots, found ${battleRobots.length}`
    );
  }

  // Validate both robots exist and have data
  if (!battleRobots.every((br) => br.robot)) {
    logger.error({
      msg: "Missing robot data",
      battleId,
      robots: battleRobots,
    });
    throw new Error("Missing robot data for battle");
  }

  // Initialize robot states
  const robotStates = new Map<string, RobotState>(
    battleRobots.map((br) => [
      br.robotId,
      {
        robotId: br.robotId,
        currentHealth: 100,
        isAlive: true,
        status: [],
      },
    ])
  );

  let roundNumber = 1;

  // Create thread once before processing rounds
  const threadId = `battle-${battleId}`;
  return await literalClient
    .thread({
      id: threadId,
      name: `Battle ${battleId}`,
      metadata: { battleId },
    })
    .wrap(async () => {
      // Process rounds until we have a winner or hit max rounds
      while (
        Array.from(robotStates.values()).filter((r) => r.isAlive).length > 1 &&
        roundNumber <= MAX_ROUNDS
      ) {
        logger.info({
          msg: "Battle status before round",
          roundNumber,
          robotStates: Array.from(robotStates.entries()).map(([id, state]) => ({
            id,
            health: state.currentHealth,
            isAlive: state.isAlive,
          })),
        });

        await processRound({
          battleId,
          roundNumber,
          robotStates,
          db,
          logger,
        });
        roundNumber++;
      }

      // Check if we hit max rounds without a winner
      if (roundNumber > MAX_ROUNDS) {
        // Declare the robot with the most health as winner
        const robots = Array.from(robotStates.values());
        robots.sort((a, b) => b.currentHealth - a.currentHealth);
        const winner = robots[0];

        logger.info({
          msg: "Battle reached max rounds, declaring winner by health",
          winner: winner.robotId,
          finalHealth: winner.currentHealth,
        });

        await db
          .update(BattleTable)
          .set({
            winnerId: RobotId.parse(winner.robotId),
            status: "COMPLETED",
            completedAt: new Date(),
          })
          .where(eq(BattleTable.id, battleId));

        return winner.robotId;
      }

      // Get winner normally
      const winner = Array.from(robotStates.values()).find((r) => r.isAlive);
      if (!winner) {
        logger.error({
          msg: "No winner found after battle",
          finalStates: Array.from(robotStates.entries()),
        });
        throw new Error("No winner found after battle");
      }

      await db
        .update(BattleTable)
        .set({
          winnerId: RobotId.parse(winner.robotId),
          status: "COMPLETED",
          completedAt: new Date(),
        })
        .where(eq(BattleTable.id, battleId));

      return winner.robotId;
    });
};

export const resolveBattle = async (props: {
  battleId: BattleId;
  db: db;
  logger: Logger;
}) => {
  const { battleId, db, logger } = props;
  try {
    logger.info({
      msg: "Starting battle resolution",
      battleId,
    });
    return await _resolveBattle({ battleId, db, logger });
  } catch (error) {
    logger.error({
      msg: "Failed to resolve battle",
      error,
      battleId,
      errorDetails:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
            }
          : undefined,
    });
    // update battle status to failed
    await db
      .update(BattleTable)
      .set({
        status: "FAILED",
        completedAt: new Date(),
      })
      .where(eq(BattleTable.id, battleId));

    throw error; // Re-throw to ensure the error is propagated
  }
};

const processRound = async (props: {
  battleId: BattleId;
  roundNumber: number;
  robotStates: Map<string, RobotState>;
  db: db;
  logger: Logger;
}) => {
  const { battleId, roundNumber, robotStates, db, logger } = props;

  // Get robot names from database for narrative purposes
  const battleRobots = await db.query.BattleRobotsTable.findMany({
    where: eq(BattleRobotsTable.battleId, battleId),
    with: {
      robot: true,
    },
  });

  // Create a mapping of robot IDs to their names
  const robotNames = new Map<string, string>(
    battleRobots.map((br) => [br.robotId, br.robot.name])
  );

  logger.info({
    msg: "Processing battle round",
    battleId,
    roundNumber,
    robotStates: Array.from(robotStates.entries()).map(([id, state]) => ({
      id,
      health: state.currentHealth,
      isAlive: state.isAlive,
      status: state.status,
    })),
  });

  // Validate robot states before proceeding
  if (robotStates.size !== 2) {
    throw new Error(`Invalid number of robot states: ${robotStates.size}`);
  }

  const aliveRobots = Array.from(robotStates.values()).filter((r) => r.isAlive);
  if (aliveRobots.length < 2) {
    throw new Error(`Not enough active robots: ${aliveRobots.length}`);
  }

  // Simulate the round
  const roundResult = await literalClient
    .step({
      name: `Simulate Round ${roundNumber}`,
      type: "llm",
      metadata: {
        battleId,
        roundNumber,
        operation: "simulate_round",
      },
    })
    .wrap(async () => {
      const input = {
        roundNumber,
        robotStates: Array.from(robotStates.values()).map((state) => ({
          ...state,
          name: robotNames.get(state.robotId) || state.robotId, // Add name for narrative
        })),
      };

      logger.info({
        msg: "Simulating round with input",
        input,
        battleId,
        roundNumber,
      });

      try {
        const result = await executeStepStructured<typeof BattleRoundSchema>({
          stepName: "battle_round",
          input: JSON.stringify(input),
          system: createBattlePrompt(roundNumber, robotStates, robotNames),
          logger,
          providerConfig: {
            apikey: env.GOOGLE_GEMINI_API_KEY,
            modelId: "gemini-2.0-flash-exp",
            provider: "google",
          },
          literalClient,
          stepId: `round_${roundNumber}`,
          output: {
            outputSchema: BattleRoundSchema,
            schemaDescription: "The battle round results",
            schemaName: "BattleRound",
            temperature: 0.7,
          },
        });

        logger.info({
          msg: "Raw LLM response",
          result,
          battleId,
          roundNumber,
        });

        return result;
      } catch (error) {
        logger.error({
          msg: "Failed to process round",
          error,
          input,
          battleId,
          roundNumber,
          errorDetails:
            error instanceof Error
              ? {
                  message: error.message,
                  stack: error.stack,
                }
              : undefined,
        });
        throw error;
      }
    });

  // Apply damage and update states
  await literalClient
    .step({
      name: "Apply Round Results",
      type: "run",
      input: roundResult,
      metadata: {
        operation: "apply_damage",
      },
    })
    .wrap(async () => {
      // Apply damages to robot states
      for (const action of roundResult.actions) {
        const state = robotStates.get(action.defenderId);
        if (state?.isAlive) {
          state.currentHealth -= action.damage;
          state.status.push(action.description);
          if (state.currentHealth <= 0) {
            state.isAlive = false;
            state.status.push("ELIMINATED");
          }
        }
      }

      // After simulating the round and before saving to database, generate the image
      let roundImageUrl: string | undefined;
      try {
        const imagePrompt = `Epic robot battle scene: ${roundResult.narrative}. Cinematic lighting, dramatic angle, detailed mechanical parts, high quality render, 8k resolution, unreal engine style`;

        logger.info("Generating round image with prompt:", imagePrompt);

        const result = await mediaGen.generateImages({
          prompt: imagePrompt,
          imageSize: "square_hd",
          numImages: 1,
        });

        if (result[0]?.imageUrl) {
          roundImageUrl = result[0].imageUrl;
          logger.info("Generated round image:", roundImageUrl);
        }
      } catch (error) {
        logger.error("Failed to generate round image:", error);
        // Continue without image if generation fails
      }

      // Save round results to database with the image
      await db.insert(BattleRoundsTable).values({
        id: generateId("round"),
        battleId,
        roundNumber,
        description: roundResult.narrative,
        tacticalAnalysis: roundResult.tacticalAnalysis,
        winnerId: roundResult.winnerId
          ? RobotId.parse(roundResult.winnerId)
          : null,
        imageUrl: roundImageUrl, // Add the generated image URL
        createdAt: new Date(),
      });
    });
};

const createBattlePrompt = (
  roundNumber: number,
  robotStates: Map<string, RobotState>,
  robotNames: Map<string, string>
) => {
  const aliveRobots = Array.from(robotStates.values()).filter((r) => r.isAlive);

  return `You are simulating a battle between ${aliveRobots.length} robots.
Round ${roundNumber} is about to begin.

Current robot states:
${Array.from(robotStates.values())
  .map(
    (robot) => `
- ${robotNames.get(robot.robotId) || robot.robotId}:
  Health: ${robot.currentHealth}
  Status: ${robot.status.join(", ") || "Normal"}
  ${robot.isAlive ? "ACTIVE" : "ELIMINATED"}
`
  )
  .join("\n")}

Your response must follow this exact JSON structure, but use robot names in narrative and tactical analysis:
{
  "roundNumber": ${roundNumber},
  "narrative": "A brief description of the entire round using robot names",
  "actions": [
    {
      "attackerId": "ID of the attacking robot",
      "defenderId": "ID of the defending robot",
      "damage": (number between 1-30),
      "description": "Brief description of this specific attack using robot names"
    }
  ],
  "tacticalAnalysis": "A brief analysis of the round's outcome using robot names",
  "imageUrl": "The URL of the generated image for this round, if any",
  "winnerId": null  // Use robot ID here
}

Generate an exciting battle round with clear outcomes. For each attack:
1. Use robot names in descriptions and analysis
2. Keep using robot IDs in the action structure
3. Write a brief but vivid description of what happened

Keep the narrative exciting but focused on the key actions.
Note: Use robot names in narrative and analysis, but keep using IDs for the technical fields (attackerId, defenderId, winnerId).`;
};
