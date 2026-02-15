import {
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "./lib/solana";
import { BN } from "@coral-xyz/anchor";
import {
  address,
} from "@solana/kit";
import { KaminoVault } from "@kamino-finance/klend-sdk";
import {
  createClaimRewardKVaultStrategyIx,
  getKaminoVaultReservesAccountMetas,
} from "./lib/kamino";
import { Farms } from "@kamino-finance/farms-sdk";
import { Decimal } from "decimal.js";
import { getConnectionManager } from "./lib/connection";
import { toAddress, toPublicKey } from "./lib/convert";
import { strategyRegistry } from "./lib/strategy-config";
import { getManagerKeypair } from "./lib/keypair";

export async function runClaimKvaultRewardLoop() {
  logger.info("🚀 Starting Claim KVault Reward Bot...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();

  const manager = getManagerKeypair();

  logger.info(
    `[Claim KVault Reward Loop] 🔑 Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `[Claim KVault Reward Loop] ⏰ Loop Interval: ${
      config.claimKvaultRewardLoopIntervalMs / 1000
    } seconds`
  );

  // Initialize clients
  const voltrClient = new VoltrClient(connection);

  let lastExecutionTime = 0;
  let loopCount = 0;

  if (strategyRegistry.kaminoVaults.length === 0) {
    logger.info("[Claim KVault Reward Loop] No kaminoVault strategies in registry, skipping loop");
    return;
  }

  // Main scheduled loop
  while (!isShuttingDown()) {
    try {
      const now = Date.now();
      const timeSinceLastExecution = now - lastExecutionTime;

      if (timeSinceLastExecution >= config.claimKvaultRewardLoopIntervalMs) {
        logger.info(
          `[Claim KVault Reward Loop ${loopCount}] 🛠️ Executing scheduled claim reward strategy...`
        );

        for (const kvConfig of strategyRegistry.kaminoVaults) {
          const kaminoVault = new KaminoVault(address(kvConfig.address));
          const vaultState = await kaminoVault.getState(rpc);

          const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
            toPublicKey(config.voltrVaultAddress),
            toPublicKey(kvConfig.address)
          );

          const { vaultReservesAccountMetas, vaultReservesLendingMarkets } =
            await getKaminoVaultReservesAccountMetas(rpc, vaultState);
          const farms = new Farms(rpc);

          const timestamp = Date.now() / 1000;
          const farmsForUser = await farms.getAllFarmsForUser(
            address(vaultStrategyAuth.toBase58()),
            new Decimal(timestamp - 2)
          );

          const farmsForUserArray = Array.from(farmsForUser.entries());

          for (const [_, farmData] of farmsForUserArray) {
            if (!farmData.pendingRewards?.length) continue;
            const rewardAmount =
              farmData.pendingRewards[0].cumulatedPendingRewards;

            if (rewardAmount.gt(100)) {
              const addressLookupTableAddresses: string[] = [];
              const transactionIxs: TransactionInstruction[] = [];
              await createClaimRewardKVaultStrategyIx(
                rpc,
                connection,
                voltrClient,
                address(kvConfig.address),
                farmData.userStateAddress,
                farmData.farm,
                farmData.pendingRewards[0].rewardTokenMint,
                farmData.pendingRewards[0].rewardTokenProgramId,
                toAddress(manager.publicKey),
                new BN(rewardAmount.toString()),
                vaultReservesAccountMetas,
                vaultReservesLendingMarkets,
                transactionIxs,
                addressLookupTableAddresses
              );

              addressLookupTableAddresses.push(config.voltrLookupTableAddress);

              const addressLookupTableAccounts =
                await getAddressLookupTableAccounts(
                  addressLookupTableAddresses,
                  rpc
                );

              const txSig = await sendAndConfirmOptimisedTx(
                transactionIxs,
                connManager.getRpcUrl(),
                manager,
                [],
                addressLookupTableAccounts
              );

              logger.info(
                `Claim kvault reward strategy (${kvConfig.id}) confirmed with signature: ${txSig}`
              );
            }
          }
        }
        loopCount++;
        lastExecutionTime = now;
      }
    } catch (error) {
      logger.error(
        error,
        `[Claim KVault Reward Loop ${loopCount}] ❌ Error during scheduled claim reward execution`
      );
    }

    // Check every 30 seconds instead of sleeping for the full interval
    await sleep(30000);
  }
}
