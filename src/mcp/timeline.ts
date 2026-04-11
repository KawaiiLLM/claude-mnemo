import type { Database } from "bun:sqlite";

export interface TimelineInput {
  id: string;
}

export function timelineQuery(_db: Database, _input: TimelineInput): string {
  return "timeline not implemented";
}
