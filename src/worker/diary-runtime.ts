import type { Database } from "bun:sqlite";

import { createDiaryStateStore } from "../db/diary-state";
import type { PendingQueueItem } from "../db/pending-queue";
import { DiaryFileStore } from "../diary/file-store";
import {
  createDiaryAgentRunner,
  type DiaryAgentQueryRequest,
} from "./diary-agent-runner";
import { createDiaryAgentToolHandlers } from "./diary-agent-tools";
import { createDiaryJobProcessor } from "./diary-job";
import { createDiarySdkQuery } from "./diary-sdk-query";
import {
  createPersonaMaintainer,
  buildPersonaAllowSets,
  type PersonaMaintenanceResult,
  type PersonaRunRequest,
} from "./persona-maintenance";
import { CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE } from "./prompt-wire-format";

export interface CreateDiaryRuntimeOptions {
  db: Database;
  dataRoot: string;
  runQuery?: (request: DiaryAgentQueryRequest) => Promise<string>;
  nowEpoch?: () => number;
  personaRequestGateTokens?: number;
  personaRequestOverheadTokens?: number;
  personaAccumulatorReserveTokens?: number;
}

export interface DiaryRuntime {
  processDiaryItem(item: PendingQueueItem): Promise<void>;
  runPersonaMaintenance(): Promise<PersonaMaintenanceResult>;
}

export const PERSONA_V1_POLICY_LINES = [
  "USER_PROFILE_V1 全文以第三人称描述「用户」，禁止出现「我」；其中的特征、行为和偏好都属于用户。",
  "EXPERIENCE_V1 中的「我」始终只指 agent 的经历视角，用户一律称为「用户」，不得用「我」代指用户。",
  "项目 lead bullet 的一句话印象必须是概括性总结，不得与任何 dated impression bullet 重复表述；可以复用同一引用，但措辞必须保持概括层级。",
  "反馈：只记录协作中的纠正或教训；设计决策必须写入 dated impressions 或进度，不得写入反馈。",
  "进度：只记录项目当前状态，不得混入成本估算或其他旁支事实。",
] as const;

export function buildPersonaPrompt(request: PersonaRunRequest): string {
  const lines = [
    "Maintain the two person-memory documents from the supplied trusted artifacts.",
    `op: ${request.op}`,
    "Return exactly one USER_PROFILE_V1 block followed by one EXPERIENCE_V1 block; both blocks are required.",
    "Use this exact copy-pasteable wire format, replacing only bullet placeholder text:",
    ...CANONICAL_PERSONA_WIRE_FORMAT_EXAMPLE.split("\n"),
    "Do not use code fences. Do not write any text before, between, or after these two adjacent blocks. USER_PROFILE_V1 must come first and EXPERIENCE_V1 second.",
    "USER_PROFILE_V1 must contain exactly these level-2 headings in order: 身份与背景, 专长与判断力, 品味与兴趣, 沟通风格, 协作偏好.",
    "EXPERIENCE_V1 must contain exactly these level-2 headings in order: 项目, 通用.",
    ...PERSONA_V1_POLICY_LINES,
    "Under 项目, write each project exactly as: - **<semantic project name>**：<one-sentence impression> [citation]; then sub-items indented with exactly four ASCII spaces: - 路径：[\"/absolute/path\"] as a JSON string-array line; exactly one - 进度：<current state> [citation]; zero to two - 反馈：<collaboration lessons joined by semicolons> [citation] lines; and - [YYYY-MM] <impression event> [citation] lines.",
    "On every fold, overwrite the project's single 进度 line; never accumulate progress history.",
    "Admission: every bullet states one fact only. Exclude diagnostic observations and meta observations about the memory process. Put projectless material and cross-project lessons in 通用, even when learned in a project session.",
    "The same evidence may be written at two abstraction levels (a profile trait and a supporting experience), but deduplicate within each file.",
    "When new evidence reinforces an existing trait, append its citation to that line instead of adding a duplicate. For contradictions, retain the old line and append （已变化）. If a diary source path matches any path of an existing project, merge into that project (renaming is allowed) and preserve the union of paths.",
    "Decay only when necessary: first merge the weakest project impression upward into the project's lead impression sentence, carrying its citations, then evict that impression. In 通用 evict weakest-supported first, then oldest.",
    "Archive a long-inactive project as exactly its lead line, its 路径 line, and one 进度：已归档——<one sentence> line; remove feedback and dated impressions. Never decay progress or feedback independently.",
  ];

  if (request.validatorFeedback) {
    lines.push(JSON.stringify({ kind: "persona_validator_feedback", ...request.validatorFeedback }));
  }

  if ("previousPersona" in request) {
    lines.push(
      JSON.stringify({
        kind: "previous_user_profile",
        text: request.previousPersona.userProfile,
      }),
      JSON.stringify({
        kind: "previous_experience",
        text: request.previousPersona.experience,
      }),
    );
  }

  if ("accumulator" in request && request.accumulator !== undefined) {
    lines.push(
      JSON.stringify({
        kind: "previous_accumulator",
        userProfile: request.accumulator.userProfile,
        experience: request.accumulator.experience,
      }),
    );
  }

  for (const diary of request.diaries) {
    lines.push(
      JSON.stringify({
        kind: "diary",
        date: diary.date,
        text: diary.content,
      }),
    );
  }

  return lines.join("\n");
}

export function createDiaryRuntime(
  options: CreateDiaryRuntimeOptions,
): DiaryRuntime {
  const stateStore = createDiaryStateStore(options.db);
  const fileStore = new DiaryFileStore(options.dataRoot);
  const runQuery =
    options.runQuery ??
    createDiarySdkQuery({ dataRoot: options.dataRoot }).runQuery;
  const agentRunner = createDiaryAgentRunner({ runQuery });
  const diaryJob = createDiaryJobProcessor({
    db: options.db,
    stateStore,
    fileStore,
    agentRunner,
    nowEpoch: options.nowEpoch,
  });
  const personaMaintainer = createPersonaMaintainer({
    stateStore,
    fileStore,
    nowEpoch: options.nowEpoch,
    requestGateTokens: options.personaRequestGateTokens,
    requestOverheadTokens: options.personaRequestOverheadTokens,
    accumulatorReserveTokens: options.personaAccumulatorReserveTokens,
    async runPersona(request) {
      const prompt = buildPersonaPrompt(request);
      const { allowedTurnRefs } = buildPersonaAllowSets(request);
      const allowedDiaryDates = new Set(
        request.diaries.map((diary) => diary.date),
      );
      const toolHandlers = createDiaryAgentToolHandlers({
        db: options.db,
        stateStore,
        allowedTurnRefs,
        fileStore,
        allowedDiaryDates,
      });

      return agentRunner.run({
        date: request.diaries.at(-1)?.date ?? "persona",
        prompt,
        toolHandlers,
      });
    },
  });

  return {
    processDiaryItem: (item) => diaryJob.process(item),
    runPersonaMaintenance: () => personaMaintainer.runPersonaMaintenance(),
  };
}
