import type { ReplayParseResult } from "../parser";
import {
  filterReplayTurns,
  getFieldContext,
  parseFieldSpec,
  renderQueryCell,
  type QueryFilters,
} from "../fields";

export interface QueryOptions extends QueryFilters {
  fields?: string;
}

export function renderReplayQuery(result: ReplayParseResult, options: QueryOptions = {}): string {
  const fields = parseFieldSpec(options.fields ?? "");
  const turns = filterReplayTurns(result, options);
  const context = getFieldContext(result);

  const lines = [fields.map((field) => field.def.name).join("\t")];

  for (const turn of turns) {
    lines.push(
      fields
        .map((field) => renderQueryCell(field.def.extract(turn, context), field.cap))
        .join("\t"),
    );
  }

  return lines.join("\n");
}
