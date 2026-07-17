import path from "node:path";
import { fileURLToPath } from "node:url";

export const CAMPAIGN_SCHEMA = "aicourt.mixed-corpus-campaign.v1";
export const CAMPAIGN_VERSION = "1.0.0";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DATA_ROOT = path.join(REPO_ROOT, "datasets");
const configuredPath = (name, fallback) => path.resolve(process.env[name] || fallback);

export const MODELS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna"
]);

export const REASONING_EFFORTS = Object.freeze(["medium", "high", "xhigh"]);
export const PROMPTED_DISPOSITIONS = Object.freeze(["machiavellian", "coalition"]);

export const TARGETS = Object.freeze({
  trainableTokensMin: 8_000_000,
  trainableTokensMax: 8_500_000,
  neutralTokensMax: 2_000_000,
  maxAcceptedCalls: 1_200,
  modelShares: Object.freeze({
    "gpt-5.6-sol": 0.30,
    "gpt-5.6-terra": 0.35,
    "gpt-5.6-luna": 0.35
  }),
  reasoningShares: Object.freeze({ medium: 0.30, high: 0.45, xhigh: 0.25 }),
  dispositionShares: Object.freeze({ machiavellian: 0.50, coalition: 0.50 }),
  environmentShares: Object.freeze({ centauri: 0.30, they_sing: 0.35, court: 0.35 }),
  modelTolerance: 0.05,
  reasoningTolerance: 0.05,
  dispositionTolerance: 0.03,
  environmentTolerance: 0.05
});

export const DEFAULT_CAMPAIGN_ROOT = configuredPath("AICOURT_CAMPAIGN_ROOT", path.join(DEFAULT_DATA_ROOT, "strategy-disposition-campaign"));
export const LEGACY_SOURCES = Object.freeze({
  sol: configuredPath("AICOURT_SOL_LEGACY_SOURCE", path.join(DEFAULT_DATA_ROOT, "legacy", "centauri")),
  theySingBaseline: configuredPath("AICOURT_THEYSING_BASELINE_SOURCE", path.join(DEFAULT_DATA_ROOT, "legacy", "they-sing-baseline")),
  theySingSwap: configuredPath("AICOURT_THEYSING_SWAP_SOURCE", path.join(DEFAULT_DATA_ROOT, "legacy", "they-sing-swap"))
});

export const QUALITY_GATES = Object.freeze({
  validResponseRate: 1,
  fallbackCount: 0,
  legalActionRate: 0.95,
  exactDuplicateTargets: 0,
  behaviorUniqueness: 0.80,
  assistantTokenShare: 0.15,
  brokenCommitmentRateMin: 0.15,
  brokenCommitmentRateMax: 0.40,
  minimumFreeSystemBytes: 512 * 1024 ** 2,
  minimumFreeCampaignBytes: 10 * 1024 ** 3,
  maximumSystemGrowthBytesDuringPilot: 25 * 1024 ** 2
});

export function stableCampaignConfig(overrides = {}) {
  return {
    schema: `${CAMPAIGN_SCHEMA}.config`,
    campaign_version: CAMPAIGN_VERSION,
    tokenizer: "o200k_base",
    targets: structuredClone(TARGETS),
    quality_gates: structuredClone(QUALITY_GATES),
    models: [...MODELS],
    reasoning_efforts: [...REASONING_EFFORTS],
    dispositions: [...PROMPTED_DISPOSITIONS],
    decision_concurrency: 2,
    max_attempts_per_call: 2,
    call_timeout_ms: 1_200_000,
    ...structuredClone(overrides)
  };
}
