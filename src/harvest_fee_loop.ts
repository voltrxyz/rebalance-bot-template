import {
  Connection,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { config } from "./config";
import { isShuttingDown, logger, sleep } from "./lib/utils";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "./lib/solana";
import { Rpc, SolanaRpcApi } from "@solana/kit";
import { getConnectionManager } from "./lib/connection";
import { toPublicKey } from "./lib/convert";
import { VOLTR_PROTOCOL_ADMIN_ADDRESS } from "./lib/constants";
import { getManagerKeypair } from "./lib/keypair";
import { loopIterationsTotal, loopErrorsTotal, txTotal, txDurationSeconds } from "./lib/metrics";

export async function runHarvestFeeLoop() {
  logger.info("🚀 Starting Harvest Fee Loop...");

  const connManager = getConnectionManager();
  const connection = connManager.getConnection();

  const manager = getManagerKeypair();

  logger.info(
    `[Harvest Fee Loop] 🔑 Manager Loaded: ${manager.publicKey.toBase58()}`
  );
  logger.info(
    `[Harvest Fee Loop] ⏰ Loop Interval: ${
      config.refreshLoopIntervalMs / 1000
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

      if (timeSinceLastExecution >= config.harvestFeeLoopIntervalMs) {
        logger.info(
          `[Harvest Fee Loop ${loopCount}] 🛠️ Executing scheduled harvest fee...`
        );
        await executeHarvestFee(connManager.getRpc(), connection, manager, voltrClient);

        loopIterationsTotal.inc({ loop: "harvest" });
        logger.info(
          `[Harvest Fee Loop ${loopCount}] ✅ Successfully executed scheduled harvest fee.`
        );

        loopCount++;
        lastExecutionTime = now;
      }
    } catch (error) {
      loopErrorsTotal.inc({ loop: "harvest" });
      logger.error(
        error,
        `[Harvest Fee Loop ${loopCount}] ❌ Error during scheduled harvest fee execution`
      );
    }

    // Check every 30 seconds instead of sleeping for the full interval
    await sleep(30000);
  }
}

async function executeHarvestFee(
  rpc: Rpc<SolanaRpcApi>,
  connection: Connection,
  manager: Keypair,
  voltrClient: VoltrClient
) {
  const transactionIxs: TransactionInstruction[] = [];
  const vault = toPublicKey(config.voltrVaultAddress);
  const vaultManager = toPublicKey(config.voltrVaultManagerAddress);
  const vaultAdmin = toPublicKey(config.voltrVaultAdminAddress);
  const protocolAdmin = toPublicKey(VOLTR_PROTOCOL_ADMIN_ADDRESS);

  const vaultLpMint = voltrClient.findVaultLpMint(
    toPublicKey(config.voltrVaultAddress)
  );

  transactionIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      manager.publicKey,
      getAssociatedTokenAddressSync(
        vaultLpMint,
        protocolAdmin,
        true,
        toPublicKey(config.assetTokenProgram)
      ),
      protocolAdmin,
      vaultLpMint
    )
  );

  transactionIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      manager.publicKey,
      getAssociatedTokenAddressSync(
        vaultLpMint,
        vaultAdmin,
        true,
        toPublicKey(config.assetTokenProgram)
      ),
      vaultAdmin,
      vaultLpMint
    )
  );

  transactionIxs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      manager.publicKey,
      getAssociatedTokenAddressSync(
        vaultLpMint,
        vaultManager,
        true,
        toPublicKey(config.assetTokenProgram)
      ),
      vaultManager,
      vaultLpMint
    )
  );

  const harvestFeeIx = await voltrClient.createHarvestFeeIx({
    harvester: manager.publicKey,
    vaultManager,
    vaultAdmin,
    protocolAdmin,
    vault,
  });

  transactionIxs.push(harvestFeeIx);

  const addressLookupTableAccounts = await getAddressLookupTableAccounts(
    [config.voltrLookupTableAddress],
    rpc
  );

  const txStart = Date.now();
  try {
    const txSig = await sendAndConfirmOptimisedTx(
      transactionIxs,
      getConnectionManager().getRpcUrl(),
      manager,
      [],
      addressLookupTableAccounts,
      null,
      "harvest"
    );
    txTotal.inc({ type: "harvest", status: "success" });
    txDurationSeconds.observe({ type: "harvest" }, (Date.now() - txStart) / 1000);
    logger.info(`Harvest fee confirmed with signature: ${txSig}`);
  } catch (error) {
    txTotal.inc({ type: "harvest", status: "error" });
    throw error;
  }
}
