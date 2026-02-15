import fs from "fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config";

let _cached: Keypair | null = null;

/**
 * Loads the manager keypair from either:
 *  - MANAGER_SECRET_KEY env var (base58 string or JSON byte array), or
 *  - MANAGER_SECRET_PATH (path to a JSON keypair file)
 *
 * The result is cached after the first call.
 */
export function getManagerKeypair(): Keypair {
  if (_cached) return _cached;

  if (config.managerSecretKey) {
    const raw = config.managerSecretKey.trim();
    // Try JSON array first, then base58
    if (raw.startsWith("[")) {
      _cached = Keypair.fromSecretKey(Buffer.from(JSON.parse(raw)));
    } else {
      _cached = Keypair.fromSecretKey(bs58.decode(raw));
    }
  } else if (config.managerSecretPath) {
    _cached = Keypair.fromSecretKey(
      Buffer.from(JSON.parse(fs.readFileSync(config.managerSecretPath, "utf-8")))
    );
  } else {
    throw new Error(
      "Either MANAGER_SECRET_KEY or MANAGER_SECRET_PATH must be set"
    );
  }

  return _cached;
}
