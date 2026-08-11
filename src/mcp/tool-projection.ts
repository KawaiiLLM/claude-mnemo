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
 * A rule may claim a payload only if it fully recognises it. What it does not
 * recognise falls through — by returning `null` for the whole call, or by
 * handing the side it does not know to `genericLines` — and the generic rule
 * never drops content it cannot classify. That is the whole safety story for a
 * projection encoding an external contract: Claude Code's payload shapes will
 * move, and a rule that matched on a partial signal and discarded the rest
 * rendered an empty body, silently claiming the call did nothing. An empty body
 * has to mean "this call produced nothing", never "the projection did not
 * understand the result".
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

/**
 * The mark left where a value's line break was.
 *
 * It is not decoration. `echo one` newline `echo two` is two commands, and
 * collapsing that on whitespace rendered `Bash(echo one echo two)` — one `echo`
 * with four arguments, which is a different command that could plausibly have
 * been run. Losing the boundary in a one-line slot is acceptable; inventing a
 * valid-looking different call is not. Joining with `; ` is the same mistake in
 * a subtler form: the corpus has newlines inside quoted heredoc and SQL
 * strings, where a semicolon changes what the command means.
 */
const LINE_BREAK_MARK = "↵";

/** A value flattened to one line, with its line breaks left visible. */
function singleLine(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line !== "")
    .join(LINE_BREAK_MARK);
}

/** The last path segment. The prefix repeats on every line of a render whose session header already names the project. */
function basename(filePath: string): string {
  const segments = filePath.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? filePath;
}

/**
 * The MCP content-block envelope, unwrapped to its text — and only when every
 * item in the array is a block carrying text.
 *
 * Unconditional rather than per-tool: every `mcp__*` result in both the era and
 * the legacy sample is this array, which is the protocol's shape and not any
 * one tool's. "Every item" is the load-bearing word. Skipping the items it did
 * not recognise made `["warning", {"text":"ok"}, {"error":"failed"}]` render as
 * `ok` — two thirds of what the call returned dropped, with nothing in the
 * output to say so. `WebSearch` stores exactly such an array, its items mixing
 * `{tool_use_id, content}` objects with bare narration strings, so this is a
 * measured payload rather than a hypothetical. An array that is not uniformly
 * the envelope is not the envelope, and goes to the generic rule whole.
 */
function contentArrayText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const texts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.text !== "string") {
      return null;
    }
    texts.push(record.text);
  }

  return texts.join("\n");
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
    // Joined by the line mark for the reason `singleLine` carries one: these
    // were separate lines or separate fields, and a space claims they were one.
    argument: genericLines(input).map(singleLine).join(LINE_BREAK_MARK),
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
    const stdout = output && typeof output.stdout === "string"
      ? output.stdout
      : null;
    const stderr = output && typeof output.stderr === "string"
      ? output.stderr
      : "";
    if (stdout === null && stderr === "") {
      // Neither stream is where this rule knows to look, so it does not know
      // this payload and says nothing about it: the generic rule renders what
      // is there. `{"output":"permission denied"}` and `{"stdout":42}` both
      // used to reach the reader as an empty body, which claims a call produced
      // nothing while discarding the only thing it produced.
      return { argument: singleLine(command), body: genericLines(result) };
    }

    const body = toLines(stdout ?? "");
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

    const record = asRecord(result);
    const report = contentArrayText(record?.content);
    if (report !== null) {
      return { argument: description, body: toLines(report) };
    }

    // The promise of a later report is made only against the payload that
    // actually carries a dispatch — the launch stub, `status: async_launched`.
    // Made against any other result it is a lie the reader cannot detect:
    // `{"status":"completed","error":"crashed"}` used to render "it arrives
    // later as a turn-level notification" about a report that will never come.
    // Anything else is a shape this rule does not know, and the generic rule
    // renders it rather than this one narrating it.
    return stringField(record, "status") === "async_launched"
      ? { argument: description, body: [AGENT_REPORT_ELSEWHERE] }
      : { argument: description, body: genericLines(result) };
  },

  /**
   * Keyed on the whole tool name, server prefix included, because that is what
   * says whose payload this is. `note` is a common enough word that another
   * server will have one, and a rule matched on the trailing segment handed
   * `mcp__other_server__note` this projection — which reads its `turn` and its
   * `title` and drops everything else, exactly the "keyed on a name rather than
   * on the tool" error the survey's key-collision evidence forbids. The cost is
   * that a marketplace rename stops matching; what happens then is the generic
   * rule, verbose and true, which is the trade this projection makes everywhere
   * else too.
   *
   * The call's point is which turn it wrote about and what it claimed; the note
   * body itself is a median 1,170 characters that the turn's own fields carry.
   */
  "mcp__plugin_claude-mnemo_mnemo__note": (input, result) => {
    const record = asRecord(input);
    const turn = stringField(record, "turn");
    const title = stringField(record, "title");
    // `turn` is the key this tool is about and is present in every stored row;
    // without it this is not the payload the rule was written from.
    if (!turn) {
      return null;
    }

    const receipt = contentArrayText(result);
    return {
      argument: [turn, title].filter(Boolean).join(" "),
      body: receipt === null ? genericLines(result) : toLines(receipt),
    };
  },
};

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
  const rule = PROJECTION_RULES[toolName];
  const detail = (rule ? rule(input, result) : null) ?? genericDetail(input, result);

  return { header: composeHeader(toolName, detail.argument), body: detail.body };
}
