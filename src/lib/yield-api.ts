import { config } from "../config";
import { logger } from "./utils";
import { StrategyConfig, strategyRegistry } from "./strategy-config";

const YIELD_MARKETS_URL = config.yieldMarketsUrl;

export interface DialMarket {
  id: string;
  provider: { id: string; name: string };
  token: { address: string; symbol: string; decimals: number };
  depositApy: number;
  totalDepositUsd: number;
  additionalData: { vaultAddress?: string };
}

interface DialApiResponse {
  markets: DialMarket[];
  cursor: string | null;
}

export interface MatchedMarket {
  market: DialMarket;
  strategy: StrategyConfig;
}

export async function fetchYieldMarkets(
  assetMint: string
): Promise<DialMarket[]> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.yieldApiTimeoutMs
  );

  try {
    const response = await fetch(YIELD_MARKETS_URL, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Dial API returned ${response.status}`);
    }
    const data = (await response.json()) as DialApiResponse;
    const filtered = data.markets.filter(
      (m) => m.token.address === assetMint
    );
    logger.debug(
      { total: data.markets.length, forAsset: filtered.length },
      "Fetched yield markets from Dial API"
    );
    return filtered;
  } finally {
    clearTimeout(timeout);
  }
}

export function matchMarketsToStrategies(
  markets: DialMarket[]
): MatchedMarket[] {
  const matched: MatchedMarket[] = [];

  for (const market of markets) {
    if (market.additionalData?.vaultAddress) {
      const strategy = strategyRegistry.strategies.find(
        (s) =>
          s.type === "kaminoVault" &&
          s.address === market.additionalData.vaultAddress
      );
      if (strategy) {
        matched.push({ market, strategy });
        continue;
      }
    }

    if (market.provider.id === "jupiter") {
      const strategy = strategyRegistry.strategies.find(
        (s) => s.type === "jupiterLend"
      );
      if (strategy) {
        matched.push({ market, strategy });
      }
    }
  }

  return matched;
}

export function filterByTvl(
  markets: MatchedMarket[],
  minUsd: number = config.minTvlUsd
): MatchedMarket[] {
  return markets.filter((m) => m.market.totalDepositUsd >= minUsd);
}

export function checkDilution(
  market: DialMarket,
  ourDepositUsd: number,
  maxPct: number = config.maxDilutionPct
): boolean {
  const { depositApy, totalDepositUsd } = market;
  const effectiveApy =
    (depositApy * totalDepositUsd) / (totalDepositUsd + ourDepositUsd);
  const dilution = depositApy - effectiveApy;
  return dilution <= maxPct;
}

export function selectWinner(
  markets: MatchedMarket[],
  ourDepositUsd: number
): MatchedMarket | null {
  const tvlFiltered = filterByTvl(markets);
  logger.debug(
    { before: markets.length, after: tvlFiltered.length },
    "TVL filter applied"
  );

  const dilutionFiltered = tvlFiltered.filter((m) =>
    checkDilution(m.market, ourDepositUsd)
  );
  logger.debug(
    { before: tvlFiltered.length, after: dilutionFiltered.length },
    "Dilution filter applied"
  );

  if (dilutionFiltered.length === 0) {
    return null;
  }

  dilutionFiltered.sort((a, b) => b.market.depositApy - a.market.depositApy);

  const winner = dilutionFiltered[0];
  logger.info(
    {
      strategyId: winner.strategy.id,
      apy: winner.market.depositApy,
      tvl: winner.market.totalDepositUsd,
      provider: winner.market.provider.name,
    },
    "Selected yield winner"
  );

  return winner;
}
