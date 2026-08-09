import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";

/**
 * DEFAULT_CONFIG with the P2 settlement kill switch flipped on. The product
 * default is off — merging the machinery must not perturb the P1 shadow trial —
 * so every test that exercises a settlement trigger opts in explicitly.
 */
export const SETTLEMENT_ENABLED_CONFIG: MnemoConfig = {
  ...DEFAULT_CONFIG,
  settlementEnabled: true,
};
