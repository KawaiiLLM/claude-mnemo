/**
 * 05a — the candidate parameterisations the ticket asks to be MEASURED, not
 * chosen. Every one of them is a value of the same two open keys; nothing else
 * about the election moves between them.
 *
 * A is the shipped default and must reproduce HEAD byte for byte.
 */
import type { ElectionRelationParameters } from "../../../../src/shared/election-relation-weights";

export interface Candidate {
  id: string;
  label: string;
  parameters: ElectionRelationParameters;
}

export const CANDIDATES: Record<string, Candidate> = {
  A: {
    id: "A",
    label: "default / interim-equivalent (use reads each retired word's own weight; only a stored `indexes` declares)",
    parameters: { use: { kind: "retired-words" }, convergence: { kind: "retired-indexes" } },
  },
  B: {
    id: "B",
    label: "use = `grounds`' weights (1 out / 2 in), uniform over every use edge",
    parameters: { use: { kind: "uniform", out: 1, in: 2 }, convergence: { kind: "retired-indexes" } },
  },
  C: {
    id: "C",
    label: "use = `indexes`' weights (2 out / 1 in), uniform over every use edge",
    parameters: { use: { kind: "uniform", out: 2, in: 1 }, convergence: { kind: "retired-indexes" } },
  },
  D: {
    id: "D",
    label: "use = the arithmetic mean of its four sources (0.75 out / 0.75 in)",
    parameters: {
      use: { kind: "uniform", out: 0.75, in: 0.75 },
      convergence: { kind: "retired-indexes" },
    },
  },
  E3: {
    id: "E3",
    label: "T2306 proxy — a node declares convergence at use out-degree >= 3 (use weights unchanged)",
    parameters: { use: { kind: "retired-words" }, convergence: { kind: "use-out-degree", threshold: 3 } },
  },
  E5: {
    id: "E5",
    label: "T2306 proxy — threshold 5",
    parameters: { use: { kind: "retired-words" }, convergence: { kind: "use-out-degree", threshold: 5 } },
  },
  E8: {
    id: "E8",
    label: "T2306 proxy — threshold 8",
    parameters: { use: { kind: "retired-words" }, convergence: { kind: "use-out-degree", threshold: 8 } },
  },
};
