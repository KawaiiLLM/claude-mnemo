import { randomUUID } from "node:crypto";

import type { DiaryStateStore } from "../db/diary-state";
import {
  collectDiaryCitationRefs,
  diaryDayOf,
  estimateDiaryTokens,
} from "../diary/domain";
import type { DiaryFileStore, PersonaManifest } from "../diary/file-store";
import { validateAndMarkStale } from "../diary/validate-and-mark-stale";
import {
  EXPERIENCE_PUBLISHED_TOKEN_BUDGET,
  measurePublishedPersona,
  PROFILE_PUBLISHED_TOKEN_BUDGET,
} from "../diary/persona-render";
import {
  createCitationLineLocator,
  stripInvalidCitations,
  type CitationValidationReport,
} from "../shared/citation-validation";
import { parseMarkdownSections } from "../shared/markdown-sections";

export interface PersonaDiaryInput {
  date: string;
  content: string;
}

export interface PersonaValidatorFeedback {
  version: 1;
  errors: Array<{
    code: string;
    entryIndexes?: number[];
    tokens?: number;
    limit?: number;
  }>;
}

export type PersonaRunRequest =
  | {
      op: "rebuild";
      diaries: PersonaDiaryInput[];
      accumulator?: {
        userProfile: string;
        experience: string;
      };
      validatorFeedback?: PersonaValidatorFeedback;
    }
  | {
      op: "fold";
      previousPersona: {
        userProfile: string;
        experience: string;
      };
      diaries: PersonaDiaryInput[];
      validatorFeedback?: PersonaValidatorFeedback;
    }
  | {
      op: "rebase";
      previousPersona: {
        userProfile: string;
        experience: string;
      };
      diaries: PersonaDiaryInput[];
      validatorFeedback?: PersonaValidatorFeedback;
    };

export interface CreatePersonaMaintainerOptions {
  stateStore: DiaryStateStore;
  fileStore: DiaryFileStore;
  runPersona(request: PersonaRunRequest): Promise<string>;
  operationId?: () => string;
  nowEpoch?: () => number;
  requestGateTokens?: number;
  requestOverheadTokens?: number;
  accumulatorReserveTokens?: number;
  /** Additional real turn refs available through persona worker tools. */
  allowedTurnRefs?: () => ReadonlySet<string>;
}

export type PersonaMaintenanceResult =
  | "completed"
  | "idle"
  | "deferred"
  | "blocked";

export interface PersonaMaintainer {
  runPersonaMaintenance(): Promise<PersonaMaintenanceResult>;
}

export function decidePersonaOperation(input: {
  cursor: { lastFoldedDate: string | null; foldsSinceRebase: number; rebuildRequested: boolean };
  pendingDates: readonly string[];
  today: string;
}): "rebuild" | "rebase" | "fold" {
  const oldestPending = [...input.pendingDates].sort()[0];
  const ninetyDaysAgo = new Date(
    Date.parse(`${input.today}T00:00:00Z`) - 90 * 24 * 60 * 60 * 1_000,
  ).toISOString().slice(0, 10);
  if (
    input.cursor.rebuildRequested ||
    input.cursor.lastFoldedDate === null ||
    input.pendingDates.length > 30 ||
    (oldestPending !== undefined && oldestPending < ninetyDaysAgo)
  ) {
    return "rebuild";
  }
  if (input.cursor.foldsSinceRebase >= 30 || input.pendingDates.length > 0) {
    return "rebase";
  }
  return "fold";
}

export function selectPersonaInputDays<T extends { date: string }>(input: {
  operation: "rebuild" | "rebase" | "fold";
  settledDays: readonly T[];
  pendingDays: readonly T[];
  lastFoldedDate: string | null;
}): T[] {
  if (input.operation === "rebuild") return [...input.settledDays];
  if (input.operation === "rebase") {
    return Array.from(new Map(
      [...input.settledDays.slice(-30), ...input.pendingDays]
        .map((day) => [day.date, day]),
    ).values()).sort((a, b) => a.date.localeCompare(b.date));
  }
  return input.settledDays
    .filter((day) => day.date > input.lastFoldedDate!)
    .slice(0, 1);
}

const PERSONA_REQUEST_GATE_TOKENS = 150_000;
const PERSONA_REQUEST_OVERHEAD_TOKENS = 12_000;
const MAX_PERSONA_ACCUMULATOR_TOKENS =
  PROFILE_PUBLISHED_TOKEN_BUDGET + EXPERIENCE_PUBLISHED_TOKEN_BUDGET;

function requestTokens(
  request: PersonaRunRequest,
  overheadTokens: number,
): number {
  return overheadTokens + estimateDiaryTokens(JSON.stringify(request));
}

function planDiaryBatches(
  operationKind: "rebuild" | "fold" | "rebase",
  diaries: PersonaDiaryInput[],
  previousPersona: { userProfile: string; experience: string } | null,
  gateTokens: number,
  overheadTokens: number,
  accumulatorReserveTokens: number,
): PersonaDiaryInput[][] {
  const batches: PersonaDiaryInput[][] = [];
  let current: PersonaDiaryInput[] = [];

  for (const diary of diaries) {
    const candidate = [...current, diary];
    const isLaterBatch = batches.length > 0;
    const request: PersonaRunRequest =
      isLaterBatch || operationKind === "rebuild" || previousPersona === null
        ? { op: "rebuild", diaries: candidate }
        : { op: operationKind, previousPersona, diaries: candidate };
    const reserve =
      isLaterBatch ? accumulatorReserveTokens : 0;
    if (requestTokens(request, overheadTokens) + reserve <= gateTokens) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error(`persona diary exceeds request gate: ${diary.date}`);
    }
    batches.push(current);
    current = [diary];
    const singleRequest: PersonaRunRequest = { op: "rebuild", diaries: current };
    if (
      requestTokens(singleRequest, overheadTokens) +
        accumulatorReserveTokens >
      gateTokens
    ) {
      throw new Error(`persona diary with accumulator exceeds request gate: ${diary.date}`);
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function isMissingCurrentManifest(error: unknown): boolean {
  const nodeError = error as NodeJS.ErrnoException;
  return (
    nodeError?.code === "ENOENT" &&
    typeof nodeError.path === "string" &&
    /[/\\]persona[/\\]CURRENT$/.test(nodeError.path)
  );
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function loadCurrentPersonaIfPresent(
  fileStore: DiaryFileStore,
  stateStore: DiaryStateStore,
) {
  try {
    return await fileStore.loadCurrentPersona();
  } catch (error) {
    if (isMissingCurrentManifest(error)) {
      return null;
    }
    stateStore.requestPersonaRebuild();
    return null;
  }
}

function readPublishedOperationState(manifest: PersonaManifest): {
  operationId: string;
  lastFoldedDate: string;
  foldsSinceRebase: number;
  consumedPendingDates: string[];
} {
  const operationId = manifest.operation_id;
  const lastFoldedDate = manifest.last_folded_date_after;
  const foldsSinceRebase = manifest.folds_since_rebase_after;
  const consumedPendingDates = manifest.consumed_pending_dates;
  if (
    typeof operationId !== "string" ||
    typeof lastFoldedDate !== "string" ||
    !Number.isSafeInteger(foldsSinceRebase) ||
    (foldsSinceRebase as number) < 0 ||
    !Array.isArray(consumedPendingDates) ||
    !consumedPendingDates.every((date) => typeof date === "string")
  ) {
    throw new Error("Invalid published persona operation manifest");
  }

  return {
    operationId,
    lastFoldedDate,
    foldsSinceRebase: foldsSinceRebase as number,
    consumedPendingDates,
  };
}

function readEnvelopeBlock(
  raw: string,
  name: "USER_PROFILE" | "EXPERIENCE",
): string {
  const begin = `===${name}_V1_BEGIN===`;
  const end = `===${name}_V1_END===`;
  if (
    raw.split(begin).length - 1 !== 1 ||
    raw.split(end).length - 1 !== 1
  ) {
    throw new Error(`invalid persona envelope: ${name}`);
  }

  const contentStart = raw.indexOf(begin) + begin.length + 1;
  const contentEnd = raw.indexOf(`\n${end}`, contentStart);
  if (contentEnd < contentStart) {
    throw new Error(`invalid persona envelope: ${name}`);
  }

  const content = raw.slice(contentStart, contentEnd);
  if (!parseMarkdownSections(content).some((section) => section.level >= 1)) {
    throw new Error(`missing persona heading: ${name}`);
  }
  return content;
}

export function parsePersonaEnvelope(raw: string): {
  userProfile: string;
  experience: string;
} {
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const userBegin = "===USER_PROFILE_V1_BEGIN===";
  const userEnd = "===USER_PROFILE_V1_END===";
  const experienceBegin = "===EXPERIENCE_V1_BEGIN===";
  const experienceEnd = "===EXPERIENCE_V1_END===";
  const userProfile = readEnvelopeBlock(normalized, "USER_PROFILE");
  const experience = readEnvelopeBlock(normalized, "EXPERIENCE");
  if (
    !normalized.startsWith(`${userBegin}\n`) ||
    !normalized.endsWith(`\n${experienceEnd}`) ||
    normalized.indexOf(`\n${userEnd}\n${experienceBegin}\n`) < 0
  ) {
    throw new Error("invalid persona envelope ordering");
  }
  return {
    userProfile,
    experience,
  };
}

class PersonaValidationError extends Error {
  constructor(readonly feedback: PersonaValidatorFeedback) {
    super(`persona validator feedback: ${JSON.stringify(feedback)}`);
  }
}

function requestSources(request: PersonaRunRequest): string[] {
  const sources = request.diaries.map((diary) => diary.content);
  if ("previousPersona" in request) {
    sources.push(request.previousPersona.userProfile, request.previousPersona.experience);
  }
  if ("accumulator" in request && request.accumulator) {
    sources.push(request.accumulator.userProfile, request.accumulator.experience);
  }
  return sources;
}

function stripPersonaDocumentCitations(
  document: string,
  documentName: string,
  allowedRefs: ReadonlySet<string>,
) {
  const lines = document.split("\n");
  const sectionByLine: string[] = [];
  let mappedLine = 0;
  for (const section of parseMarkdownSections(document)) {
    if (section.level >= 1) {
      sectionByLine[mappedLine] = `${documentName}/${section.title}`;
      mappedLine += 1;
    }
    for (let index = 0; index < section.bodyLines.length; index += 1) {
      sectionByLine[mappedLine] = section.level >= 1
        ? `${documentName}/${section.title}`
        : documentName;
      mappedLine += 1;
    }
  }
  const locateLine = createCitationLineLocator(document);
  return stripInvalidCitations(document, allowedRefs, (citationOffset) => {
    const { lineIndex, line } = locateLine(citationOffset);
    return { section: sectionByLine[lineIndex] ?? documentName, line };
  });
}

function sanitizePersonaOutput(
  persona: { userProfile: string; experience: string },
  request: PersonaRunRequest,
  additionalAllowedTurnRefs: ReadonlySet<string> = new Set(),
): { persona: { userProfile: string; experience: string }; report: CitationValidationReport } {
  const allowedTurnRefs = collectDiaryCitationRefs(requestSources(request));
  for (const ref of additionalAllowedTurnRefs) allowedTurnRefs.add(ref);
  const profile = stripPersonaDocumentCitations(persona.userProfile, "USER_PROFILE", allowedTurnRefs);
  const experience = stripPersonaDocumentCitations(persona.experience, "EXPERIENCE", allowedTurnRefs);
  const sanitized = { userProfile: profile.text, experience: experience.text };
  const errors: PersonaValidatorFeedback["errors"] = [];
  const measured = measurePublishedPersona(sanitized);
  if (measured.profileTokens > PROFILE_PUBLISHED_TOKEN_BUDGET) {
    errors.push({ code: "profile_budget", tokens: measured.profileTokens, limit: PROFILE_PUBLISHED_TOKEN_BUDGET });
  }
  if (measured.experienceTokens > EXPERIENCE_PUBLISHED_TOKEN_BUDGET) {
    errors.push({ code: "experience_budget", tokens: measured.experienceTokens, limit: EXPERIENCE_PUBLISHED_TOKEN_BUDGET });
  }
  if (errors.length > 0) throw new PersonaValidationError({ version: 1, errors });
  return {
    persona: sanitized,
    report: {
      version: 2,
      total: profile.report.total + experience.report.total,
      stripped: profile.report.stripped + experience.report.stripped,
      items: [...profile.report.items, ...experience.report.items],
    },
  };
}

export function validatePersonaEnvelopeForRequest(
  raw: string,
  request: PersonaRunRequest,
): { userProfile: string; experience: string } {
  const persona = parsePersonaEnvelope(raw);
  return sanitizePersonaOutput(persona, request).persona;
}

function feedbackFromLastError(lastError: string | null | undefined): PersonaValidatorFeedback | undefined {
  if (!lastError?.startsWith("persona validator feedback: ")) return undefined;
  try {
    const value = JSON.parse(lastError.slice("persona validator feedback: ".length)) as PersonaValidatorFeedback;
    return value.version === 1 && Array.isArray(value.errors) ? value : undefined;
  } catch { return undefined; }
}

export function createPersonaMaintainer(
  options: CreatePersonaMaintainerOptions,
): PersonaMaintainer {
  return {
    async runPersonaMaintenance(): Promise<PersonaMaintenanceResult> {
      const nowEpoch =
        options.nowEpoch?.() ?? Math.floor(Date.now() / 1_000);
      let activeOperation = options.stateStore.getPersonaOperation();
      if (activeOperation !== null) {
        let publishedPersona = null;
        try {
          publishedPersona = await options.fileStore.loadPersonaGeneration(
            activeOperation.targetGeneration,
          );
        } catch (error) {
          if (!isMissingFile(error)) {
            options.stateStore.requestPersonaRebuild();
          }
          await options.fileStore.deletePersonaGeneration(
            activeOperation.targetGeneration,
          );
        }
        if (
          publishedPersona !== null &&
          publishedPersona.manifest.operation_id === activeOperation.operationId
        ) {
          const published = readPublishedOperationState(
            publishedPersona.manifest,
          );
          await options.fileStore.publishPersonaCurrent(
            publishedPersona.generation,
          );
          options.stateStore.commitPersonaCursor({
            lastFoldedDate: published.lastFoldedDate,
            lastAppliedOperationId: published.operationId,
            foldsSinceRebase: published.foldsSinceRebase,
            confirmedRebuildEpoch: activeOperation.rebuildRequestEpoch,
            consumedPendingDays: activeOperation.consumedPendingDays,
          });
          options.stateStore.completePersonaOperation(activeOperation.operationId);
          return "completed";
        }
        if (activeOperation.terminal) {
          // A terminal tombstone must not deadlock persona maintenance forever
          // (the analogue of the diary terminal-day trap). Discard it only when
          // its frozen inputs are stale — diary days now await a rebase that this
          // operation never attempted, or a fresh rebuild was requested after it
          // failed. Otherwise stay blocked so a genuinely unrecoverable operation
          // does not hot-loop the agent.
          const terminalSnapshot = new Set(activeOperation.inputDatesSnapshot);
          const hasNewPendingWork = options.stateStore
            .listPendingRebaseDays()
            .some((day) => !terminalSnapshot.has(day.date));
          const rebuildRequestedAfterFailure =
            options.stateStore.getPersonaCursor().rebuildRequestEpoch >
            activeOperation.rebuildRequestEpoch;
          if (!hasNewPendingWork && !rebuildRequestedAfterFailure) {
            return "blocked";
          }
          options.stateStore.completePersonaOperation(activeOperation.operationId);
          activeOperation = null;
        }
      }

      const cursor = options.stateStore.getPersonaCursor();
      const pendingRebaseDays = options.stateStore.listPendingRebaseDays();
      const scheduledOperation = activeOperation?.op ?? decidePersonaOperation({
        cursor,
        pendingDates: pendingRebaseDays.map((day) => day.date),
        today: diaryDayOf(nowEpoch),
      });
      const currentPersona =
        activeOperation !== null && activeOperation.inputArtifactDir !== ""
          ? null
          : await loadCurrentPersonaIfPresent(
              options.fileStore,
              options.stateStore,
            );
      const personaWasCorrupt =
        currentPersona === null &&
        options.stateStore.getPersonaCursor().rebuildRequested;
      const operationId =
        activeOperation?.operationId ?? (options.operationId ?? randomUUID)();
      const operationKind =
        personaWasCorrupt ? "rebuild" : scheduledOperation;
      const isRebuild = operationKind === "rebuild";
      const isRebase = operationKind === "rebase";
      const rebuildGate = isRebuild
        ? options.stateStore.getPersonaRebuildGate(diaryDayOf(nowEpoch))
        : { blockingDates: [], partialMissingDates: [] };
      const frozenPartialMissingDates = activeOperation?.partialMissingDates ?? (
        isRebuild
          ? rebuildGate.partialMissingDates
          : Array.isArray(currentPersona?.manifest.partial_missing_dates_after)
            ? currentPersona.manifest.partial_missing_dates_after.filter((date): date is string => typeof date === "string")
            : []
      );
      const frozenRebuildRequestEpoch = activeOperation?.rebuildRequestEpoch ?? cursor.rebuildRequestEpoch;
      if (activeOperation === null && rebuildGate.blockingDates.length > 0) {
        return "deferred";
      }
      const baseCurrentOperationId =
        activeOperation !== null && activeOperation.inputArtifactDir !== ""
          ? activeOperation.baseCurrentOperationId
          : typeof currentPersona?.manifest.operation_id === "string"
            ? currentPersona.manifest.operation_id
            : null;
      const baseGeneration =
        activeOperation !== null && activeOperation.inputArtifactDir !== ""
          ? activeOperation.baseGeneration
          : currentPersona?.generation ?? 0;
      const targetGeneration =
        activeOperation !== null && activeOperation.inputArtifactDir !== ""
          ? activeOperation.targetGeneration
          : baseGeneration + 1;
      const requestGateTokens =
        options.requestGateTokens ?? PERSONA_REQUEST_GATE_TOKENS;
      const requestOverheadTokens =
        options.requestOverheadTokens ?? PERSONA_REQUEST_OVERHEAD_TOKENS;
      const accumulatorReserveTokens =
        options.accumulatorReserveTokens ?? MAX_PERSONA_ACCUMULATOR_TOKENS;
      let inputArtifactDir = activeOperation?.inputArtifactDir ?? "";
      let batchPlan = activeOperation?.batchPlan ?? [];
      let inputSnapshot;

      if (inputArtifactDir === "") {
        const settledDays = options.stateStore.listSettledDays();
        if (settledDays.length === 0) {
          return "idle";
        }
        const selectedDays = activeOperation
          ? activeOperation.inputDatesSnapshot.map((date) => {
              const day = settledDays.find((candidate) => candidate.date === date);
              if (!day) {
                throw new Error(`persona input date is no longer settled: ${date}`);
              }
              return day;
            })
          : selectPersonaInputDays({
              operation: operationKind,
              settledDays,
              pendingDays: pendingRebaseDays,
              lastFoldedDate: cursor.lastFoldedDate,
            });
        if (selectedDays.length === 0) {
          return "idle";
        }
        const frozenDiaries: Array<{
          date: string;
          bytes: Uint8Array;
          content: string;
        }> = [];
        for (const day of selectedDays) {
          let bytes: Uint8Array;
          try {
            bytes = await validateAndMarkStale(options, day);
          } catch {
            return "deferred";
          }
          frozenDiaries.push({
            date: day.date,
            bytes,
            content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          });
        }
        const baseline =
          operationKind === "rebuild" || currentPersona === null
            ? null
            : {
                userProfile: currentPersona.userProfile,
                experience: currentPersona.experience,
              };
        const plannedBatches = planDiaryBatches(
          operationKind,
          frozenDiaries.map(({ date, content }) => ({ date, content })),
          baseline,
          requestGateTokens,
          requestOverheadTokens,
          accumulatorReserveTokens,
        );
        batchPlan = plannedBatches.map((batch) =>
          batch.map((diary) => diary.date),
        );
        inputArtifactDir = await options.fileStore.freezePersonaOperationInputs({
          operationId,
          baseCurrentOperationId,
          diaries: frozenDiaries.map(({ date, bytes }) => ({ date, bytes })),
          baseline,
          consumedPendingDays: isRebase ? (activeOperation?.consumedPendingDays ?? pendingRebaseDays) : [],
          rebuildRequestEpoch: frozenRebuildRequestEpoch,
          partialMissingDates: frozenPartialMissingDates,
        });
        if (activeOperation === null) {
          options.stateStore.beginPersonaOperation({
            operationId,
            op: operationKind,
            baseCurrentOperationId,
            baseGeneration,
            targetGeneration,
            inputDatesSnapshot: selectedDays.map((day) => day.date),
            consumedPendingDays: isRebase ? pendingRebaseDays : [],
            rebuildRequestEpoch: frozenRebuildRequestEpoch,
            partialMissingDates: frozenPartialMissingDates,
            batchPlan,
            inputArtifactDir,
          });
        } else {
          options.stateStore.initializePersonaOperationArtifacts({
            operationId,
            baseCurrentOperationId,
            baseGeneration,
            targetGeneration,
            batchPlan,
            inputArtifactDir,
          });
        }
      }

      try {
        inputSnapshot = await options.fileStore.loadPersonaOperationInputs(
          inputArtifactDir,
          operationId,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.stateStore.terminalPersonaOperation(operationId, message);
        return "blocked";
      }
      if (inputSnapshot.baseCurrentOperationId !== baseCurrentOperationId) {
        options.stateStore.terminalPersonaOperation(
          operationId,
          "persona baseline snapshot does not match operation state",
        );
        return "blocked";
      }
      const diariesByDate = new Map(
        inputSnapshot.diaries.map((diary) => [diary.date, diary]),
      );
      const batches = batchPlan.map((dates) =>
        dates.map((date) => {
          const diary = diariesByDate.get(date);
          if (!diary) {
            throw new Error(`persona batch plan references missing input: ${date}`);
          }
          return diary;
        }),
      );
      const selectedDates = inputSnapshot.diaries.map((diary) => diary.date);
      let nextBatchIndex = activeOperation?.nextBatchIndex ?? 0;
      let accumulator: { userProfile: string; experience: string } | null = null;
      let validationReport: CitationValidationReport = {
        version: 2,
        total: 0,
        stripped: 0,
        items: [],
      };
      if (nextBatchIndex > 0) {
        if (
          activeOperation === null ||
          activeOperation.accumulatorGeneration === null ||
          activeOperation.accumulatorHash === null ||
          activeOperation.checkpointPath === null ||
          activeOperation.checkpointSha256 === null
        ) {
          options.stateStore.terminalPersonaOperation(
            operationId,
            "persona checkpoint pointer is incomplete",
          );
          return "blocked";
        }
        try {
          const checkpoint = await options.fileStore.loadPersonaCheckpoint({
            operationId,
            accumulatorGeneration: activeOperation.accumulatorGeneration,
            accumulatorHash: activeOperation.accumulatorHash,
            checkpointPath: activeOperation.checkpointPath,
            checkpointSha256: activeOperation.checkpointSha256,
            nextBatchIndex,
          });
          accumulator = {
            userProfile: checkpoint.userProfile,
            experience: checkpoint.experience,
          };
          validationReport = checkpoint.validationReport;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.stateStore.terminalPersonaOperation(operationId, message);
          return "blocked";
        }
      }
      if (
        activeOperation?.nextAttemptEpoch !== null &&
        activeOperation?.nextAttemptEpoch !== undefined &&
        activeOperation.nextAttemptEpoch > nowEpoch
      ) {
        return "deferred";
      }
      try {
        for (let batchIndex = nextBatchIndex; batchIndex < batches.length; batchIndex += 1) {
          const batch = batches[batchIndex]!;
          const retryFeedback = batchIndex === nextBatchIndex
            ? feedbackFromLastError(activeOperation?.lastError)
            : undefined;
          const request: PersonaRunRequest =
            operationKind === "rebuild"
              ? {
                  op: "rebuild",
                  diaries: batch,
                  ...(accumulator === null ? {} : { accumulator }),
                  ...(retryFeedback ? { validatorFeedback: retryFeedback } : {}),
                }
              : {
                  op: operationKind,
                  previousPersona:
                    accumulator ?? inputSnapshot.baseline!,
                  diaries: batch,
                  ...(retryFeedback ? { validatorFeedback: retryFeedback } : {}),
                };
          if (requestTokens(request, requestOverheadTokens) > requestGateTokens) {
            throw new Error("persona request exceeds 150K gate");
          }
          const raw = await options.runPersona(request);
          const validated = sanitizePersonaOutput(
            parsePersonaEnvelope(raw),
            request,
            options.allowedTurnRefs?.(),
          );
          accumulator = validated.persona;
          validationReport = {
            version: 2,
            total: validationReport.total + validated.report.total,
            stripped: validationReport.stripped + validated.report.stripped,
            items: [...validationReport.items, ...validated.report.items],
          };
          nextBatchIndex = batchIndex + 1;
          const pointer = await options.fileStore.commitPersonaCheckpoint({
            operationId,
            accumulatorGeneration: nextBatchIndex,
            nextBatchIndex,
            accumulator,
            validationReport,
          });
          options.stateStore.advancePersonaCheckpoint({
            operationId,
            ...pointer,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        options.stateStore.recordPersonaOperationFailure({
          operationId,
          error: message,
          nextAttemptEpoch: nowEpoch + 60,
        });
        throw error;
      }
      const userProfile = accumulator!.userProfile;
      const experience = accumulator!.experience;
      const lastFoldedDate = isRebase
        ? cursor.lastFoldedDate!
        : selectedDates.at(-1)!;
      const sourceDiaryDate = isRebase
        ? inputSnapshot.consumedPendingDates[0] ?? selectedDates.at(-1)!
        : selectedDates.at(-1)!;
      const generation = targetGeneration;
      const foldsSinceRebase = isRebuild || isRebase
        ? 0
        : cursor.foldsSinceRebase + 1;
      const consumedPendingDates = isRebase
        ? inputSnapshot.consumedPendingDates
        : [];
      const absorbedDates = new Set(selectedDates);
      const partialMissingDatesAfter = isRebuild
        ? inputSnapshot.partialMissingDates
        : isRebase
          ? inputSnapshot.partialMissingDates.filter((date) => !absorbedDates.has(date))
          : inputSnapshot.partialMissingDates;
      const manifest = {
        operation_id: operationId,
        op: operationKind,
        generation,
        source_diary_date: sourceDiaryDate,
        last_folded_date_after: lastFoldedDate,
        folds_since_rebase_after: foldsSinceRebase,
        consumed_pending_dates: consumedPendingDates,
        partial_missing_dates_after: partialMissingDatesAfter,
        validation_report: validationReport,
      };

      await options.fileStore.commitPersonaGeneration({
        generation,
        manifest,
        userProfile,
        experience,
      });
      options.stateStore.commitPersonaCursor({
        lastFoldedDate,
        lastAppliedOperationId: operationId,
        foldsSinceRebase,
        confirmedRebuildEpoch: inputSnapshot.rebuildRequestEpoch,
        consumedPendingDays: inputSnapshot.consumedPendingDays,
      });
      options.stateStore.completePersonaOperation(operationId);
      return "completed";
    },
  };
}
