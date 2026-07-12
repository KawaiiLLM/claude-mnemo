import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FrozenPendingRebaseDay } from "../db/diary-state";
import type { CitationValidationReport } from "../shared/citation-validation";
import {
  DIARY_SECTION_HEADINGS,
  validateDiaryDocument,
} from "./domain";

export interface ValidatedDiaryState {
  date: string;
  watermark: string;
  indexHook: string;
  fileSha256: string;
}

export interface DiaryIndexRow {
  date: string;
  indexHook: string | null;
}

export interface PersonaManifest {
  generation: number;
  user_profile_sha256: string;
  experience_sha256: string;
  [key: string]: unknown;
}

export interface PersonaGenerationInput {
  generation: number;
  manifest: {
    generation: number;
    [key: string]: unknown;
  };
  userProfile: string;
  experience: string;
}

export interface LoadedPersona {
  generation: number;
  manifest: PersonaManifest;
  userProfile: string;
  experience: string;
}

export interface CurrentPersonaMaterialBlocks {
  userProfile: string | null;
  experience: string | null;
}

export interface PersonaCoverage {
  lastFoldedDate: string | null;
  partialMissingDates: string[];
}

export interface PersonaOperationInputSnapshot {
  operationId: string;
  baseCurrentOperationId: string | null;
  diaries: Array<{ date: string; content: string }>;
  baseline: { userProfile: string; experience: string } | null;
  consumedPendingDates: string[];
  consumedPendingDays: FrozenPendingRebaseDay[];
  rebuildRequestEpoch: number;
  partialMissingDates: string[];
}

export interface PersonaCheckpointPointer {
  accumulatorGeneration: number;
  accumulatorHash: string;
  checkpointPath: string;
  checkpointSha256: string;
  nextBatchIndex: number;
}

interface PersonaInputManifest {
  version: 1;
  operation_id: string;
  base_current_operation_id: string | null;
  diaries: Array<{ date: string; file: string; sha256: string }>;
  baseline: null | {
    user_profile_file: string;
    user_profile_sha256: string;
    experience_file: string;
    experience_sha256: string;
  };
  consumed_pending_dates: FrozenPendingRebaseDay[];
  rebuild_request_epoch: number;
  partial_missing_dates: string[];
}

interface PersonaCheckpointManifest {
  version: 1;
  operation_id: string;
  next_batch_index: number;
  accumulator_generation: number;
  accumulator_file: string;
  accumulator_hash: string;
}

function assertDiaryDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid diary date: ${date}`);
  }
}

function readFrontmatterString(lines: string[], field: string): string {
  const prefix = `${field}: `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`Invalid diary frontmatter field: ${field}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(matches[0]!.slice(prefix.length));
  } catch {
    throw new Error(`Invalid diary frontmatter field: ${field}`);
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid diary frontmatter field: ${field}`);
  }
  return value;
}

export class DiaryFileStore {
  constructor(readonly dataRoot: string) {}

  async commitDiary(date: string, canonicalBytes: Uint8Array): Promise<void> {
    assertDiaryDate(date);
    await this.assertDiaryRootIsNotSymlink();
    const diaryPath = join(this.dataRoot, "diary", `${date}.md`);
    await this.assertPathIsNotSymlink(diaryPath);
    await this.commitAtomically(diaryPath, canonicalBytes);
  }

  private async commitAtomically(
    finalPath: string,
    canonicalBytes: Uint8Array,
  ): Promise<void> {
    const parentPath = dirname(finalPath);
    const temporaryPath = join(
      parentPath,
      `.${basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    await mkdir(parentPath, { recursive: true });

    try {
      const temporaryFile = await open(temporaryPath, "wx");
      try {
        await temporaryFile.writeFile(canonicalBytes);
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }

      await rename(temporaryPath, finalPath);

      await this.syncDirectory(parentPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async readDiary(date: string): Promise<Uint8Array> {
    assertDiaryDate(date);
    await this.assertDiaryRootIsNotSymlink();
    const diaryPath = join(this.dataRoot, "diary", `${date}.md`);
    await this.assertPathIsNotSymlink(diaryPath);
    return readFile(diaryPath);
  }

  async deleteDiary(date: string): Promise<void> {
    assertDiaryDate(date);
    await this.assertDiaryRootIsNotSymlink();
    const diaryPath = join(this.dataRoot, "diary", `${date}.md`);
    await this.assertPathIsNotSymlink(diaryPath);
    try {
      await unlink(diaryPath);
      await this.syncDirectory(join(this.dataRoot, "diary"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private async assertDiaryRootIsNotSymlink(): Promise<void> {
    const diaryRoot = join(this.dataRoot, "diary");
    try {
      const metadata = await lstat(diaryRoot);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Diary root must not be a symlink: ${diaryRoot}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private async assertPathIsNotSymlink(path: string): Promise<void> {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Diary path must not be a symlink: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async readValidatedDiary(expected: ValidatedDiaryState): Promise<Uint8Array> {
    const bytes = await this.readDiary(expected.date);
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expected.fileSha256) {
      throw new Error(`Diary hash mismatch: ${expected.date}`);
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Diary is not valid UTF-8: ${expected.date}`);
    }
    const lines = text.split("\n");
    const documentValidation = validateDiaryDocument(text);
    if (!documentValidation.ok) {
      throw new Error(
        `Invalid diary document (${documentValidation.code}): ${expected.date}`,
      );
    }
    if (lines[0] !== "---") {
      throw new Error(`Invalid diary frontmatter: ${expected.date}`);
    }
    const frontmatterEnd = lines.indexOf("---", 1);
    if (frontmatterEnd < 0) {
      throw new Error(`Invalid diary frontmatter: ${expected.date}`);
    }

    const frontmatter = lines.slice(1, frontmatterEnd);
    if (
      readFrontmatterString(frontmatter, "date") !== expected.date ||
      readFrontmatterString(frontmatter, "watermark") !== expected.watermark ||
      readFrontmatterString(frontmatter, "index_hook") !== expected.indexHook
    ) {
      throw new Error(`Diary state mismatch: ${expected.date}`);
    }

    const headings = lines
      .slice(frontmatterEnd + 1)
      .filter((line) => line.startsWith("## "));
    if (
      headings.length !== DIARY_SECTION_HEADINGS.length ||
      headings.some((heading, index) => heading !== DIARY_SECTION_HEADINGS[index])
    ) {
      throw new Error(`Invalid diary section structure: ${expected.date}`);
    }

    return bytes;
  }

  async ensureIndex(rows: DiaryIndexRow[]): Promise<Uint8Array> {
    await this.assertDiaryRootIsNotSymlink();
    const indexPath = join(this.dataRoot, "diary", "INDEX.md");
    await this.assertPathIsNotSymlink(indexPath);
    const lines = rows
      .filter((row): row is DiaryIndexRow & { indexHook: string } =>
        row.indexHook !== null
      )
      .sort((left, right) => right.date.localeCompare(left.date))
      .map((row) => `- ${row.date}：${row.indexHook}`);
    const canonicalBytes = new TextEncoder().encode(
      ["# Diary Index", ...lines, ""].join("\n"),
    );

    try {
      const existingBytes = await this.readIndex();
      if (
        existingBytes.length === canonicalBytes.length &&
        existingBytes.every((byte, index) => byte === canonicalBytes[index])
      ) {
        return canonicalBytes;
      }
    } catch {
      // Missing index is repaired by the atomic publication below.
    }

    await this.commitAtomically(indexPath, canonicalBytes);
    return canonicalBytes;
  }

  async readIndex(): Promise<Uint8Array> {
    await this.assertDiaryRootIsNotSymlink();
    const indexPath = join(this.dataRoot, "diary", "INDEX.md");
    await this.assertPathIsNotSymlink(indexPath);
    return readFile(indexPath);
  }

  async commitPersonaGeneration(input: PersonaGenerationInput): Promise<void> {
    if (
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.manifest.generation !== input.generation
    ) {
      throw new Error("Invalid persona generation");
    }

    const userProfileBytes = new TextEncoder().encode(input.userProfile);
    const experienceBytes = new TextEncoder().encode(input.experience);
    const manifest = {
      ...input.manifest,
      user_profile_sha256: createHash("sha256").update(userProfileBytes).digest("hex"),
      experience_sha256: createHash("sha256").update(experienceBytes).digest("hex"),
    };
    const manifestBytes = new TextEncoder().encode(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const personaRoot = join(this.dataRoot, "persona");
    const generationsRoot = join(personaRoot, "generations");
    const generationRoot = join(generationsRoot, String(input.generation));
    const temporaryGenerationRoot = join(
      generationsRoot,
      `.${input.generation}.${randomUUID()}.tmp`,
    );

    await mkdir(generationsRoot, { recursive: true });
    await this.syncDirectory(generationsRoot);
    await this.syncDirectory(personaRoot);
    await this.syncDirectory(this.dataRoot);
    await mkdir(temporaryGenerationRoot);

    try {
      await this.commitAtomically(
        join(temporaryGenerationRoot, "manifest.json"),
        manifestBytes,
      );
      await this.commitAtomically(
        join(temporaryGenerationRoot, "user-profile.md"),
        userProfileBytes,
      );
      await this.commitAtomically(
        join(temporaryGenerationRoot, "experience.md"),
        experienceBytes,
      );
      await this.syncDirectory(temporaryGenerationRoot);
      await rename(temporaryGenerationRoot, generationRoot);
      await this.syncDirectory(generationsRoot);
    } catch (error) {
      await rm(temporaryGenerationRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }

    await this.publishPersonaCurrent(input.generation);
  }

  /** Idempotently publishes an already-complete generation as CURRENT. */
  async publishPersonaCurrent(generation: number): Promise<void> {
    const loaded = await this.loadPersonaGeneration(generation);
    const manifestBytes = new TextEncoder().encode(
      `${JSON.stringify(loaded.manifest, null, 2)}\n`,
    );
    const personaRoot = join(this.dataRoot, "persona");
    await this.commitAtomically(join(personaRoot, "CURRENT"), manifestBytes);
    const published = await this.loadCurrentPersona();
    if (
      published.generation !== generation ||
      published.manifest.user_profile_sha256 !== loaded.manifest.user_profile_sha256 ||
      published.manifest.experience_sha256 !== loaded.manifest.experience_sha256
    ) {
      throw new Error("Persona CURRENT re-validation failed");
    }
  }

  async freezePersonaOperationInputs(input: {
    operationId: string;
    baseCurrentOperationId: string | null;
    diaries: Array<{ date: string; bytes: Uint8Array }>;
    baseline: { userProfile: string; experience: string } | null;
    consumedPendingDays: readonly FrozenPendingRebaseDay[];
    rebuildRequestEpoch: number;
    partialMissingDates: readonly string[];
  }): Promise<string> {
    this.assertPersonaOperationId(input.operationId);
    const operationRoot = join(
      this.dataRoot,
      "persona",
      "operations",
      input.operationId,
    );
    const inputRoot = join(operationRoot, "inputs");
    await mkdir(operationRoot, { recursive: true });
    await mkdir(inputRoot);

    const manifest: PersonaInputManifest = {
      version: 1,
      operation_id: input.operationId,
      base_current_operation_id: input.baseCurrentOperationId,
      diaries: [],
      baseline: null,
      consumed_pending_dates: [...input.consumedPendingDays],
      rebuild_request_epoch: input.rebuildRequestEpoch,
      partial_missing_dates: [...input.partialMissingDates],
    };
    for (const [index, diary] of input.diaries.entries()) {
      assertDiaryDate(diary.date);
      const file = `diary-${String(index).padStart(4, "0")}-${diary.date}.md`;
      await this.commitAtomically(join(inputRoot, file), diary.bytes);
      manifest.diaries.push({
        date: diary.date,
        file,
        sha256: createHash("sha256").update(diary.bytes).digest("hex"),
      });
    }

    if (input.baseline !== null) {
      const userProfileBytes = new TextEncoder().encode(
        input.baseline.userProfile,
      );
      const experienceBytes = new TextEncoder().encode(input.baseline.experience);
      await this.commitAtomically(
        join(inputRoot, "baseline-user-profile.md"),
        userProfileBytes,
      );
      await this.commitAtomically(
        join(inputRoot, "baseline-experience.md"),
        experienceBytes,
      );
      manifest.baseline = {
        user_profile_file: "baseline-user-profile.md",
        user_profile_sha256: createHash("sha256")
          .update(userProfileBytes)
          .digest("hex"),
        experience_file: "baseline-experience.md",
        experience_sha256: createHash("sha256").update(experienceBytes).digest("hex"),
      };
    }

    await this.commitAtomically(
      join(inputRoot, "manifest.json"),
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    );
    await this.syncDirectory(inputRoot);
    await this.syncDirectory(operationRoot);
    return inputRoot;
  }

  async loadPersonaOperationInputs(
    inputArtifactDir: string,
    operationId: string,
  ): Promise<PersonaOperationInputSnapshot> {
    this.assertPersonaOperationId(operationId);
    const expectedRoot = join(
      this.dataRoot,
      "persona",
      "operations",
      operationId,
      "inputs",
    );
    if (inputArtifactDir !== expectedRoot) {
      throw new Error("Invalid persona input artifact directory");
    }
    const manifest = JSON.parse(
      await readFile(join(expectedRoot, "manifest.json"), "utf8"),
    ) as PersonaInputManifest;
    if (
      manifest.version !== 1 ||
      manifest.operation_id !== operationId ||
      !Array.isArray(manifest.diaries) ||
      !Array.isArray(manifest.consumed_pending_dates) ||
      !manifest.consumed_pending_dates.every((day) =>
        typeof day?.date === "string" && typeof day.watermark === "string" && typeof day.fileSha256 === "string"
      ) || !Number.isInteger(manifest.rebuild_request_epoch) ||
      !Array.isArray(manifest.partial_missing_dates) ||
      !manifest.partial_missing_dates.every((date) => typeof date === "string")
    ) {
      throw new Error("Invalid persona input manifest");
    }

    const diaries: Array<{ date: string; content: string }> = [];
    for (const diary of manifest.diaries) {
      assertDiaryDate(diary.date);
      if (
        typeof diary.file !== "string" ||
        !/^diary-\d{4}-\d{4}-\d{2}-\d{2}\.md$/.test(diary.file)
      ) {
        throw new Error("Invalid persona diary artifact path");
      }
      const bytes = await readFile(join(expectedRoot, diary.file));
      if (createHash("sha256").update(bytes).digest("hex") !== diary.sha256) {
        throw new Error(`Persona input artifact hash mismatch: ${diary.date}`);
      }
      diaries.push({
        date: diary.date,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    }

    let baseline: PersonaOperationInputSnapshot["baseline"] = null;
    if (manifest.baseline !== null) {
      if (
        manifest.baseline.user_profile_file !== "baseline-user-profile.md" ||
        manifest.baseline.experience_file !== "baseline-experience.md"
      ) {
        throw new Error("Invalid persona baseline artifact path");
      }
      const userProfileBytes = await readFile(
        join(expectedRoot, manifest.baseline.user_profile_file),
      );
      const experienceBytes = await readFile(
        join(expectedRoot, manifest.baseline.experience_file),
      );
      if (
        createHash("sha256").update(userProfileBytes).digest("hex") !==
          manifest.baseline.user_profile_sha256 ||
        createHash("sha256").update(experienceBytes).digest("hex") !==
          manifest.baseline.experience_sha256
      ) {
        throw new Error("Persona baseline artifact hash mismatch");
      }
      baseline = {
        userProfile: new TextDecoder("utf-8", { fatal: true }).decode(
          userProfileBytes,
        ),
        experience: new TextDecoder("utf-8", { fatal: true }).decode(experienceBytes),
      };
    }

    return {
      operationId,
      baseCurrentOperationId: manifest.base_current_operation_id,
      diaries,
      baseline,
      consumedPendingDates: manifest.consumed_pending_dates.map((day) => day.date),
      consumedPendingDays: manifest.consumed_pending_dates,
      rebuildRequestEpoch: manifest.rebuild_request_epoch,
      partialMissingDates: manifest.partial_missing_dates,
    };
  }

  async commitPersonaCheckpoint(input: {
    operationId: string;
    accumulatorGeneration: number;
    nextBatchIndex: number;
    accumulator: { userProfile: string; experience: string };
    validationReport: CitationValidationReport;
  }): Promise<PersonaCheckpointPointer> {
    this.assertPersonaOperationId(input.operationId);
    const checkpointRoot = join(
      this.dataRoot,
      "persona",
      "operations",
      input.operationId,
      "checkpoints",
    );
    await mkdir(checkpointRoot, { recursive: true });
    const accumulatorFile = `accumulator-${input.accumulatorGeneration}.json`;
    const checkpointFile = `checkpoint-${input.accumulatorGeneration}.json`;
    const accumulatorBytes = new TextEncoder().encode(
      `${JSON.stringify({
        ...input.accumulator,
        validationReport: input.validationReport,
      })}\n`,
    );
    const accumulatorHash = createHash("sha256")
      .update(accumulatorBytes)
      .digest("hex");
    await this.commitAtomically(
      join(checkpointRoot, accumulatorFile),
      accumulatorBytes,
    );
    const manifest: PersonaCheckpointManifest = {
      version: 1,
      operation_id: input.operationId,
      next_batch_index: input.nextBatchIndex,
      accumulator_generation: input.accumulatorGeneration,
      accumulator_file: accumulatorFile,
      accumulator_hash: accumulatorHash,
    };
    const checkpointPath = join(checkpointRoot, checkpointFile);
    const checkpointBytes = new TextEncoder().encode(
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await this.commitAtomically(checkpointPath, checkpointBytes);
    await this.syncDirectory(checkpointRoot);
    return {
      accumulatorGeneration: input.accumulatorGeneration,
      accumulatorHash,
      checkpointPath,
      checkpointSha256: createHash("sha256")
        .update(checkpointBytes)
        .digest("hex"),
      nextBatchIndex: input.nextBatchIndex,
    };
  }

  async loadPersonaCheckpoint(input: PersonaCheckpointPointer & {
    operationId: string;
  }): Promise<{
    userProfile: string;
    experience: string;
    validationReport: CitationValidationReport;
  }> {
    this.assertPersonaOperationId(input.operationId);
    const checkpointRoot = join(
      this.dataRoot,
      "persona",
      "operations",
      input.operationId,
      "checkpoints",
    );
    const expectedPath = join(
      checkpointRoot,
      `checkpoint-${input.accumulatorGeneration}.json`,
    );
    if (input.checkpointPath !== expectedPath) {
      throw new Error("Invalid persona checkpoint path");
    }
    const checkpointBytes = await readFile(expectedPath);
    if (
      createHash("sha256").update(checkpointBytes).digest("hex") !==
      input.checkpointSha256
    ) {
      throw new Error("Persona checkpoint hash mismatch");
    }
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(checkpointBytes),
    ) as PersonaCheckpointManifest;
    if (
      manifest.version !== 1 ||
      manifest.operation_id !== input.operationId ||
      manifest.next_batch_index !== input.nextBatchIndex ||
      manifest.accumulator_generation !== input.accumulatorGeneration ||
      manifest.accumulator_hash !== input.accumulatorHash
    ) {
      throw new Error("Persona checkpoint state mismatch");
    }
    if (
      manifest.accumulator_file !==
      `accumulator-${input.accumulatorGeneration}.json`
    ) {
      throw new Error("Invalid persona accumulator path");
    }
    const accumulatorBytes = await readFile(
      join(checkpointRoot, manifest.accumulator_file),
    );
    if (
      createHash("sha256").update(accumulatorBytes).digest("hex") !==
      input.accumulatorHash
    ) {
      throw new Error("Persona accumulator hash mismatch");
    }
    const accumulator = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(accumulatorBytes),
    ) as {
      userProfile?: unknown;
      experience?: unknown;
      validationReport?: Partial<CitationValidationReport>;
    };
    if (
      typeof accumulator.userProfile !== "string" ||
      typeof accumulator.experience !== "string" ||
      accumulator.validationReport?.version !== 2 ||
      !Number.isSafeInteger(accumulator.validationReport.total) ||
      !Number.isSafeInteger(accumulator.validationReport.stripped) ||
      !Array.isArray(accumulator.validationReport.items)
    ) {
      throw new Error("Invalid persona accumulator");
    }
    return {
      userProfile: accumulator.userProfile,
      experience: accumulator.experience,
      validationReport: accumulator.validationReport as CitationValidationReport,
    };
  }

  private assertPersonaOperationId(operationId: string): void {
    if (!/^[A-Za-z0-9._-]+$/.test(operationId)) {
      throw new Error("Invalid persona operation id");
    }
  }

  async loadCurrentPersona(): Promise<LoadedPersona> {
    const personaRoot = join(this.dataRoot, "persona");
    const currentBytes = await readFile(join(personaRoot, "CURRENT"));
    let manifest: PersonaManifest;
    try {
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(currentBytes));
    } catch {
      throw new Error("Invalid persona CURRENT manifest");
    }
    if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1) {
      throw new Error("Invalid persona CURRENT generation");
    }

    const generationRoot = join(
      personaRoot,
      "generations",
      String(manifest.generation),
    );
    const [generationManifestBytes, userProfileBytes, experienceBytes] = await Promise.all([
      readFile(join(generationRoot, "manifest.json")),
      readFile(join(generationRoot, "user-profile.md")),
      readFile(join(generationRoot, "experience.md")),
    ]);
    if (
      generationManifestBytes.length !== currentBytes.length ||
      !generationManifestBytes.every(
        (byte, index) => byte === currentBytes[index],
      )
    ) {
      throw new Error("Persona generation manifest does not match CURRENT");
    }

    this.verifyPersonaBodyHashes(manifest, userProfileBytes, experienceBytes);

    return {
      generation: manifest.generation,
      manifest,
      userProfile: new TextDecoder("utf-8", { fatal: true }).decode(userProfileBytes),
      experience: new TextDecoder("utf-8", { fatal: true }).decode(experienceBytes),
    };
  }

  async loadCurrentPersonaMaterialBlocks(): Promise<CurrentPersonaMaterialBlocks> {
    const personaRoot = join(this.dataRoot, "persona");
    const currentBytes = await readFile(join(personaRoot, "CURRENT"));
    let manifest: PersonaManifest;
    try {
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(currentBytes));
    } catch {
      throw new Error("Invalid persona CURRENT manifest");
    }
    if (!Number.isSafeInteger(manifest.generation) || manifest.generation < 1) {
      throw new Error("Invalid persona CURRENT generation");
    }

    const generationRoot = join(personaRoot, "generations", String(manifest.generation));
    const generationManifestBytes = await readFile(join(generationRoot, "manifest.json"));
    if (
      generationManifestBytes.length !== currentBytes.length ||
      !generationManifestBytes.every((byte, index) => byte === currentBytes[index])
    ) {
      throw new Error("Persona generation manifest does not match CURRENT");
    }

    const loadBlock = async (
      filename: string,
      expectedSha256: string,
    ): Promise<string | null> => {
      try {
        const bytes = await readFile(join(generationRoot, filename));
        if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
          return null;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    };

    const [userProfile, experience] = await Promise.all([
      loadBlock("user-profile.md", manifest.user_profile_sha256),
      loadBlock("experience.md", manifest.experience_sha256),
    ]);
    return { userProfile, experience };
  }

  async loadPersonaGeneration(generation: number): Promise<LoadedPersona> {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Invalid persona generation");
    }
    const generationRoot = join(
      this.dataRoot,
      "persona",
      "generations",
      String(generation),
    );
    const [manifestBytes, userProfileBytes, experienceBytes] = await Promise.all([
      readFile(join(generationRoot, "manifest.json")),
      readFile(join(generationRoot, "user-profile.md")),
      readFile(join(generationRoot, "experience.md")),
    ]);
    let manifest: PersonaManifest;
    try {
      manifest = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
      );
    } catch {
      throw new Error("Invalid persona generation manifest");
    }
    if (manifest.generation !== generation) {
      throw new Error("Persona generation manifest has wrong generation");
    }
    this.verifyPersonaBodyHashes(manifest, userProfileBytes, experienceBytes);
    return {
      generation,
      manifest,
      userProfile: new TextDecoder("utf-8", { fatal: true }).decode(userProfileBytes),
      experience: new TextDecoder("utf-8", { fatal: true }).decode(experienceBytes),
    };
  }

  private verifyPersonaBodyHashes(
    manifest: PersonaManifest,
    userProfileBytes: Uint8Array,
    experienceBytes: Uint8Array,
  ): void {
    if (
      typeof manifest.user_profile_sha256 !== "string" ||
      createHash("sha256").update(userProfileBytes).digest("hex") !==
        manifest.user_profile_sha256
    ) {
      throw new Error("Persona user profile hash mismatch");
    }
    if (
      typeof manifest.experience_sha256 !== "string" ||
      createHash("sha256").update(experienceBytes).digest("hex") !==
        manifest.experience_sha256
    ) {
      throw new Error("Persona experience hash mismatch");
    }
  }

  async deletePersonaGeneration(generation: number): Promise<void> {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Invalid persona generation");
    }
    const generationsRoot = join(this.dataRoot, "persona", "generations");
    await rm(join(generationsRoot, String(generation)), { recursive: true, force: true });
    try {
      await this.syncDirectory(generationsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async loadCurrentPersonaCoverage(): Promise<PersonaCoverage | null> {
    let current: LoadedPersona;
    try {
      current = await this.loadCurrentPersona();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }

    const lastFoldedDate = current.manifest.last_folded_date_after;
    const partialMissingDates = current.manifest.partial_missing_dates_after;
    if (
      (lastFoldedDate !== null && typeof lastFoldedDate !== "string") ||
      !Array.isArray(partialMissingDates) ||
      partialMissingDates.some((date) => typeof date !== "string")
    ) {
      throw new Error("Invalid persona CURRENT coverage");
    }
    if (lastFoldedDate !== null) {
      assertDiaryDate(lastFoldedDate);
    }
    for (const date of partialMissingDates as string[]) {
      assertDiaryDate(date);
    }

    return {
      lastFoldedDate: lastFoldedDate as string | null,
      partialMissingDates: [...(partialMissingDates as string[])],
    };
  }
}
