import type { Database } from "bun:sqlite";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  createDatabaseBackedHandlers,
  type ToolHandler,
} from "../mcp/handlers";

export const AGENT_READ_DOC_MAX_BYTES = 1_048_576;

export type AgentDocumentSubtree = "diary" | "persona";

export interface CreateDiaryAgentToolHandlersOptions {
  db: Database;
  dataRoot: string;
  allowedDocumentSubtrees: ReadonlySet<AgentDocumentSubtree>;
}

export interface DiaryAgentToolHandlers {
  recall: ToolHandler;
  timeline: ToolHandler;
  readDoc(path: string): Promise<string>;
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

async function assertNotSymlink(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
}

export function createDiaryAgentToolHandlers(
  options: CreateDiaryAgentToolHandlersOptions,
): DiaryAgentToolHandlers {
  const databaseHandlers = createDatabaseBackedHandlers(options.db, {
    audience: "worker",
  });
  const recall = databaseHandlers.recall;
  const timeline = databaseHandlers.timeline;
  if (!recall || !timeline) {
    throw new Error("Worker recall/timeline handlers are unavailable.");
  }
  const allowedSubtrees = new Set(options.allowedDocumentSubtrees);

  return {
    recall,
    timeline,
    async readDoc(requestedPath) {
      if (isAbsolute(requestedPath) || requestedPath.includes("\0")) {
        throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
      }

      const normalized = requestedPath.replaceAll("\\", "/");
      const subtree = normalized.split("/", 1)[0] as AgentDocumentSubtree;
      if (!allowedSubtrees.has(subtree)) {
        throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
      }
      if (!normalized.endsWith(".md")) {
        throw new Error(`Document must be a Markdown file: ${requestedPath}`);
      }
      if (normalized === "persona/operations" || normalized.startsWith("persona/operations/")) {
        throw new Error(`Operation artifacts are outside the allowed document scope: ${requestedPath}`);
      }

      const rootPath = resolve(options.dataRoot, subtree);
      const targetPath = resolve(options.dataRoot, normalized);
      if (!isWithin(rootPath, targetPath)) {
        throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
      }

      await assertNotSymlink(rootPath, "Document root");
      await assertNotSymlink(targetPath, "Document path");
      const [realRoot, realTarget] = await Promise.all([
        realpath(rootPath),
        realpath(targetPath),
      ]);
      if (!isWithin(realRoot, realTarget)) {
        throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
      }

      const metadata = await stat(realTarget);
      if (!metadata.isFile()) {
        throw new Error(`Document is not a regular file: ${requestedPath}`);
      }
      if (metadata.size > AGENT_READ_DOC_MAX_BYTES) {
        throw new Error(`Document exceeds the ${AGENT_READ_DOC_MAX_BYTES}-byte limit: ${requestedPath}`);
      }

      const bytes = await readFile(realTarget);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`Document is not valid UTF-8: ${requestedPath}`);
      }
    },
  };
}
