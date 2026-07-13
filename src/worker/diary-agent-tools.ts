import type { Database } from "bun:sqlite";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  createDatabaseBackedHandlers,
  type ToolHandler,
} from "../mcp/handlers";
import { assertDreamCommitToolFields } from "./dream-agent-tools";

export const AGENT_READ_DOC_MAX_BYTES = 1_048_576;

export type AgentDocumentSubtree = "diary" | "memory";

export interface CreateDiaryAgentToolHandlersOptions {
  db: Database;
  dataRoot: string;
  allowedDocumentSubtrees: ReadonlySet<AgentDocumentSubtree>;
  commit?: ToolHandler;
}

export interface DiaryAgentToolHandlers {
  recall: ToolHandler;
  timeline: ToolHandler;
  readDoc(path: string): Promise<string>;
  canUseTool: CanUseTool;
  commit?: ToolHandler;
}

export type CreateDreamAgentToolHandlersOptions = Omit<
  CreateDiaryAgentToolHandlersOptions,
  "allowedDocumentSubtrees"
>;

const DREAM_AGENT_DOCUMENT_SUBTREES: ReadonlySet<AgentDocumentSubtree> =
  new Set(["diary", "memory"]);

interface AssertWorkspacePathOptions {
  allowAbsolute: boolean;
  markdownOnly?: boolean;
}

interface AgentWorkspacePermissionGuard {
  assertWorkspacePath(
    requestedPath: string,
    options: AssertWorkspacePathOptions,
  ): Promise<string>;
  canUseTool: CanUseTool;
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

function isExcludedArtifactPath(
  subtree: AgentDocumentSubtree,
  pathFromRoot: string,
): boolean {
  const normalized = pathFromRoot.replaceAll("\\", "/");
  return subtree === "memory" && (
    normalized === ".transactions" || normalized.startsWith(".transactions/")
  );
}

function assertNotExcludedArtifactPath(
  subtree: AgentDocumentSubtree,
  pathFromRoot: string,
  requestedPath: string,
): void {
  if (!isExcludedArtifactPath(subtree, pathFromRoot)) {
    return;
  }
  throw new Error(
    `Transaction artifacts are outside the allowed document scope: ${requestedPath}`,
  );
}

function permissionDenied(error: unknown) {
  return {
    behavior: "deny" as const,
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createAgentWorkspacePermissionGuard(
  options: Pick<
    CreateDiaryAgentToolHandlersOptions,
    "dataRoot" | "allowedDocumentSubtrees"
  >,
): AgentWorkspacePermissionGuard {
  const allowedSubtrees = [...new Set(options.allowedDocumentSubtrees)];
  const allowedRoots = allowedSubtrees.map((subtree) => ({
    subtree,
    path: resolve(options.dataRoot, subtree),
  }));

  const assertWorkspacePath = async (
    requestedPath: string,
    pathOptions: AssertWorkspacePathOptions,
  ): Promise<string> => {
    if (
      requestedPath.length === 0 ||
      requestedPath.includes("\0") ||
      (!pathOptions.allowAbsolute && isAbsolute(requestedPath))
    ) {
      throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
    }

    const normalized = requestedPath.replaceAll("\\", "/");
    const targetPath = resolve(options.dataRoot, normalized);
    const requestedSubtree = isAbsolute(normalized)
      ? undefined
      : normalized.split("/", 1)[0];
    const allowedRoot = allowedRoots.find(({ subtree, path }) =>
      (requestedSubtree === undefined || subtree === requestedSubtree) &&
      isWithin(path, targetPath)
    );
    if (!allowedRoot) {
      throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
    }
    if (pathOptions.markdownOnly && !normalized.endsWith(".md")) {
      throw new Error(`Document must be a Markdown file: ${requestedPath}`);
    }

    const pathFromRoot = relative(allowedRoot.path, targetPath);
    assertNotExcludedArtifactPath(
      allowedRoot.subtree,
      pathFromRoot,
      requestedPath,
    );

    await assertNotSymlink(allowedRoot.path, "Document root");
    await assertNotSymlink(targetPath, "Document path");
    const [realRoot, realTarget] = await Promise.all([
      realpath(allowedRoot.path),
      realpath(targetPath),
    ]);
    if (!isWithin(realRoot, realTarget)) {
      throw new Error(`Document path is outside the allowed scope: ${requestedPath}`);
    }
    assertNotExcludedArtifactPath(
      allowedRoot.subtree,
      relative(realRoot, realTarget),
      requestedPath,
    );

    return realTarget;
  };

  const canUseTool: CanUseTool = async (toolName, input) => {
    try {
      if (toolName === "Read") {
        if (typeof input.file_path !== "string") {
          throw new Error("Read requires a file_path inside an allowed workspace subtree.");
        }
        await assertWorkspacePath(input.file_path, { allowAbsolute: true });
      } else if (toolName === "Grep") {
        if (typeof input.path !== "string") {
          throw new Error("Grep requires an explicit path inside an allowed workspace subtree.");
        }
        await assertWorkspacePath(input.path, { allowAbsolute: true });
      } else if (toolName === "mcp__diary__read_doc") {
        if (typeof input.path !== "string") {
          throw new Error("read_doc requires a path inside an allowed workspace subtree.");
        }
        await assertWorkspacePath(input.path, {
          allowAbsolute: false,
          markdownOnly: true,
        });
      } else if (toolName === "mcp__diary__commit") {
        assertDreamCommitToolFields(input);
      } else {
        throw new Error(`Tool is outside the allowed dream agent tool scope: ${toolName}`);
      }

      return { behavior: "allow", updatedInput: input };
    } catch (error) {
      return permissionDenied(error);
    }
  };

  return { assertWorkspacePath, canUseTool };
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
  const permissionGuard = createAgentWorkspacePermissionGuard(options);

  return {
    recall,
    timeline,
    canUseTool: permissionGuard.canUseTool,
    ...(options.commit ? { commit: options.commit } : {}),
    async readDoc(requestedPath) {
      const realTarget = await permissionGuard.assertWorkspacePath(requestedPath, {
        allowAbsolute: false,
        markdownOnly: true,
      });

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

export function createDreamAgentToolHandlers(
  options: CreateDreamAgentToolHandlersOptions,
): DiaryAgentToolHandlers {
  return createDiaryAgentToolHandlers({
    ...options,
    allowedDocumentSubtrees: DREAM_AGENT_DOCUMENT_SUBTREES,
  });
}
