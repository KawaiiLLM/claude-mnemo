import type { Database } from "bun:sqlite";

import { estimateDiaryTokens, findDiaryCitationGroups } from "./domain";
import {
  EXPERIENCE_INJECTION_TOKEN_BUDGET,
  PERSONA_INJECTION_TOKEN_BUDGET,
  PROFILE_INJECTION_TOKEN_BUDGET,
} from "./persona-render";

export {
  EXPERIENCE_INJECTION_TOKEN_BUDGET,
  PERSONA_INJECTION_TOKEN_BUDGET,
  PROFILE_INJECTION_TOKEN_BUDGET,
};

const PROFILE_HEADINGS = [
  "## 身份与背景",
  "## 专长与判断力",
  "## 品味与兴趣",
  "## 沟通风格",
  "## 协作偏好",
] as const;

export function isValidProfileInjectionSource(userProfile: string): boolean {
  const lines = userProfile
    .trim()
    .split(/\r?\n/);
  const headings = lines.filter((line) => /^##\s/.test(line));
  return (
    headings.length === PROFILE_HEADINGS.length &&
    headings.every((heading, index) => heading === PROFILE_HEADINGS[index]) &&
    lines.every((line) =>
      line === "" || /^##\s/.test(line) ||
      (line.startsWith("- ") && findDiaryCitationGroups(line).length === 1),
    )
  );
}

export function renderProfileInjection(userProfile: string): string {
  return ["## Persona", "", userProfile.trim()].join("\n");
}

export interface RecentLine {
  kind: "daily" | "monthly";
  date: string;
  text: string;
}

interface ExperienceUnit {
  kind: "impression" | "general" | "project";
  lines: string[];
  documentOrder: number;
  age: number;
  removed: boolean;
  sourceProjectOrder?: number;
  sourceLineIndexes?: number[];
}

interface ParsedExperience {
  projectHeading: string;
  projectUnits: ExperienceUnit[];
  generalHeading: string;
  generalUnits: ExperienceUnit[];
}

function citationAge(db: Database, lines: readonly string[]): number {
  const ages: number[] = [];
  for (const group of findDiaryCitationGroups(lines.join("\n"))) {
    for (const reference of group.refs) {
      const match = reference.match(/^S(\d+)\/T(\d+)$/)!;
      const row = db
        .query<{ createdAtEpoch: number }, [number, number]>(
          `SELECT t.created_at_epoch AS createdAtEpoch
           FROM turns t
           WHERE t.session_id = ? AND t.prompt_number = ?`,
        )
        .get(Number(match[1]), Number(match[2]));
      ages.push(row?.createdAtEpoch ?? Number.NEGATIVE_INFINITY);
    }
  }
  return ages.length > 0 ? Math.max(...ages) : Number.NEGATIVE_INFINITY;
}

function isContinuation(line: string): boolean {
  return /^\s+/.test(line);
}

function parseExperience(experience: string, db: Database): ParsedExperience | null {
  const lines = experience.trim().split(/\r?\n/);
  const projectHeadingIndex = lines.indexOf("## 项目");
  const generalHeadingIndex = lines.indexOf("## 通用");
  if (
    projectHeadingIndex !== 0 ||
    generalHeadingIndex <= projectHeadingIndex ||
    lines.filter((line) => line === "## 项目").length !== 1 ||
    lines.filter((line) => line === "## 通用").length !== 1 ||
    lines.some((line) => /^##\s/.test(line) && line !== "## 项目" && line !== "## 通用")
  ) {
    return null;
  }

  let documentOrder = 0;
  const projectUnits: ExperienceUnit[] = [];
  const projectLines = lines.slice(1, generalHeadingIndex);
  for (let index = 0; index < projectLines.length;) {
    if (projectLines[index]!.trim() === "") {
      index += 1;
      continue;
    }
    if (!projectLines[index]!.startsWith("- ")) return null;
    const block = [projectLines[index]!];
    index += 1;
    while (index < projectLines.length && isContinuation(projectLines[index]!)) {
      block.push(projectLines[index]!);
      index += 1;
    }
    const progress = block.find((line) => /^\s+- 进度：/.test(line));
    const pathLines = block.filter((line) => /^\s+- 路径：/.test(line));
    const progressLines = block.filter((line) => /^\s+- 进度：/.test(line));
    const feedbackLines = block.filter((line) => /^\s+- 反馈：/.test(line));
    if (!progress || pathLines.length !== 1 || progressLines.length !== 1 || feedbackLines.length > 2) return null;
    try {
      const paths = JSON.parse(pathLines[0]!.replace(/^\s+- 路径：/, ""));
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path.startsWith("/"))) return null;
    } catch {
      return null;
    }
    if (
      findDiaryCitationGroups(block[0]!).length !== 1 ||
      findDiaryCitationGroups(progress).length !== 1 ||
      feedbackLines.some((line) => findDiaryCitationGroups(line).length !== 1) ||
      block.slice(1).some((line) =>
        /^\s+- /.test(line) &&
        !/^\s+- (?:路径：|进度：|反馈：|\[\d{4}-\d{2}\]\s)/.test(line),
      )
    ) return null;
    projectUnits.push({
      kind: "project",
      lines: block,
      documentOrder: documentOrder++,
      age: citationAge(db, [progress]),
      removed: false,
    });
  }

  const impressionUnits: ExperienceUnit[] = [];
  for (const project of projectUnits) {
    for (let index = 1; index < project.lines.length;) {
      const line = project.lines[index]!;
      if (!/^\s+- \[\d{4}-\d{2}\]\s/.test(line)) {
        index += 1;
        continue;
      }
      const unitLines = [line];
      let end = index + 1;
      while (end < project.lines.length && /^\s{4,}\S/.test(project.lines[end]!) && !/^\s+- /.test(project.lines[end]!)) {
        unitLines.push(project.lines[end]!);
        end += 1;
      }
      if (findDiaryCitationGroups(unitLines.join("\n")).length !== 1) return null;
      impressionUnits.push({
        kind: "impression",
        lines: unitLines,
        documentOrder: documentOrder++,
        age: citationAge(db, unitLines),
        removed: false,
        sourceProjectOrder: project.documentOrder,
        sourceLineIndexes: Array.from(
          { length: end - index },
          (_, offset) => index + offset,
        ),
      });
      index = end;
    }
  }

  const generalUnits: ExperienceUnit[] = [];
  const generalLines = lines.slice(generalHeadingIndex + 1);
  for (let index = 0; index < generalLines.length;) {
    if (generalLines[index]!.trim() === "") {
      index += 1;
      continue;
    }
    if (!generalLines[index]!.startsWith("- ")) return null;
    const unitLines = [generalLines[index]!];
    index += 1;
    while (index < generalLines.length && isContinuation(generalLines[index]!)) {
      unitLines.push(generalLines[index]!);
      index += 1;
    }
    generalUnits.push({
      kind: "general",
      lines: unitLines,
      documentOrder: documentOrder++,
      age: citationAge(db, unitLines),
      removed: false,
    });
    if (findDiaryCitationGroups(unitLines.join("\n")).length !== 1) return null;
  }

  return {
    projectHeading: "## 项目",
    projectUnits: [...projectUnits, ...impressionUnits],
    generalHeading: "## 通用",
    generalUnits,
  };
}

function renderExperienceBody(parsed: ParsedExperience): string {
  const removedImpressionLines = new Map<number, Set<number>>();
  for (const unit of
    parsed.projectUnits
      .filter((candidate) => candidate.kind === "impression" && candidate.removed)) {
    const indexes = removedImpressionLines.get(unit.sourceProjectOrder!) ?? new Set<number>();
    for (const index of unit.sourceLineIndexes!) indexes.add(index);
    removedImpressionLines.set(unit.sourceProjectOrder!, indexes);
  }
  const projects = parsed.projectUnits
    .filter((unit) => unit.kind === "project" && !unit.removed)
    .flatMap((unit) => {
      const removedIndexes = removedImpressionLines.get(unit.documentOrder);
      return unit.lines.filter((_, index) => !removedIndexes?.has(index));
    });
  const general = parsed.generalUnits
    .filter((unit) => !unit.removed)
    .flatMap((unit) => unit.lines);
  return [parsed.projectHeading, ...projects, parsed.generalHeading, ...general].join("\n");
}

function renderExperienceInjection(body: string, recent: readonly RecentLine[]): string {
  return [
    "## Experience",
    "",
    body,
    "",
    "## 近期",
    "",
    ...recent.map((line) => line.text),
  ].join("\n");
}

function orderedOldestFirst(units: ExperienceUnit[]): ExperienceUnit[] {
  return units
    .slice()
    .sort((left, right) => left.age - right.age || left.documentOrder - right.documentOrder);
}

export function renderTrimmedExperienceInjection(input: {
  db: Database;
  experience: string;
  recentLines: readonly RecentLine[];
  profileBlock: string;
}): string | null {
  const parsed = parseExperience(input.experience, input.db);
  if (!parsed) return null;
  const recent = input.recentLines.map((line) => ({ ...line }));
  const render = () => renderExperienceInjection(renderExperienceBody(parsed), recent);
  const withinBudget = (rendered: string) =>
    estimateDiaryTokens(rendered) <= EXPERIENCE_INJECTION_TOKEN_BUDGET &&
    estimateDiaryTokens(`${input.profileBlock}\n\n${rendered}`) <= PERSONA_INJECTION_TOKEN_BUDGET;

  let rendered = render();
  const trimRecent = (kind: RecentLine["kind"]) => {
    const candidates = recent
      .filter((line) => line.kind === kind)
      .sort((left, right) => left.date.localeCompare(right.date));
    for (const candidate of candidates) {
      if (withinBudget(rendered)) break;
      recent.splice(recent.indexOf(candidate), 1);
      rendered = render();
    }
  };
  trimRecent("monthly");
  trimRecent("daily");

  const impressionUnits = orderedOldestFirst(
    parsed.projectUnits.filter((unit) => unit.kind === "impression"),
  );
  const stages = [
    impressionUnits,
    orderedOldestFirst(parsed.generalUnits),
    orderedOldestFirst(parsed.projectUnits.filter((unit) => unit.kind === "project")),
  ];
  for (const units of stages) {
    for (const unit of units) {
      if (withinBudget(rendered)) break;
      unit.removed = true;
      rendered = render();
    }
  }
  return withinBudget(rendered) ? rendered : null;
}

export function buildRollingRecentLines(indexText: string, today: string): RecentLine[] {
  const rows = indexText
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^- (\d{4}-\d{2}-\d{2})：(.*)$/);
      return match ? [{ date: match[1]!, hook: match[2]! }] : [];
    })
    .filter((row) => row.date < today)
    .sort((left, right) => right.date.localeCompare(left.date));
  const recentStart = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const daily: RecentLine[] = rows
    .filter((row) => row.date >= recentStart)
    .map((row) => ({ kind: "daily", date: row.date, text: `- ${row.date}：${row.hook}` }));
  const monthHooks = new Map<string, string[]>();
  for (const row of rows.filter((candidate) => candidate.date < recentStart)) {
    const month = row.date.slice(0, 7);
    if (!monthHooks.has(month)) {
      if (monthHooks.size >= 6) continue;
      monthHooks.set(month, []);
    }
    const hooks = monthHooks.get(month)!;
    if (hooks.length < 3 && !hooks.includes(row.hook)) hooks.push(row.hook);
  }
  return [
    ...daily,
    ...[...monthHooks].map(([month, hooks]): RecentLine => ({
      kind: "monthly",
      date: month,
      text: `- ${month}：${Array.from(hooks.join("；")).slice(0, 240).join("")}`,
    })),
  ];
}
