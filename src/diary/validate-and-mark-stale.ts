import type { DiaryStateStore, SettledDiaryDay } from "../db/diary-state";
import type { DiaryFileStore } from "./file-store";

export interface ValidateAndMarkStaleOptions {
  stateStore: Pick<DiaryStateStore, "markDayStaleAndEnqueue">;
  fileStore: Pick<DiaryFileStore, "readValidatedDiary">;
  nowEpoch?: () => number;
}

/** Reads a settled diary canonically and requeues its day on any validation failure. */
export async function validateAndMarkStale(
  options: ValidateAndMarkStaleOptions,
  day: SettledDiaryDay,
): Promise<Uint8Array> {
  try {
    return await options.fileStore.readValidatedDiary(day);
  } catch (error) {
    options.stateStore.markDayStaleAndEnqueue({
      date: day.date,
      enqueuedAtEpoch: options.nowEpoch?.() ?? Math.floor(Date.now() / 1_000),
    });
    throw error;
  }
}
