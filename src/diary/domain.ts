import { createHash } from "node:crypto";

const UTC_PLUS_EIGHT_SECONDS = 8 * 60 * 60;

export function diaryDayOf(epochSeconds: number): string {
  return new Date((epochSeconds + UTC_PLUS_EIGHT_SECONDS) * 1_000)
    .toISOString()
    .slice(0, 10);
}

export function encodeSource(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export interface DiaryWatermarkMaterial {
  turnId: number;
  status: string;
  userPrompt: string | null;
  assistantResponse: string | null;
  title: string | null;
  content: string | null;
  insight: string | null;
}

export function truncateDiaryResponse(value: string): string {
  return Array.from(value).slice(0, 2_000).join("");
}

export function computeDiaryWatermark(
  material: readonly DiaryWatermarkMaterial[],
): string {
  if (material.length === 0) return "empty";

  const turnHashes = [...material]
    .sort((left, right) => left.turnId - right.turnId)
    .map((turn) =>
      createHash("sha256")
        .update(
          [
            turn.userPrompt ?? "",
            truncateDiaryResponse(turn.assistantResponse ?? ""),
            turn.title ?? "",
            turn.content ?? "",
            turn.insight ?? "",
            turn.status,
          ].join("\u0000"),
        )
        .digest("hex"),
    );

  return createHash("sha256")
    .update(turnHashes.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

const MALFORMED_PRIVATE_CONTENT = "[redacted: malformed private content]";

export function stripDiaryPrivateContent(text: string): string {
  let privateBlockCount = 0;
  const stripped = text.replace(/<private>[\s\S]*?<\/private>/g, () => {
    privateBlockCount += 1;
    return "";
  });

  if (
    privateBlockCount > 100 ||
    stripped.includes("<private>") ||
    stripped.includes("</private>")
  ) {
    return MALFORMED_PRIVATE_CONTENT;
  }

  return stripped;
}

export function estimateDiaryTokens(text: string): number {
  let weightedCodePoints = 0;
  for (const codePoint of text) {
    weightedCodePoints += /\p{Script=Han}/u.test(codePoint) ? 1.1 : 0.6;
  }
  return Math.ceil(weightedCodePoints * 1.2);
}
