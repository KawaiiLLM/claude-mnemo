import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";

/**
 * The era every settlement fixture runs under. Epoch 1 is the smallest value
 * `normalizeEraCutoffEpoch` accepts, so every seeded turn is in the era whatever
 * its timestamp; a fixture that wants a legacy prefix states its own cutoff
 * above the turns it seeds.
 */
export const SETTLEMENT_ERA_CUTOFF_EPOCH = 1;

/**
 * DEFAULT_CONFIG with the era live. The cutover switch is the cutoff, not the
 * kill switch: the product default leaves `eraCutoffEpoch` null — every turn
 * legacy, and legacy turns are settled by nothing — so every test that
 * exercises a trigger names an era explicitly.
 */
export const SETTLEMENT_ENABLED_CONFIG: MnemoConfig = {
  ...DEFAULT_CONFIG,
  settlementEnabled: true,
  eraCutoffEpoch: SETTLEMENT_ERA_CUTOFF_EPOCH,
};

/** The kill switch thrown while the era stays up — the operator's stop button. */
export const SETTLEMENT_KILLED_CONFIG: MnemoConfig = {
  ...SETTLEMENT_ENABLED_CONFIG,
  settlementEnabled: false,
};
