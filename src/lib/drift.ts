import { BN } from "@coral-xyz/anchor";
import {
  calculateDepositRate,
  calculateUtilization,
  configs,
  DRIFT_PROGRAM_ID,
  getTokenAmount,
  MainnetSpotMarkets,
  SPOT_MARKET_RATE_PRECISION,
  SpotBalanceType,
  SpotMarketAccount,
  ZERO,
} from "@drift-labs/sdk";
import { VoltrClient } from "@voltr/vault-sdk";
import { config } from "../config";
import { Keypair, TransactionInstruction } from "@solana/web3.js";
import { address, getProgramDerivedAddress } from "@solana/kit";
import {
  DEPOSIT_EARN_DISCRIMINATOR,
  WITHDRAW_EARN_DISCRIMINATOR,
  DRIFT_ADAPTOR_PROGRAM_ID,
} from "./constants";
import { logger } from "./utils";
import { toPublicKey, TOKEN_2022_PROGRAM_ADDR } from "./convert";

export const DRIFT_STATE_ADDRESS = address("5zpq7DvB6UdFFvpmBPspGPNfUGoBRRCE2HHg5u3gxcsN");

const DRIFT_PROGRAM_ADDR = address(DRIFT_PROGRAM_ID);

/**
 * Evaluates the projected deposit APR for a Drift spot market reserve with a new allocation.
 *
 * @param spotMarket The SpotMarketAccount object for the reserve.
 * @param depositAmountDelta The change in the total deposit amount, in the token's native precision (e.g., lamports for SOL).
 * @returns The projected annual percentage rate (APR) as a number (e.g., 5.5 for 5.5%). Returns 0 if the new deposit amount exceeds the market's deposit limit.
 */
export function evaluateDriftSpotMarketYield(
  spotMarket: SpotMarketAccount,
  depositAmountDelta: BN
): number {
  // 1. Get current total deposits in native token amount
  const currentDeposits = getTokenAmount(
    spotMarket.depositBalance,
    spotMarket,
    SpotBalanceType.DEPOSIT
  );

  // 2. Calculate the new total projected deposits
  const totalProjectedSupply = currentDeposits.add(depositAmountDelta);

  // 3. Check if the new deposit amount would exceed the market's deposit limit
  // A maxTokenDeposits of 0 means there is no limit.
  if (
    spotMarket.maxTokenDeposits.gt(ZERO) &&
    totalProjectedSupply.gt(spotMarket.maxTokenDeposits)
  ) {
    return 0.0;
  }

  // 4. Calculate the projected utilization with the new deposit amount.
  // The `calculateUtilization` function from the SDK can take a delta directly.
  const projectedUtilization = calculateUtilization(
    spotMarket,
    depositAmountDelta
  );

  // 5. Calculate the projected deposit rate (yield) based on the new utilization.
  // This function internally calculates the borrow rate and then the corresponding deposit rate.
  const projectedDepositRate = calculateDepositRate(
    spotMarket,
    depositAmountDelta,
    projectedUtilization // Pass in pre-calculated utilization to be efficient
  );

  // 6. Convert the rate to a human-readable APR percentage.
  // The rate is an APR with SPOT_MARKET_RATE_PRECISION (1,000,000).
  const apr =
    projectedDepositRate.toNumber() / SPOT_MARKET_RATE_PRECISION.toNumber();

  return apr;
}

export async function createDepositDEarnStrategyIx(
  voltrClient: VoltrClient,
  marketIndex: number,
  managerKp: Keypair,
  depositAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  try {
    const spotMarketConfig = MainnetSpotMarkets.find(
      spotMarketConfig => spotMarketConfig.marketIndex === marketIndex
    );
    if (!spotMarketConfig) throw Error("Invalid spot market config");

    const [counterPartyTaAddr] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("spot_market_vault"),
        new BN(spotMarketConfig.marketIndex).toArrayLike(Buffer, "le", 2),
      ],
      programAddress: DRIFT_PROGRAM_ADDR,
    });
    const counterPartyTa = toPublicKey(counterPartyTaAddr);

    const [spotMarketAddr] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("spot_market"),
        new BN(spotMarketConfig.marketIndex).toArrayLike(Buffer, "le", 2),
      ],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
      toPublicKey(config.voltrVaultAddress),
      counterPartyTa
    );

    const [userStatsAddr] = await getProgramDerivedAddress({
      seeds: [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    const [userAddr] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("user"),
        vaultStrategyAuth.toBuffer(),
        new BN(0).toArrayLike(Buffer, "le", 2),
      ],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    // Prepare the remaining accounts
    const remainingAccounts = [
      { pubkey: counterPartyTa, isSigner: false, isWritable: true },
      {
        pubkey: toPublicKey(DRIFT_PROGRAM_ADDR),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: toPublicKey(userStatsAddr), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(userAddr), isSigner: false, isWritable: true },
      {
        pubkey: toPublicKey(DRIFT_STATE_ADDRESS),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: spotMarketConfig.oracle,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: toPublicKey(spotMarketAddr), isSigner: false, isWritable: true },
    ];

    if (config.assetTokenProgram === TOKEN_2022_PROGRAM_ADDR) {
      remainingAccounts.push({
        pubkey: toPublicKey(config.assetMintAddress),
        isSigner: false,
        isWritable: false,
      });
    }

    let additionalArgs = Buffer.from([
      ...new BN(spotMarketConfig.marketIndex).toArrayLike(Buffer, "le", 2),
    ]);

    const createDepositStrategyIx = await voltrClient.createDepositStrategyIx(
      {
        instructionDiscriminator: Buffer.from(DEPOSIT_EARN_DISCRIMINATOR),
        depositAmount,
        additionalArgs,
      },
      {
        manager: managerKp.publicKey,
        vault: toPublicKey(config.voltrVaultAddress),
        vaultAssetMint: toPublicKey(config.assetMintAddress),
        assetTokenProgram: toPublicKey(config.assetTokenProgram),
        strategy: counterPartyTa,
        remainingAccounts,
        adaptorProgram: toPublicKey(DRIFT_ADAPTOR_PROGRAM_ID),
      }
    );

    transactionIxs.push(createDepositStrategyIx);
    addressLookupTableAddresses.push(...configs["mainnet-beta"].MARKET_LOOKUP_TABLES);
  } catch (error) {
    logger.error({ err: error }, "Error in drift strategy instruction");
  }
}

export async function createWithdrawDEarnStrategyIx(
  voltrClient: VoltrClient,
  marketIndex: number,
  managerKp: Keypair,
  withdrawAmount: BN,
  transactionIxs: TransactionInstruction[] = [],
  addressLookupTableAddresses: string[] = []
) {
  try {
    const spotMarketConfig = MainnetSpotMarkets.find(
      spotMarketConfig => spotMarketConfig.marketIndex === marketIndex
    );
    if (!spotMarketConfig) throw Error("Invalid spot market config");

    const [counterPartyTaAddr] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("spot_market_vault"),
        new BN(spotMarketConfig.marketIndex).toArrayLike(Buffer, "le", 2),
      ],
      programAddress: DRIFT_PROGRAM_ADDR,
    });
    const counterPartyTa = toPublicKey(counterPartyTaAddr);

    const [spotMarketAddr] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("spot_market"),
        new BN(spotMarketConfig.marketIndex).toArrayLike(Buffer, "le", 2),
      ],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    const { vaultStrategyAuth } = voltrClient.findVaultStrategyAddresses(
      toPublicKey(config.voltrVaultAddress),
      counterPartyTa
    );

    const [userStatsAddr] = await getProgramDerivedAddress({
      seeds: [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    const [userAddr] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("user"),
        vaultStrategyAuth.toBuffer(),
        new BN(0).toArrayLike(Buffer, "le", 2),
      ],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    const [driftSignerAddr] = await getProgramDerivedAddress({
      seeds: [Buffer.from("drift_signer")],
      programAddress: DRIFT_PROGRAM_ADDR,
    });

    // Prepare the remaining accounts
    const remainingAccounts = [
      { pubkey: toPublicKey(driftSignerAddr), isSigner: false, isWritable: true },
      { pubkey: counterPartyTa, isSigner: false, isWritable: true },
      {
        pubkey: toPublicKey(DRIFT_PROGRAM_ADDR),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: toPublicKey(userStatsAddr), isSigner: false, isWritable: true },
      { pubkey: toPublicKey(userAddr), isSigner: false, isWritable: true },
      {
        pubkey: toPublicKey(DRIFT_STATE_ADDRESS),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: spotMarketConfig.oracle,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: toPublicKey(spotMarketAddr), isSigner: false, isWritable: true },
    ];

    if (config.assetTokenProgram === TOKEN_2022_PROGRAM_ADDR) {
      remainingAccounts.push({
        pubkey: toPublicKey(config.assetMintAddress),
        isSigner: false,
        isWritable: false,
      });
    }

    let additionalArgs = Buffer.from([
      ...new BN(spotMarketConfig.marketIndex).toArrayLike(Buffer, "le", 2),
    ]);

    const createWithdrawStrategyIx = await voltrClient.createWithdrawStrategyIx(
      {
        instructionDiscriminator: Buffer.from(WITHDRAW_EARN_DISCRIMINATOR),
        withdrawAmount,
        additionalArgs,
      },
      {
        manager: managerKp.publicKey,
        vault: toPublicKey(config.voltrVaultAddress),
        vaultAssetMint: toPublicKey(config.assetMintAddress),
        assetTokenProgram: toPublicKey(config.assetTokenProgram),
        strategy: counterPartyTa,
        remainingAccounts,
        adaptorProgram: toPublicKey(DRIFT_ADAPTOR_PROGRAM_ID),
      }
    );

    transactionIxs.push(createWithdrawStrategyIx);
    addressLookupTableAddresses.push(...configs["mainnet-beta"].MARKET_LOOKUP_TABLES);
  } catch (error) {
    logger.error({ err: error }, "Error in drift strategy instruction");
  }
}
