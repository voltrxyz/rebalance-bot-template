import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  AccountInfo,
} from "@solana/web3.js";
import fs from "fs";
import { VoltrClient } from "@voltr/vault-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import {
  createDepositKMarketStrategyIx,
  createDepositKVaultStrategyIx,
  createWithdrawKMarketStrategyIx,
  createWithdrawKVaultStrategyIx,
} from "./lib/kamino";
import {
  Rpc,
  SolanaRpcApi,
} from "@solana/kit";
import { BN } from "@coral-xyz/anchor";
import {
  Allocation,
  getCurrentAndEqualAllocation,
} from "./lib/simulate";
import {
  createDepositDEarnStrategyIx,
  createWithdrawDEarnStrategyIx,
} from "./lib/drift";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "./lib/solana";
import {
  createDepositJLendStrategyIx,
  createWithdrawJLendStrategyIx,
} from "./lib/jupiter";
import { getConnectionManager } from "./lib/connection";
import { toAddress, toPublicKey } from "./lib/convert";
import { strategyRegistry, DriftEarnStrategyConfig } from "./lib/strategy-config";

export async function runRebalanceLoop() {
  logger.info("Starting Rebalance Bot...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();

  const manager = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(config.managerSecretPath, "utf-8")))
  );

  logger.info(
    `[Rebalance Loop] Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `[Rebalance Loop] Loop Interval: ${config.rebalanceLoopIntervalMs / 1000
    } seconds`
  );

  // Initialize clients
  const voltrClient = new VoltrClient(connection);

  const vaultAssetIdleAuth = voltrClient.findVaultAssetIdleAuth(
    toPublicKey(config.voltrVaultAddress)
  );

  const vaultAssetIdleAta = getAssociatedTokenAddressSync(
    toPublicKey(config.assetMintAddress),
    vaultAssetIdleAuth,
    true,
    toPublicKey(config.assetTokenProgram)
  );

  logger.info(
    `[Rebalance Loop] Monitoring ATA: ${vaultAssetIdleAta.toBase58()}`
  );

  let lastExecutionTime = 0;
  let lastMainExecutionStartTime = 0;
  let loopCount = 0;
  let subscriptionId: number | null = null;

  // Set up account subscription for real-time monitoring of new deposits
  const startAccountSubscription = () => {
    if (subscriptionId !== null) {
      connection.removeAccountChangeListener(subscriptionId);
    }

    subscriptionId = connection.onAccountChange(
      vaultAssetIdleAta,
      async (accountInfo: AccountInfo<Buffer>) => {
        try {
          const accountData = accountInfo.data;
          const amountBytes = accountData.slice(64, 72);
          const currentBalance = new BN(amountBytes, "le");

          logger.info(
            `[Rebalance Loop ${loopCount}] ATA Balance Update: ${currentBalance.toString()}`
          );

          // Trigger rebalance on new deposits
          if (
            currentBalance.gt(new BN(config.depositStrategyMinAmount)) &&
            lastMainExecutionStartTime < lastExecutionTime
          ) {
            try {
              logger.info(
                `[Rebalance Loop ${loopCount}] Executing equal-weight rebalance (triggered by ATA change)...`
              );

              const { prevAllocations, equalAllocations } =
                await getCurrentAndEqualAllocation(connection, rpc);

              await executeRebalance(
                rpc,
                connection,
                manager,
                voltrClient,
                prevAllocations,
                equalAllocations
              );
              logger.info(
                `[Rebalance Loop ${loopCount}] Successfully executed rebalance.`
              );

              lastExecutionTime = Date.now();
              logger.info(
                `[Rebalance Loop ${loopCount}] Next scheduled execution in ${config.rebalanceLoopIntervalMs / 1000
                } seconds`
              );
              loopCount++;
            } catch (error) {
              logger.error(
                error,
                `[Rebalance Loop ${loopCount}] Error during rebalance execution`
              );
            }
          }
        } catch (error) {
          logger.error(error, `Error processing account change`);
        }
      },
      "processed"
    );

    logger.info(
      `Started listening for ATA changes (subscription ID: ${subscriptionId})`
    );
  };

  // Start the subscription
  startAccountSubscription();

  // Main scheduled loop — execute equal-weight rebalance on every interval
  while (!isShuttingDown()) {
    let timeToSleep = 30000;
    try {
      const now = Date.now();
      const timeSinceLastExecution = now - lastExecutionTime;

      if (timeSinceLastExecution >= config.rebalanceLoopIntervalMs) {
        logger.info(
          `[Rebalance Loop ${loopCount}] Executing scheduled equal-weight rebalance...`
        );
        lastMainExecutionStartTime = now;

        const { prevAllocations, equalAllocations } =
          await getCurrentAndEqualAllocation(connection, rpc);

        const strategies = prevAllocations.map((allocation) =>
          allocation.strategyId
        );

        logger.info(
          `[Rebalance Loop ${loopCount}] strategies: ${strategies.join(",")}`
        );
        logger.info(
          `[Rebalance Loop ${loopCount}] prevAllocations: ${prevAllocations.map(
            (allocation) => allocation.positionValue.toNumber()
          )}`
        );
        logger.info(
          `[Rebalance Loop ${loopCount}] equalAllocations: ${equalAllocations.map(
            (allocation) => allocation.positionValue.toNumber()
          )}`
        );

        await executeRebalance(
          rpc,
          connection,
          manager,
          voltrClient,
          prevAllocations,
          equalAllocations
        );
        logger.info(
          `[Rebalance Loop ${loopCount}] Successfully executed scheduled rebalance.`
        );
        lastExecutionTime = Date.now();
        loopCount++;
      } else {
        logger.info(`[Rebalance Loop ${loopCount}] Waiting for next interval.`);
      }
    } catch (error) {
      timeToSleep = 12400;
      logger.error(
        error,
        `[Rebalance Loop ${loopCount}] Error during scheduled rebalance execution`
      );
    }

    await sleep(timeToSleep);

    // Restart subscription if it somehow got disconnected
    if (!isShuttingDown() && subscriptionId === null) {
      logger.warn("Subscription lost, restarting...");
      startAccountSubscription();
    }
  }

  // Cleanup WebSocket subscription on exit
  if (subscriptionId !== null) {
    connection.removeAccountChangeListener(subscriptionId);
    logger.info("Cleaned up WebSocket subscription");
  }
}

async function executeRebalance(
  rpc: Rpc<SolanaRpcApi>,
  connection: Connection,
  manager: Keypair,
  voltrClient: VoltrClient,
  prevAllocations: Allocation[],
  newAllocations: Allocation[]
) {
  const transactionIxs: TransactionInstruction[] = [];
  const addressLookupTableAddresses: string[] = [];

  const depositDelta = newAllocations.map((allocation, idx) => {
    return {
      strategyId: allocation.strategyId,
      strategyType: allocation.strategyType,
      strategyAddress: allocation.strategyAddress,
      delta: allocation.positionValue.sub(prevAllocations[idx].positionValue),
    };
  });

  let nWithdraws = 0;
  for (const allocation of depositDelta.filter((allocation) =>
    allocation.delta.ltn(0)
  )) {
    nWithdraws++;

    const originalIndex = depositDelta.findIndex(
      (a) => a.strategyId === allocation.strategyId
    );
    const withdrawAmount = newAllocations[originalIndex].positionValue.isZero()
      ? new BN(Number.MAX_SAFE_INTEGER)
      : allocation.delta.neg();

    switch (allocation.strategyType) {
      case "kaminoMarket":
        await createWithdrawKMarketStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "driftEarn": {
        const driftConfig = strategyRegistry.byId.get(allocation.strategyId)! as DriftEarnStrategyConfig;
        await createWithdrawDEarnStrategyIx(
          voltrClient,
          driftConfig.marketIndex,
          manager,
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      }
      case "jupiterLend":
        await createWithdrawJLendStrategyIx(
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "kaminoVault":
        await createWithdrawKVaultStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          withdrawAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      default:
        logger.warn(`Unknown strategy type "${allocation.strategyType}" for "${allocation.strategyId}", skipping withdraw`);
        break;
    }
  }

  for (const allocation of depositDelta.filter((allocation) =>
    allocation.delta.gtn(0)
  )) {
    const depositAmount = allocation.delta.subn(nWithdraws);

    switch (allocation.strategyType) {
      case "kaminoMarket":
        await createDepositKMarketStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "driftEarn": {
        const driftConfig = strategyRegistry.byId.get(allocation.strategyId)! as DriftEarnStrategyConfig;
        await createDepositDEarnStrategyIx(
          voltrClient,
          driftConfig.marketIndex,
          manager,
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      }
      case "jupiterLend":
        await createDepositJLendStrategyIx(
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      case "kaminoVault":
        await createDepositKVaultStrategyIx(
          rpc,
          voltrClient,
          allocation.strategyAddress,
          toAddress(manager.publicKey),
          depositAmount,
          transactionIxs,
          addressLookupTableAddresses
        );
        break;
      default:
        logger.warn(`Unknown strategy type "${allocation.strategyType}" for "${allocation.strategyId}", skipping deposit`);
        break;
    }

  }

  addressLookupTableAddresses.push(config.voltrLookupTableAddress);

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    addressLookupTableAddresses,
    rpc
  );

  const investBatchSize = 1;
  logger.info(
    `Executing ${Math.ceil(
      transactionIxs.length / investBatchSize
    )} transactions`
  );
  for (let i = 0; i < transactionIxs.length; i += investBatchSize) {
    const ixs = transactionIxs.slice(i, i + investBatchSize);
    const txSig = await sendAndConfirmOptimisedTx(
      ixs,
      config.rpcUrl,
      manager,
      [],
      addressLookupTableAccounts
    );
    logger.info(`Rebalance strategy confirmed with signature: ${txSig}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
