import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { parseMarkdownSections } from "../shared/markdown-sections";
import { createLogger } from "../shared/logger";
import { sortDiaryIndexRecentFirst } from "./diary-index";
import { estimateDiaryTokens } from "./domain";

export const MEMORY_DOCUMENT_TOKEN_LIMIT = 5_000;
export const DEFAULT_MEMORY_HISTORY_RETENTION: MemoryHistoryRetention = {
  newest: 30,
  monthly: true,
};

export const EMPTY_PROFILE_DOCUMENT = "# User Profile\n";
export const EMPTY_EXPERIENCE_DOCUMENT = "# Experience\n";
export const EMPTY_ARCHIVE_DOCUMENT = "# Memory Archive\n";

const MEMORY_FILES = [
  "user-profile.md",
  "experience.md",
  "archive.md",
] as const;
const SNAPSHOT_MANIFEST_FILE = "manifest.json";

type MemoryFilename = (typeof MEMORY_FILES)[number];

export interface CurrentMemoryDocuments {
  userProfile: string;
  experience: string;
  archive: string;
}

export type CurrentMemoryInjectionDocuments = Pick<
  CurrentMemoryDocuments,
  "userProfile" | "experience"
>;

export interface CommitNightInput extends CurrentMemoryDocuments {
  date: string;
  diary: string;
  diaryIndex: string;
}

export interface CommitNightResult {
  snapshot: MemorySnapshot;
  lastSuccessfulDate: string;
}

export interface MemorySnapshot {
  id: string;
  date: string;
  createdAt: string;
}

export interface VerifiedMemorySnapshot extends MemorySnapshot {
  documents: CurrentMemoryDocuments;
}

export interface MemoryHistoryRetention {
  /** Number of newest snapshots kept regardless of month. */
  newest: number;
  /** Keep the newest remaining snapshot for every older calendar month. */
  monthly: boolean;
}

export type CommitFaultPoint =
  | "after-snapshot"
  | "after-staging"
  | "after-publish"
  | "before-success-marker";

interface DreamMemoryStoreLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface DreamMemoryStoreOptions {
  retention?: Partial<MemoryHistoryRetention>;
  now?: () => Date;
  logger?: DreamMemoryStoreLogger;
  /** Test seam for simulating a process failure at a durable transaction boundary. */
  faultInjector?: (point: CommitFaultPoint) => void | Promise<void>;
}

export type LegacyPersonaMigrationResult =
  | { status: "migrated"; generation: number }
  | { status: "already-current" }
  | { status: "empty"; reason: "legacy-current-unavailable" };

interface SnapshotManifest {
  version: 1;
  id: string;
  date: string;
  created_at: string;
  files: Record<MemoryFilename, string>;
}

interface TransactionTarget {
  path: string;
  existed: boolean;
}

interface TransactionManifest {
  version: 1;
  id: string;
  kind: "commit" | "restore" | "migration";
  date: string | null;
  targets: TransactionTarget[];
}

interface PreparedTransaction {
  id: string;
  root: string;
  manifest: TransactionManifest;
}

interface LegacyPersonaManifest {
  generation: number;
  user_profile_sha256: string;
  experience_sha256: string;
  [key: string]: unknown;
}

interface SuccessMarker {
  lastSuccessfulDate: string;
  transactionId: string;
}

interface MigrationState {
  version: 1;
  requires_full_fill: boolean;
}

class LegacyPersonaUnavailableError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function assertDiaryDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid dream date: ${date}`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function assertParseableMarkdown(label: string, document: string): void {
  if (!parseMarkdownSections(document).some((section) => section.level >= 1)) {
    throw new Error(`${label} must contain at least one Markdown ATX heading`);
  }
}

function assertHotMemoryWithinLimit(
  label: "userProfile" | "experience",
  document: string,
): void {
  const tokens = estimateDiaryTokens(document);
  if (tokens > MEMORY_DOCUMENT_TOKEN_LIMIT) {
    throw new Error(
      `${label} has ${tokens} estimated tokens and exceeds the ${MEMORY_DOCUMENT_TOKEN_LIMIT}-token limit; demote the oldest or least valuable entries to archive and retry`,
    );
  }
}

function defaultCurrentMemory(): CurrentMemoryDocuments {
  return {
    userProfile: EMPTY_PROFILE_DOCUMENT,
    experience: EMPTY_EXPERIENCE_DOCUMENT,
    archive: EMPTY_ARCHIVE_DOCUMENT,
  };
}

function documentForFilename(
  documents: CurrentMemoryDocuments,
  filename: MemoryFilename,
): string {
  switch (filename) {
    case "user-profile.md":
      return documents.userProfile;
    case "experience.md":
      return documents.experience;
    case "archive.md":
      return documents.archive;
  }
}

function snapshotId(now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID()}`;
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith(".")) {
    throw new Error(`Invalid memory snapshot id: ${id}`);
  }
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !pathFromRoot.startsWith(sep)
  );
}

export class DreamMemoryStore {
  readonly retention: MemoryHistoryRetention;
  private readonly now: () => Date;
  private readonly logger: DreamMemoryStoreLogger;
  private readonly faultInjector?: DreamMemoryStoreOptions["faultInjector"];

  constructor(
    readonly dataRoot: string,
    options: DreamMemoryStoreOptions = {},
  ) {
    this.retention = {
      newest: options.retention?.newest ?? DEFAULT_MEMORY_HISTORY_RETENTION.newest,
      monthly: options.retention?.monthly ?? DEFAULT_MEMORY_HISTORY_RETENTION.monthly,
    };
    if (!Number.isSafeInteger(this.retention.newest) || this.retention.newest < 0) {
      throw new Error("Memory history retention newest must be a non-negative integer");
    }
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? createLogger("MNEMOSYNE");
    this.faultInjector = options.faultInjector;
  }

  /**
   * Atomically publishes the complete output of one dream run.
   *
   * Snapshot and validation order is part of the public contract. The success
   * marker is deliberately separate and last: without it the date is unprocessed.
   */
  async commitNight(input: CommitNightInput): Promise<CommitNightResult> {
    assertDiaryDate(input.date);
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();

    const previous = await this.readCurrentMemoryWithoutRecovery();
    const snapshot = await this.createSnapshot(input.date, previous);
    await this.injectFault("after-snapshot");

    const normalizedInput = {
      ...input,
      diaryIndex: sortDiaryIndexRecentFirst(input.diaryIndex),
    };
    this.validateCommitDocuments(normalizedInput);

    const transaction = await this.prepareTransaction("commit", input.date, {
      "memory/user-profile.md": normalizedInput.userProfile,
      "memory/experience.md": normalizedInput.experience,
      "memory/archive.md": normalizedInput.archive,
      "memory/migration-state.json": this.serializeMigrationState(false),
      [`diary/${input.date}.md`]: normalizedInput.diary,
      "diary/INDEX.md": normalizedInput.diaryIndex,
    });

    try {
      await this.injectFault("after-staging");
      await this.publishTransaction(transaction);
      await this.injectFault("after-publish");
      await this.injectFault("before-success-marker");
      await this.writeSuccessMarker(input.date, transaction.id);
    } catch (error) {
      const marker = await this.readSuccessMarkerWithoutRecovery().catch(
        () => null,
      );
      if (marker?.transactionId !== transaction.id) {
        try {
          await this.rollbackTransaction(transaction);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Dream commit failed and rollback could not complete for ${input.date}`,
          );
        }
        throw error;
      } else {
        await rm(transaction.root, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }

    await rm(transaction.root, { recursive: true, force: true });
    await this.syncDirectory(this.transactionsRoot()).catch(() => undefined);
    await this.applyRetention().catch((error) => {
      this.logger.warn("Memory snapshot retention failed after a successful commit", {
        date: input.date,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { snapshot, lastSuccessfulDate: input.date };
  }

  async readCurrentMemory(): Promise<CurrentMemoryDocuments> {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    return this.readCurrentMemoryWithoutRecovery();
  }

  async readInjectionDocuments(): Promise<CurrentMemoryInjectionDocuments> {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    const defaults = defaultCurrentMemory();
    const [userProfile, experience] = await Promise.all([
      this.readMemoryDocument("user-profile.md", defaults.userProfile),
      this.readMemoryDocument("experience.md", defaults.experience),
    ]);
    return { userProfile, experience };
  }

  async requiresInitialFullFill(): Promise<boolean> {
    await this.recoverIncompleteTransactions();
    return (await this.readMigrationStateWithoutRecovery())?.requires_full_fill ?? false;
  }

  async readLastSuccessfulDate(): Promise<string | null> {
    await this.recoverIncompleteTransactions();
    return this.readLastSuccessfulDateWithoutRecovery();
  }

  async listSnapshots(): Promise<MemorySnapshot[]> {
    await this.recoverIncompleteTransactions();
    return this.listSnapshotsWithoutRecovery();
  }

  async verifySnapshot(id: string): Promise<VerifiedMemorySnapshot> {
    await this.recoverIncompleteTransactions();
    return this.verifySnapshotWithoutRecovery(id);
  }

  async restoreSnapshot(id: string): Promise<void> {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    const snapshot = await this.verifySnapshotWithoutRecovery(id);
    const transaction = await this.prepareTransaction("restore", snapshot.date, {
      "memory/user-profile.md": snapshot.documents.userProfile,
      "memory/experience.md": snapshot.documents.experience,
      "memory/archive.md": snapshot.documents.archive,
    });
    await this.executeTransaction(
      transaction,
      `Memory snapshot restore failed and rollback could not complete: ${id}`,
    );
  }

  /**
   * One-time cutover adapter. It reads the old published snapshot once, copies
   * it into the single-current dream layout, then removes the old layout.
   */
  async migrateLegacyPersona(): Promise<LegacyPersonaMigrationResult> {
    await this.recoverIncompleteTransactions();
    await this.assertWorkspaceRootsAreSafe();
    const hasProfile = await this.pathExists(this.memoryPath("user-profile.md"));
    const hasExperience = await this.pathExists(this.memoryPath("experience.md"));

    if (hasProfile && hasExperience) {
      const migrationState = await this.readMigrationStateWithoutRecovery();
      if (
        !(await this.pathExists(this.memoryPath("archive.md"))) ||
        migrationState === null
      ) {
        await this.publishMigrationDocumentsAtomically(
          await this.readCurrentMemoryWithoutRecovery(),
          migrationState?.requires_full_fill ?? false,
        );
      }
      await this.retireLegacyPersonaLayout();
      return { status: "already-current" };
    }

    let legacy: { generation: number; documents: CurrentMemoryDocuments } | null = null;
    try {
      legacy = await this.loadLegacyCurrentPersona();
    } catch (error) {
      if (!(error instanceof LegacyPersonaUnavailableError)) throw error;
      this.logger.warn(
        "Legacy persona CURRENT is missing or invalid; starting dream memory from empty documents",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    if (legacy === null) {
      await this.publishMigrationDocumentsAtomically(defaultCurrentMemory(), true);
      await this.retireLegacyPersonaLayout();
      return { status: "empty", reason: "legacy-current-unavailable" };
    }

    await this.publishMigrationDocumentsAtomically(legacy.documents, false);
    await this.retireLegacyPersonaLayout();
    return { status: "migrated", generation: legacy.generation };
  }

  private validateCommitDocuments(input: CommitNightInput): void {
    assertParseableMarkdown("userProfile", input.userProfile);
    assertParseableMarkdown("experience", input.experience);
    assertParseableMarkdown("archive", input.archive);
    assertParseableMarkdown("diary", input.diary);
    assertParseableMarkdown("diaryIndex", input.diaryIndex);
    assertHotMemoryWithinLimit("userProfile", input.userProfile);
    assertHotMemoryWithinLimit("experience", input.experience);
  }

  private async injectFault(point: CommitFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }

  private memoryRoot(): string {
    return join(this.dataRoot, "memory");
  }

  private memoryPath(filename: MemoryFilename): string {
    return join(this.memoryRoot(), filename);
  }

  private historyRoot(): string {
    return join(this.memoryRoot(), "history");
  }

  private transactionsRoot(): string {
    return join(this.memoryRoot(), ".transactions");
  }

  private successMarkerPath(): string {
    return join(this.memoryRoot(), "last-successful.json");
  }

  private migrationStatePath(): string {
    return join(this.memoryRoot(), "migration-state.json");
  }

  private async assertWorkspaceRootsAreSafe(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    for (const root of [this.dataRoot, this.memoryRoot(), join(this.dataRoot, "diary")]) {
      try {
        const metadata = await lstat(root);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error(`Dream workspace root must be a real directory: ${root}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async assertFileIsSafe(path: string): Promise<void> {
    const absoluteRoot = resolve(this.dataRoot);
    const absolutePath = resolve(path);
    if (!isWithin(absoluteRoot, absolutePath)) {
      throw new Error(`Dream workspace path is outside data root: ${path}`);
    }
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Dream workspace document must be a regular file: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async readCurrentMemoryWithoutRecovery(): Promise<CurrentMemoryDocuments> {
    const defaults = defaultCurrentMemory();
    const [userProfile, experience, archive] = await Promise.all([
      this.readMemoryDocument("user-profile.md", defaults.userProfile),
      this.readMemoryDocument("experience.md", defaults.experience),
      this.readMemoryDocument("archive.md", defaults.archive),
    ]);
    return { userProfile, experience, archive };
  }

  private async readMemoryDocument(
    filename: MemoryFilename,
    fallback: string,
  ): Promise<string> {
    const path = this.memoryPath(filename);
    await this.assertFileIsSafe(path);
    try {
      return decodeUtf8(await readFile(path), `memory/${filename}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }

  private async createSnapshot(
    date: string,
    documents: CurrentMemoryDocuments,
  ): Promise<MemorySnapshot> {
    const createdAt = this.now().toISOString();
    const id = snapshotId(new Date(createdAt));
    const historyRoot = this.historyRoot();
    const finalRoot = join(historyRoot, id);
    const temporaryRoot = join(historyRoot, `.${id}.tmp`);
    await mkdir(historyRoot, { recursive: true });
    await mkdir(temporaryRoot);
    try {
      const files = {} as Record<MemoryFilename, string>;
      for (const filename of MEMORY_FILES) {
        const bytes = encoder.encode(documentForFilename(documents, filename));
        await this.writeFileSynced(join(temporaryRoot, filename), bytes);
        files[filename] = sha256(bytes);
      }
      const manifest: SnapshotManifest = {
        version: 1,
        id,
        date,
        created_at: createdAt,
        files,
      };
      await this.writeFileSynced(
        join(temporaryRoot, SNAPSHOT_MANIFEST_FILE),
        encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
      );
      await this.syncDirectory(temporaryRoot);
      await rename(temporaryRoot, finalRoot);
      await this.syncDirectory(historyRoot);
      return { id, date, createdAt };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  }

  private async listSnapshotsWithoutRecovery(): Promise<MemorySnapshot[]> {
    let entries;
    try {
      entries = await readdir(this.historyRoot(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const snapshots: MemorySnapshot[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Invalid entry in memory history: ${entry.name}`);
      }
      const manifest = await this.readSnapshotManifest(entry.name);
      snapshots.push({
        id: manifest.id,
        date: manifest.date,
        createdAt: manifest.created_at,
      });
    }
    return snapshots.sort((left, right) =>
      right.date.localeCompare(left.date) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id)
    );
  }

  private async readSnapshotManifest(id: string): Promise<SnapshotManifest> {
    assertSafeId(id);
    const root = join(this.historyRoot(), id);
    const metadata = await lstat(root);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Memory snapshot is not a real directory: ${id}`);
    }
    let manifest: SnapshotManifest;
    try {
      manifest = JSON.parse(
        decodeUtf8(
          await readFile(join(root, SNAPSHOT_MANIFEST_FILE)),
          `memory snapshot manifest ${id}`,
        ),
      ) as SnapshotManifest;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid memory snapshot manifest: ${id}`);
      }
      throw error;
    }
    if (
      manifest.version !== 1 ||
      manifest.id !== id ||
      typeof manifest.created_at !== "string" ||
      Number.isNaN(Date.parse(manifest.created_at)) ||
      typeof manifest.files !== "object" ||
      manifest.files === null
    ) {
      throw new Error(`Invalid memory snapshot manifest: ${id}`);
    }
    assertDiaryDate(manifest.date);
    for (const filename of MEMORY_FILES) {
      if (!/^[a-f0-9]{64}$/.test(manifest.files[filename] ?? "")) {
        throw new Error(`Invalid memory snapshot manifest hash: ${id}/${filename}`);
      }
    }
    return manifest;
  }

  private async verifySnapshotWithoutRecovery(
    id: string,
  ): Promise<VerifiedMemorySnapshot> {
    const manifest = await this.readSnapshotManifest(id);
    const root = join(this.historyRoot(), id);
    const loaded = {} as Record<MemoryFilename, string>;
    for (const filename of MEMORY_FILES) {
      const path = join(root, filename);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error(`Invalid memory snapshot document: ${id}/${filename}`);
      }
      const bytes = await readFile(path);
      if (sha256(bytes) !== manifest.files[filename]) {
        throw new Error(`Memory snapshot hash mismatch: ${id}/${filename}`);
      }
      loaded[filename] = decodeUtf8(bytes, `memory snapshot ${id}/${filename}`);
    }
    return {
      id,
      date: manifest.date,
      createdAt: manifest.created_at,
      documents: {
        userProfile: loaded["user-profile.md"],
        experience: loaded["experience.md"],
        archive: loaded["archive.md"],
      },
    };
  }

  private async applyRetention(): Promise<void> {
    const snapshots = await this.listSnapshotsWithoutRecovery();
    const keep = new Set(
      snapshots.slice(0, this.retention.newest).map((snapshot) => snapshot.id),
    );
    if (this.retention.monthly) {
      const seenMonths = new Set<string>();
      for (const snapshot of snapshots.slice(this.retention.newest)) {
        const month = snapshot.date.slice(0, 7);
        if (!seenMonths.has(month)) {
          seenMonths.add(month);
          keep.add(snapshot.id);
        }
      }
    }
    for (const snapshot of snapshots) {
      if (!keep.has(snapshot.id)) {
        await rm(join(this.historyRoot(), snapshot.id), {
          recursive: true,
          force: true,
        });
      }
    }
    await this.syncDirectory(this.historyRoot());
  }

  private async prepareTransaction(
    kind: TransactionManifest["kind"],
    date: string | null,
    documents: Record<string, string>,
  ): Promise<PreparedTransaction> {
    if (date !== null) assertDiaryDate(date);
    const id = randomUUID();
    const root = join(this.transactionsRoot(), id);
    await mkdir(join(root, "backups"), { recursive: true });
    await mkdir(join(root, "staged"), { recursive: true });
    const targets: TransactionTarget[] = [];
    try {
      for (const [relativePath, document] of Object.entries(documents)) {
        this.assertTransactionPath(relativePath);
        const finalPath = join(this.dataRoot, relativePath);
        await this.assertFileIsSafe(finalPath);
        let existed = true;
        try {
          const bytes = await readFile(finalPath);
          await this.writeFileSynced(join(root, "backups", relativePath), bytes);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          existed = false;
        }
        await this.writeFileSynced(
          join(root, "staged", relativePath),
          encoder.encode(document),
        );
        targets.push({ path: relativePath, existed });
      }
      const manifest: TransactionManifest = { version: 1, id, kind, date, targets };
      await this.writeFileSynced(
        join(root, "manifest.json"),
        encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
      );
      await this.syncDirectory(root);
      return { id, root, manifest };
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async publishTransaction(transaction: PreparedTransaction): Promise<void> {
    for (const target of transaction.manifest.targets) {
      const finalPath = join(this.dataRoot, target.path);
      await mkdir(dirname(finalPath), { recursive: true });
      await rename(join(transaction.root, "staged", target.path), finalPath);
      await this.syncDirectory(dirname(finalPath));
    }
  }

  private async rollbackTransaction(transaction: PreparedTransaction): Promise<void> {
    for (const target of transaction.manifest.targets) {
      const finalPath = join(this.dataRoot, target.path);
      if (target.existed) {
        const backup = await readFile(join(transaction.root, "backups", target.path));
        await this.writeAtomically(finalPath, backup);
      } else {
        await unlink(finalPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        await this.syncDirectory(dirname(finalPath)).catch(() => undefined);
      }
    }
    await rm(transaction.root, { recursive: true, force: true });
  }

  private async executeTransaction(
    transaction: PreparedTransaction,
    rollbackFailureMessage: string,
  ): Promise<void> {
    try {
      await this.publishTransaction(transaction);
    } catch (error) {
      try {
        await this.rollbackTransaction(transaction);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          rollbackFailureMessage,
        );
      }
      throw error;
    }
    await rm(transaction.root, { recursive: true, force: true });
  }

  private async recoverIncompleteTransactions(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.transactionsRoot(), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const marker = await this.readSuccessMarkerWithoutRecovery().catch(
      () => null,
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Invalid dream transaction entry: ${entry.name}`);
      }
      const root = join(this.transactionsRoot(), entry.name);
      let manifest: TransactionManifest;
      try {
        manifest = JSON.parse(
          decodeUtf8(await readFile(join(root, "manifest.json")), "dream transaction manifest"),
        ) as TransactionManifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await rm(root, { recursive: true, force: true });
          continue;
        }
        throw new Error(`Invalid dream transaction manifest: ${entry.name}`);
      }
      this.validateTransactionManifest(manifest);
      const transaction = { id: manifest.id, root, manifest };
      if (
        manifest.kind === "commit" &&
        marker?.transactionId === manifest.id
      ) {
        await rm(root, { recursive: true, force: true });
      } else {
        await this.rollbackTransaction(transaction);
      }
    }
  }

  private validateTransactionManifest(manifest: TransactionManifest): void {
    if (
      manifest.version !== 1 ||
      typeof manifest.id !== "string" ||
      !["commit", "restore", "migration"].includes(manifest.kind) ||
      !Array.isArray(manifest.targets) ||
      (manifest.date !== null && typeof manifest.date !== "string")
    ) {
      throw new Error("Invalid dream transaction manifest");
    }
    assertSafeId(manifest.id);
    if (manifest.date !== null) assertDiaryDate(manifest.date);
    for (const target of manifest.targets) {
      if (typeof target?.path !== "string" || typeof target.existed !== "boolean") {
        throw new Error("Invalid dream transaction target");
      }
      this.assertTransactionPath(target.path);
    }
  }

  private assertTransactionPath(path: string): void {
    if (
      path.includes("\0") ||
      path.startsWith("/") ||
      (!path.startsWith("memory/") && !path.startsWith("diary/")) ||
      !isWithin(resolve(this.dataRoot), resolve(this.dataRoot, path))
    ) {
      throw new Error(`Invalid dream transaction path: ${path}`);
    }
  }

  private async writeSuccessMarker(date: string, transactionId: string): Promise<void> {
    const previous = await this.readSuccessMarkerWithoutRecovery();
    const lastSuccessfulDate =
      previous !== null && previous.lastSuccessfulDate > date
        ? previous.lastSuccessfulDate
        : date;
    await this.writeAtomically(
      this.successMarkerPath(),
      encoder.encode(
        `${JSON.stringify({
          last_successful_date: lastSuccessfulDate,
          transaction_id: transactionId,
        }, null, 2)}\n`,
      ),
    );
  }

  private async readLastSuccessfulDateWithoutRecovery(): Promise<string | null> {
    return (await this.readSuccessMarkerWithoutRecovery())?.lastSuccessfulDate ?? null;
  }

  private async readSuccessMarkerWithoutRecovery(): Promise<SuccessMarker | null> {
    try {
      const value = JSON.parse(
        decodeUtf8(await readFile(this.successMarkerPath()), "dream success marker"),
      ) as { last_successful_date?: unknown; transaction_id?: unknown };
      if (
        typeof value.last_successful_date !== "string" ||
        typeof value.transaction_id !== "string"
      ) {
        throw new Error("Invalid dream success marker");
      }
      assertDiaryDate(value.last_successful_date);
      assertSafeId(value.transaction_id);
      return {
        lastSuccessfulDate: value.last_successful_date,
        transactionId: value.transaction_id,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private serializeMigrationState(requiresFullFill: boolean): string {
    return `${JSON.stringify({
      version: 1,
      requires_full_fill: requiresFullFill,
    }, null, 2)}\n`;
  }

  private async readMigrationStateWithoutRecovery(): Promise<MigrationState | null> {
    try {
      const value = JSON.parse(
        decodeUtf8(await readFile(this.migrationStatePath()), "dream migration state"),
      ) as Partial<MigrationState>;
      if (value.version !== 1 || typeof value.requires_full_fill !== "boolean") {
        throw new Error("Invalid dream migration state");
      }
      return value as MigrationState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async publishMigrationDocumentsAtomically(
    documents: CurrentMemoryDocuments,
    requiresFullFill: boolean,
  ): Promise<void> {
    assertParseableMarkdown("userProfile", documents.userProfile);
    assertParseableMarkdown("experience", documents.experience);
    assertParseableMarkdown("archive", documents.archive);
    const transaction = await this.prepareTransaction("migration", null, {
      "memory/user-profile.md": documents.userProfile,
      "memory/experience.md": documents.experience,
      "memory/archive.md": documents.archive,
      "memory/migration-state.json": this.serializeMigrationState(requiresFullFill),
    });
    await this.executeTransaction(
      transaction,
      "Memory migration failed and rollback could not complete",
    );
  }

  private async loadLegacyCurrentPersona(): Promise<{
    generation: number;
    documents: CurrentMemoryDocuments;
  }> {
    const personaRoot = join(this.dataRoot, "persona");
    await this.assertLegacyPersonaRootIsSafe();
    const currentBytes = await this.readLegacyFile(
      join(personaRoot, "CURRENT"),
      "persona CURRENT",
    );
    let current: LegacyPersonaManifest;
    try {
      current = JSON.parse(
        decodeUtf8(currentBytes, "legacy persona CURRENT"),
      ) as LegacyPersonaManifest;
    } catch {
      throw new LegacyPersonaUnavailableError("Invalid legacy persona CURRENT manifest");
    }
    if (!Number.isSafeInteger(current.generation) || current.generation < 1) {
      throw new LegacyPersonaUnavailableError("Invalid legacy persona CURRENT generation");
    }
    const generationRoot = join(
      personaRoot,
      "generations",
      String(current.generation),
    );
    const [manifestBytes, profileBytes, experienceBytes] = await Promise.all([
      this.readLegacyFile(join(generationRoot, "manifest.json"), "generation manifest"),
      this.readLegacyFile(join(generationRoot, "user-profile.md"), "user profile"),
      this.readLegacyFile(join(generationRoot, "experience.md"), "experience"),
    ]);
    if (
      manifestBytes.length !== currentBytes.length ||
      !manifestBytes.every((byte, index) => byte === currentBytes[index])
    ) {
      throw new LegacyPersonaUnavailableError(
        "Legacy persona generation manifest does not match CURRENT",
      );
    }
    if (
      !/^[a-f0-9]{64}$/.test(current.user_profile_sha256 ?? "") ||
      sha256(profileBytes) !== current.user_profile_sha256 ||
      !/^[a-f0-9]{64}$/.test(current.experience_sha256 ?? "") ||
      sha256(experienceBytes) !== current.experience_sha256
    ) {
      throw new LegacyPersonaUnavailableError("Legacy persona generation hash mismatch");
    }

    let userProfile: string;
    let experience: string;
    try {
      userProfile = decodeUtf8(profileBytes, "legacy persona user profile");
      experience = decodeUtf8(experienceBytes, "legacy persona experience");
    } catch (error) {
      throw new LegacyPersonaUnavailableError(
        error instanceof Error ? error.message : "Invalid legacy persona UTF-8",
      );
    }
    if (!parseMarkdownSections(userProfile).some((section) => section.level >= 1)) {
      throw new LegacyPersonaUnavailableError("Legacy user profile is not parseable Markdown");
    }
    if (!parseMarkdownSections(experience).some((section) => section.level >= 1)) {
      throw new LegacyPersonaUnavailableError("Legacy experience is not parseable Markdown");
    }
    return {
      generation: current.generation,
      documents: {
        userProfile,
        experience,
        archive: EMPTY_ARCHIVE_DOCUMENT,
      },
    };
  }

  private async retireLegacyPersonaLayout(): Promise<void> {
    const personaRoot = join(this.dataRoot, "persona");
    await this.assertLegacyPersonaRootIsSafe();
    await rm(join(personaRoot, "generations"), { recursive: true, force: true });
    await unlink(join(personaRoot, "CURRENT")).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    if (await this.pathExists(personaRoot)) {
      await this.syncDirectory(personaRoot);
    }
  }

  private async assertLegacyPersonaRootIsSafe(): Promise<void> {
    const personaRoot = join(this.dataRoot, "persona");
    try {
      const metadata = await lstat(personaRoot);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Legacy persona root must be a real directory: ${personaRoot}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async readLegacyFile(path: string, label: string): Promise<Uint8Array> {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new LegacyPersonaUnavailableError(
          `Legacy ${label} is not a regular file`,
        );
      }
      return await readFile(path);
    } catch (error) {
      if (error instanceof LegacyPersonaUnavailableError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        throw new LegacyPersonaUnavailableError(`Legacy ${label} is unavailable`);
      }
      throw error;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async writeFileSynced(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
    await this.assertFileIsSafe(path);
    const parent = dirname(path);
    const temporary = join(
      parent,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    await mkdir(parent, { recursive: true });
    try {
      await this.writeFileSynced(temporary, bytes);
      await rename(temporary, path);
      await this.syncDirectory(parent);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
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
}
