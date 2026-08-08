import { DEFAULT_CONFIG, type MnemoConfig } from "../../src/shared/config";

/**
 * DEFAULT_CONFIG with the dream kill switch flipped on. The product default is
 * off, so every test that exercises dream enqueue/execution opts in explicitly.
 */
export const DREAM_ENABLED_CONFIG: MnemoConfig = {
  ...DEFAULT_CONFIG,
  dreamAgentEnabled: true,
};
