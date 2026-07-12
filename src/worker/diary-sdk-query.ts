import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { encodeSource } from "../diary/domain";
import { resolveClaudeCodeExecutablePath } from "./agent-session";
import type { DiaryAgentQueryRequest } from "./diary-agent-runner";
import type { DiaryAgentTurn } from "./diary-agent-tools";

const DIARY_ALLOWED_TOOLS = [
  "mcp__diary__read_turn",
  "mcp__diary__read_diary",
] as const;

export interface CreateDiarySdkQueryOptions {
  dataRoot: string;
  queryImpl?: typeof query;
  createSdkMcpServerImpl?: typeof createSdkMcpServer;
  toolImpl?: typeof tool;
}

export interface DiarySdkQuery {
  runQuery(request: DiaryAgentQueryRequest): Promise<string>;
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function encodeNullableSource(value: string | null): string {
  return value === null ? "null" : encodeSource(value);
}

function serializeTurn(turn: DiaryAgentTurn): string {
  return [
    `{"sessionId":${turn.sessionId}`,
    `"promptNumber":${turn.promptNumber}`,
    `"userPrompt":${encodeNullableSource(turn.userPrompt)}`,
    `"assistantResponse":${encodeNullableSource(turn.assistantResponse)}}`,
  ].join(",");
}

export function createDiarySdkQuery(
  options: CreateDiarySdkQueryOptions,
): DiarySdkQuery {
  const queryImpl = options.queryImpl ?? query;
  const createSdkMcpServerImpl =
    options.createSdkMcpServerImpl ?? createSdkMcpServer;
  const toolImpl = options.toolImpl ?? tool;

  return {
    async runQuery(request) {
      const abortController = new AbortController();
      const forwardAbort = (): void => {
        abortController.abort(request.signal.reason);
      };

      if (request.signal.aborted) {
        forwardAbort();
      } else {
        request.signal.addEventListener("abort", forwardAbort, { once: true });
      }

      const diaryServer = createSdkMcpServerImpl({
        name: "diary",
        version: "0.3.2",
        tools: [
          toolImpl(
            "read_turn",
            "Read one allow-listed turn by session and prompt number.",
            {
              session_id: z.number().int().positive(),
              prompt_number: z.number().int().nonnegative(),
            },
            async ({ session_id, prompt_number }) =>
              textResult(
                serializeTurn(
                  request.toolHandlers.readTurn(session_id, prompt_number),
                ),
              ),
          ),
          toolImpl(
            "read_diary",
            "Read one allow-listed canonical diary by date.",
            { date: z.string() },
            async ({ date }) =>
              textResult(
                new TextDecoder().decode(
                  await request.toolHandlers.readDiary(date),
                ),
              ),
          ),
        ],
      });

      try {
        const execution = queryImpl({
          prompt: request.prompt,
          options: {
            model: request.model,
            cwd: options.dataRoot,
            // The bundled CJS worker breaks the SDK's import.meta.url-based CLI
            // resolution ("url must be of type string"); resolve explicitly,
            // matching query-session.
            pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
            tools: [],
            allowedTools: [...DIARY_ALLOWED_TOOLS],
            mcpServers: { diary: diaryServer },
            abortController,
          },
        });
        let envelope: string | null = null;

        for await (const message of execution as AsyncIterable<SDKMessage>) {
          request.reportActivity();

          if (message.type !== "result") {
            continue;
          }

          if (message.subtype !== "success") {
            throw new Error(
              `Diary SDK query failed (${message.subtype}): ${message.errors.join("; ")}`,
            );
          }

          if (message.is_error) {
            throw new Error(
              `Diary SDK query returned an error result: ${message.result}`,
            );
          }

          envelope = message.result;
        }

        if (envelope === null) {
          throw new Error("Diary SDK query completed without a result envelope.");
        }

        return envelope;
      } finally {
        request.signal.removeEventListener("abort", forwardAbort);
      }
    },
  };
}
