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
import {
  createClaimRewardKMarketStrategyIx,
} from "./lib/kamino";
import { Farms } from "@kamino-finance/farms-sdk";
import { Decimal } from "decimal.js";
import { getConnectionManager } from "./lib/connection";
import { toAddress, toPublicKey } from "./lib/convert";
import { strategyRegistry } from "./lib/strategy-config";
import { getManagerKeypair } from "./lib/keypair";
import { loopIterationsTotal, loopErrorsTotal, txTotal, txDurationSeconds } from "./lib/metrics";

export async function runClaimKmarketRewardLoop() {
  logger.info("🚀 Starting Claim KMarket Reward Bot...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();
  const rpc = connManager.getRpc();

  const manager = getManagerKeypair();

  logger.info(
    `[Claim KMarket Reward Loop] 🔑 Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `[Claim KMarket Reward Loop] ⏰ Loop Interval: ${config.claimKmarketRewardLoopIntervalMs / 1000
    } seconds`
  );

  // Initialize clients
  const voltrClient = new VoltrClient(connection);

  let lastExecutionTime = 0;
  let loopCount = 0;

  // Main scheduled loop
  while (!isShuttingDown()) {
    try {
      const now = Date.now();
      const timeSinceLastExecution = now - lastExecutionTime;

      if (timeSinceLastExecution >= config.claimKmarketRewardLoopIntervalMs) {
        logger.info(
          `[Claim KMarket Reward Loop ${loopCount}] 🛠️ Executing scheduled claim reward strategy...`
        );

        const kaminoMarketAddresses = strategyRegistry.kaminoMarkets.map((s) => s.address);

        for (const reserveAddress of kaminoMarketAddresses) {

          const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
            toPublicKey(config.voltrVaultAddress),
            toPublicKey(reserveAddress)
          );
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
              await createClaimRewardKMarketStrategyIx(
                rpc,
                connection,
                voltrClient,
                address(reserveAddress),
                farmData.userStateAddress,
                farmData.farm,
                farmData.pendingRewards[0].rewardTokenMint,
                farmData.pendingRewards[0].rewardTokenProgramId,
                toAddress(manager.publicKey),
                new BN(rewardAmount.toString()),
                transactionIxs,
                addressLookupTableAddresses
              );

              addressLookupTableAddresses.push(config.voltrLookupTableAddress);

              const addressLookupTableAccounts =
                await getAddressLookupTableAccounts(
                  addressLookupTableAddresses,
                  rpc
                );

              const txStart = Date.now();
              const txSig = await sendAndConfirmOptimisedTx(
                transactionIxs,
                connManager.getRpcUrl(),
                manager,
                [],
                addressLookupTableAccounts,
                null,
                "claim"
              );
              txTotal.inc({ type: "claim_kmarket", status: "success" });
              txDurationSeconds.observe({ type: "claim_kmarket" }, (Date.now() - txStart) / 1000);

              logger.info(
                `Claim kmarket reward strategy confirmed with signature: ${txSig}`
              );
            }
          }
        }
        loopIterationsTotal.inc({ loop: "claim_kmarket" });
        loopCount++;
        lastExecutionTime = now;
      }
    } catch (error) {
      loopErrorsTotal.inc({ loop: "claim_kmarket" });
      logger.error(
        error,
        `[Claim KMarket Reward Loop ${loopCount}] ❌ Error during scheduled claim reward execution`
      );
    }

    // Check every 30 seconds instead of sleeping for the full interval
    await sleep(30000);
  }
}
