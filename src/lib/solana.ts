import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionConfirmationStrategy,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Rpc, SolanaRpcApi, address, fetchEncodedAccounts } from "@solana/kit";
import { isMainThread } from "worker_threads";
import { logger } from "./utils";
import * as metrics from "./metrics";
import { workerMetrics } from "./metrics-bridge";

const txMetricMap: Record<string, { observe: (labels: Record<string, string>, value: number) => void }> = {
  tx_compute_units: metrics.txComputeUnits,
  tx_priority_fee: metrics.txPriorityFee,
};

function observeTxMetric(name: string, value: number, labels?: Record<string, string>) {
  if (isMainThread) {
    txMetricMap[name]?.observe(labels ?? {}, value);
  } else {
    workerMetrics.observe(name, value, labels);
  }
}

export const sendAndConfirmOptimisedTx = async (
  instructions: TransactionInstruction[],
  heliusRpcUrl: string,
  payerKp: Keypair,
  signers: Keypair[] = [],
  addressLookupTableAccounts: AddressLookupTableAccount[] = [],
  computeUnitLimit: number | null = null,
  txType: string = "unknown"
) => {
  try {
    const connection = new Connection(heliusRpcUrl);
    let optimalCUs: number = 1_400_000;
    if (computeUnitLimit) {
      optimalCUs = computeUnitLimit;
    } else {
      const testInstructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: optimalCUs }),
        ...instructions,
      ];

      const cuTransaction = new VersionedTransaction(
        new TransactionMessage({
          instructions: testInstructions,
          payerKey: payerKp.publicKey,
          recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        }).compileToV0Message(addressLookupTableAccounts)
      );
      cuTransaction.sign([payerKp, ...signers]);

      const rpcResponse = await connection.simulateTransaction(cuTransaction, {
        replaceRecentBlockhash: true,
        sigVerify: false,
        commitment: "processed",
      });

      const requiredCUs = rpcResponse.value.unitsConsumed;

      if (!requiredCUs) {
        logger.error("Failed to get required CUs, using default");
      } else {
        optimalCUs = requiredCUs * 1.1;
      }
    }

    observeTxMetric("tx_compute_units", optimalCUs, { type: txType });

    const computeUnitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: optimalCUs,
    });

    instructions.push(computeUnitIx);

    const feTransaction = new VersionedTransaction(
      new TransactionMessage({
        instructions,
        payerKey: payerKp.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      }).compileToV0Message(addressLookupTableAccounts)
    );
    feTransaction.sign([payerKp, ...signers]);

    const response = await fetch(heliusRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "getPriorityFeeEstimate",
        params: [
          {
            transaction: bs58.encode(feTransaction.serialize()), // Pass the serialized transaction in Base58
            options: { priorityLevel: "Medium" },
          },
        ],
      }),
    });
    const data = await response.json();
    let feeEstimate = data.result;

    if (!feeEstimate) {
      logger.error("Failed to get fee estimate, using default");
      feeEstimate = { priorityFeeEstimate: 100 };
    }

    observeTxMetric("tx_priority_fee", feeEstimate.priorityFeeEstimate, { type: txType });

    const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: feeEstimate.priorityFeeEstimate,
    });

    instructions.push(computePriceIx);

    const transaction = new VersionedTransaction(
      new TransactionMessage({
        instructions,
        payerKey: payerKp.publicKey,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      }).compileToV0Message(addressLookupTableAccounts)
    );
    transaction.sign([payerKp, ...signers]);

    const txSig = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: "processed",
      maxRetries: 5,
    });

    const confirmationStrategy: TransactionConfirmationStrategy = {
      signature: txSig,
      blockhash: (await connection.getLatestBlockhash()).blockhash,
      lastValidBlockHeight: (await connection.getLatestBlockhash())
        .lastValidBlockHeight,
    };

    await connection.confirmTransaction(confirmationStrategy, "processed");

    return txSig;
  } catch (error) {
    throw new Error("Failed to send transaction: " + error);
  }
};

export const getAddressLookupTableAccounts = async (
  keys: string[],
  rpc: Rpc<SolanaRpcApi>
): Promise<AddressLookupTableAccount[]> => {
  const addresses = keys.map((key) => address(key));
  const accounts = await fetchEncodedAccounts(rpc, addresses);

  return accounts.reduce((acc, account, index) => {
    if (account.exists) {
      const addressLookupTableAccount = new AddressLookupTableAccount({
        key: new PublicKey(keys[index]),
        state: AddressLookupTableAccount.deserialize(account.data),
      });
      acc.push(addressLookupTableAccount);
    }
    return acc;
  }, new Array<AddressLookupTableAccount>());
};
