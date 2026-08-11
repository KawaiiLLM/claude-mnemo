/**
 * An observation's stored payload, projected into the call it was.
 *
 * What the database keeps is what the hook captured: the tool's input JSON and
 * its result JSON, verbatim. Printing those is what a reader used to get, and
 * it is unreadable — escaped newlines, structural keys, and, for the
 * file-editing tools, a verbatim copy of the input followed by the beginning of
 * the whole pre-edit file. The cost lands twice: characters that carry no
 * meaning, and the meaning the reader came for pushed past the truncation
 * window.
 *
 * The projection is a pure function of the two stored strings — no database, no
 * renderer, no clock — so it can be tested against real captured payloads
 * directly. Nothing about storage changes; the replay skill is still how you
 * get exact bytes.
 *
 * It returns a header and a body, NOT an input and an output. That is the
 * decision the prototype forced: with the `- in:` / `- out:` labels gone, a
 * version that projected each stored side separately rendered an `Edit` with
 * its diff missing, because the meaningful content of an edit lives in its
 * *input* and a body drawn from the result had nothing to show. So the header
 * is the call's identifying argument and the body is whatever is worth reading,
 * from whichever side happens to hold it.
 */

export interface ProjectedCall {
  /**
   * The whole first line: the tool name carrying its identifying argument.
   *
   * It includes the name rather than leaving the renderer to add it, because
   * whether a tool HAS an identifying argument is the projection's knowledge:
   * `EnterPlanMode` stores `{}` as its entire input, and only a projection that
   * owns the composition can render it as `EnterPlanMode` instead of
   * `EnterPlanMode()`. It also makes "every era tool produces a non-empty
   * header" a property that holds by construction.
   */
  header: string;
  /** Body lines, blank ones already dropped, none of them budget-aware. */
  body: string[];
}

/** What a per-tool rule produces; the caller composes the header from it. */
interface CallDetail {
  argument: string;
  body: string[];
}

/**
 * A rule is scoped to (tool, side, key) and never to a key name alone. The
 * survey settles this with counts: `content` is a whole file to be dropped in
 * `Write`'s input, the note's text to be kept in `note`'s input, and the final
 * report only when `status` is `completed` in `Agent`'s result. `description`
 * restates the command in `Bash` and is the task's title in `Agent`. `type` is
 * a useful create/update flag in `Write`'s result and the constant `"text"` in
 * `Read`'s. A global key denylist was tried in the prototype and silently
 * removed `Agent`'s title.
 *
 * Returning `null` means "this payload is not the shape I know" and hands the
 * call to the generic rule. That is the whole safety story for a projection
 * that encodes an external contract: Claude Code's payload shapes will move,
 * and a rule that reached for a key that had been renamed would otherwise
 * render an empty body — silently claiming the call did nothing.
 */
type ProjectionRule = (
  input: unknown,
  result: unknown,
) => CallDetail | null;

/**
 * Said when a dispatched agent's result carries no report. In 11 of 13 sampled
 * rows an `Agent` result is a launch stub whose `status` is `async_launched`,
 * pointing at an ephemeral temporary path; the completion report arrives later
 * as a turn-level notification and never becomes a second observation.
 * Rendering nothing would assert that the call returned nothing, which is
 * false.
 */
const AGENT_REPORT_ELSEWHERE =
  "report not stored with this call — it arrives later as a turn-level notification";

function parsePayload(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // The only outright parse failure in ~1,000 sampled rows: `StructuredOutput`
    // stores the bare sentence "Structured output provided successfully", not
    // JSON and not even a quoted JSON string. Its own text is the best render
    // of it, and a throw here would take down the whole response.
    return raw;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberField(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Split a value into renderable lines. Blank lines buy vertical space and nothing else. */
function toLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line !== "");
}

function singleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** The last path segment. The prefix repeats on every line of a render whose session header already names the project. */
function basename(filePath: string): string {
  const segments = filePath.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? filePath;
}

/**
 * The MCP content-block envelope, unwrapped to its text.
 *
 * Unconditional rather than per-tool: every `mcp__*` result in both the era and
 * the legacy sample is this array, which is the protocol's shape and not any
 * one tool's. The item guard is required, not defensive tidiness — `WebSearch`
 * stores an array whose items mix `{tool_use_id, content}` objects with bare
 * narration strings, and a naive `.map(item => item.text)` throws on it.
 */
function contentArrayText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const texts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record && typeof record.text === "string") {
      texts.push(record.text);
    }
  }

  return texts.length > 0 ? texts.join("\n") : null;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  const record = asRecord(value);
  return record !== null && Object.keys(record).length === 0;
}

function valueText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/**
 * The generic rule, which is what makes the table's coverage acceptable rather
 * than a completeness claim. A new tool in Claude Code degrades here instead of
 * breaking, and the degradation tests are what keep that honest.
 *
 * Empty, false and null fields are dropped because they are the flags a payload
 * carries in its default state — `interrupted`, `isImage`, `userModified` are
 * `false` in every sampled row and say nothing by being there. What remains is
 * either one value, which prints bare because a lone `key:` label restates the
 * call, or several, which print as labelled fields because at that point the
 * names are the only thing telling them apart.
 */
function genericLines(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  const unwrapped = contentArrayText(value);
  if (unwrapped !== null) {
    return toLines(unwrapped);
  }

  if (typeof value === "string") {
    return toLines(value);
  }

  const record = asRecord(value);
  if (record) {
    const entries = Object.entries(record).filter(
      ([, entryValue]) => !isEmptyValue(entryValue),
    );
    if (entries.length === 0) {
      return [];
    }
    if (entries.length === 1) {
      return toLines(valueText(entries[0]![1]));
    }
    return entries.map(
      ([key, entryValue]) => `${key}: ${singleLine(valueText(entryValue))}`,
    );
  }

  return isEmptyValue(value) ? [] : toLines(valueText(value));
}

function genericDetail(input: unknown, result: unknown): CallDetail {
  return {
    argument: singleLine(genericLines(input).join(" ")),
    body: genericLines(result),
  };
}

const PROJECTION_RULES: Record<string, ProjectionRule> = {
  /**
   * 61% of every observation recorded since the cutover. Header from the input,
   * body from the result — the case the header/body interface exists for.
   * `description` is left out: it restates the command that is already there.
   */
  Bash: (input, result) => {
    const command = stringField(asRecord(input), "command");
    if (!command) {
      return null;
    }

    const output = asRecord(result);
    if (!output) {
      return { argument: singleLine(command), body: genericLines(result) };
    }

    const body = toLines(
      typeof output.stdout === "string" ? output.stdout : "",
    );
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    if (stderr.trim() !== "") {
      // Labelled and collapsed to one line: empty in 93% of rows, and when it
      // is set it is a diagnostic that must not read as part of the output.
      body.push(`stderr: ${singleLine(stderr)}`);
    }

    return { argument: singleLine(command), body };
  },

  /**
   * The single largest saving in the change. An `Edit` result is a verbatim
   * duplicate of its input — `oldString`/`newString`/`filePath` matched in 62 of
   * 62 sampled rows — plus `originalFile`, the entire pre-edit file, at a median
   * of 23,494 characters against `old_string`'s median of 172. It therefore
   * contributes nothing: everything worth reading is in the call.
   */
  Edit: (input) => {
    const record = asRecord(input);
    const filePath = stringField(record, "file_path");
    const oldString = record && typeof record.old_string === "string"
      ? record.old_string
      : null;
    const newString = record && typeof record.new_string === "string"
      ? record.new_string
      : null;
    if (!filePath || oldString === null || newString === null) {
      return null;
    }

    return {
      argument: basename(filePath),
      body: [
        ...toLines(oldString).map((line) => `- ${line}`),
        ...toLines(newString).map((line) => `+ ${line}`),
      ],
    };
  },

  /**
   * Body from the input, which is also what makes a create render correctly:
   * `originalFile` is `null` on 24 of 30 sampled rows, so anything reaching for
   * the pre-edit file renders empty on the majority case.
   */
  Write: (input) => {
    const record = asRecord(input);
    const filePath = stringField(record, "file_path");
    const content = record && typeof record.content === "string"
      ? record.content
      : null;
    if (!filePath || content === null) {
      return null;
    }

    return { argument: basename(filePath), body: toLines(content) };
  },

  /**
   * The one tool whose result is pure bulk relative to its call: the input is a
   * median 98 characters and the result a median 1,366, all of it the file slice
   * the reader already has in context from the read itself. What they do not
   * have is which part of the file it was.
   */
  Read: (input, result) => {
    const filePath = stringField(asRecord(input), "file_path");
    if (!filePath) {
      return null;
    }

    const file = asRecord(asRecord(result)?.file);
    const numLines = numberField(file, "numLines");
    if (numLines === null) {
      // Not the shape we know (an image read, or an upstream change): the
      // generic rule renders it rather than this one claiming a line count it
      // does not have.
      return null;
    }

    const startLine = numberField(file, "startLine");
    const totalLines = numberField(file, "totalLines");
    const range = startLine === null
      ? null
      : `${startLine}–${startLine + numLines - 1}${totalLines === null ? "" : ` of ${totalLines}`}`;

    return {
      argument: basename(filePath),
      body: [range === null ? `${numLines} lines` : `${numLines} lines (${range})`],
    };
  },

  /**
   * The task's own description, never the prompt — the prompt is a median 2,923
   * characters of instructions the reader wrote and does not need read back.
   * The result is genuinely two shapes gated on how the agent was dispatched.
   */
  Agent: (input, result) => {
    const description = stringField(asRecord(input), "description");
    if (!description) {
      return null;
    }

    const report = contentArrayText(asRecord(result)?.content);
    return {
      argument: description,
      body: report === null ? [AGENT_REPORT_ELSEWHERE] : toLines(report),
    };
  },

  /**
   * Keyed on the MCP base name (see `mcpBaseName`). The call's point is which
   * turn it wrote about and what it claimed; the note body itself is a median
   * 1,170 characters that the turn's own fields already carry.
   */
  note: (input, result) => {
    const record = asRecord(input);
    const turn = stringField(record, "turn");
    const title = stringField(record, "title");
    if (!turn && !title) {
      return null;
    }

    const receipt = contentArrayText(result);
    return {
      argument: [turn, title].filter(Boolean).join(" "),
      body: receipt === null ? genericLines(result) : toLines(receipt),
    };
  },
};

/**
 * The trailing segment of an `mcp__*` name — `note` for
 * `mcp__plugin_claude-mnemo_mnemo__note`.
 *
 * The prefix encodes the marketplace and the server, which are deployment
 * facts: the same tool is called something else under another plugin id, and a
 * table keyed on the full name would quietly stop matching after a rename. A
 * same-named tool from a different server that happens to match here is safe by
 * construction — its payload will not have the keys the rule requires, and it
 * falls through to the generic rule.
 */
function mcpBaseName(toolName: string): string {
  if (!toolName.startsWith("mcp__")) {
    return "";
  }
  const index = toolName.lastIndexOf("__");
  return index > 0 ? toolName.slice(index + 2) : "";
}

function composeHeader(toolName: string, argument: string): string {
  if (!toolName) {
    return argument;
  }
  return argument ? `${toolName}(${argument})` : toolName;
}

export function projectToolCall(
  toolName: string,
  toolInput: string | null | undefined,
  toolResult: string | null | undefined,
): ProjectedCall {
  const input = parsePayload(toolInput);
  const result = parsePayload(toolResult);
  const rule =
    PROJECTION_RULES[toolName] ?? PROJECTION_RULES[mcpBaseName(toolName)];
  const detail = (rule ? rule(input, result) : null) ?? genericDetail(input, result);

  return { header: composeHeader(toolName, detail.argument), body: detail.body };
}
