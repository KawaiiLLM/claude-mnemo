#!/usr/bin/env python3
"""
Analyze memory-agent JSONL logs for field-data reporting.

Reproduces the tables in `interview/claude-mem-vs-mnemo-field-data.md`.

Usage:
  scripts/analyze-memory-logs.py mnemo <dir>      # per-version mnemo (V0-V4)
  scripts/analyze-memory-logs.py mem <dir>        # claude-mem aggregate
  scripts/analyze-memory-logs.py per-turn <dir>   # raw per-turn (single dataset)

Inputs:
  - mnemo dir: ~/.claude/projects/-Users-<user>--claude-mnemo
  - mem dir:   ~/Downloads/-Users-<user>--claude-mem-observer-sessions
              (or ~/.claude-mem/observer-sessions/)

Both formats share the queue-operation + user/assistant entry envelope, but
mnemo emits tool_use blocks (mcp__mnemo__remember) while claude-mem emits
inline <observation>/<summary> XML in text blocks. Detection is mode-aware.

Pricing snapshot: 2026-04-15 (Sonnet/Opus/Haiku 4.5+ tiers). Update PRICING
below if tier prices change.
"""
import json
import os
import re
import sys
from collections import Counter, defaultdict

PRICING_SNAPSHOT_DATE = "2026-04-15"

# USD per 1M tokens. Match against assistant `message.model` prefix.
PRICING = {
    "claude-opus-4-6":   {"in": 15, "out": 75, "c5m": 18.75, "c1h": 30, "cr": 1.5},
    "claude-opus-4-5":   {"in": 15, "out": 75, "c5m": 18.75, "c1h": 30, "cr": 1.5},
    "claude-sonnet-4-6": {"in":  3, "out": 15, "c5m":  3.75, "c1h":  6, "cr": 0.30},
    "claude-sonnet-4-5": {"in":  3, "out": 15, "c5m":  3.75, "c1h":  6, "cr": 0.30},
    "claude-haiku-4-5":  {"in":  1, "out":  5, "c5m":  1.25, "c1h":  2, "cr": 0.10},
}

# mnemo version bands (UTC). Derived from `git log src/worker/ src/hooks/`.
# Commit time is +08:00, converted to UTC here. Code-effective time may lag
# commit time by 1-2 hours (build + worker restart needed).
MNEMO_BANDS = [
    ("V0_pre-batch",         "2000-01-01T00:00:00Z", "2026-04-12T17:25:00Z"),  # before e743530
    ("V1_batch_no_trunc",    "2026-04-12T17:25:00Z", "2026-04-13T09:55:00Z"),  # before 05a5c77
    ("V2_trunc+1h_cache",    "2026-04-13T09:55:00Z", "2026-04-15T06:42:00Z"),  # before 1dd4d74
    ("V3_adaptive_batch",    "2026-04-15T06:42:00Z", "2026-04-16T03:52:00Z"),  # before 6b2dff8
    ("V4_session_refresh",   "2026-04-16T03:52:00Z", "2099-01-01T00:00:00Z"),
]


def pricing_for(model):
    if not model:
        return None
    for prefix, p in PRICING.items():
        if model.startswith(prefix):
            return p
    return None


def cost_of(model, usage):
    p = pricing_for(model)
    if not p:
        return 0.0
    cc = usage.get("cache_creation", {}) or {}
    return (
        usage.get("input_tokens", 0) * p["in"]
        + usage.get("output_tokens", 0) * p["out"]
        + cc.get("ephemeral_5m_input_tokens", 0) * p["c5m"]
        + cc.get("ephemeral_1h_input_tokens", 0) * p["c1h"]
        + usage.get("cache_read_input_tokens", 0) * p["cr"]
    ) / 1_000_000


def band_of(ts):
    for name, lo, hi in MNEMO_BANDS:
        if lo <= ts < hi:
            return name
    return "?"


def is_real_user_prompt(message):
    """True iff this user message is a real prompt (not a tool_result roundtrip)."""
    c = message.get("content", "")
    if isinstance(c, str):
        return True
    if isinstance(c, list):
        types = [x.get("type") for x in c if isinstance(x, dict)]
        return "tool_result" not in types and "text" in types
    return False


def extract_user_text(message):
    c = message.get("content", "")
    if isinstance(c, str):
        return c
    text = ""
    if isinstance(c, list):
        for x in c:
            if isinstance(x, dict) and x.get("type") == "text":
                text += x.get("text", "")
    return text


def extract_asst_text(message):
    text = ""
    for blk in message.get("content", []):
        if blk.get("type") == "text":
            text += blk.get("text", "")
    return text


def iter_jsonl(folder):
    for fn in sorted(os.listdir(folder)):
        if not fn.endswith(".jsonl"):
            continue
        path = os.path.join(folder, fn)
        with open(path) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                yield fn, obj


def analyze_mnemo(folder):
    """Per-version mnemo analysis. Reproduces sidecar §3, §5."""
    B_turns = defaultdict(set)        # set of (file, turn_id) per band
    B_user_req = defaultdict(int)     # <user_request> count per band
    B_obs = defaultdict(int)
    B_prompts = defaultdict(int)
    B_calls = defaultdict(int)
    B_in = defaultdict(int); B_out = defaultdict(int)
    B_cr = defaultdict(int); B_5m = defaultdict(int); B_1h = defaultdict(int)
    B_cost = defaultdict(float)
    B_mem = defaultdict(int)
    B_thinking_chars = defaultdict(int)

    for fn, obj in iter_jsonl(folder):
        t = obj.get("type"); ts = obj.get("timestamp", "")
        if not ts:
            continue
        b = band_of(ts)
        if t == "user":
            m = obj.get("message", {})
            if not is_real_user_prompt(m):
                continue
            text = extract_user_text(m)
            B_prompts[b] += 1
            for tid in re.findall(r'<turn id="(T\d+)"', text):
                B_turns[b].add((fn, tid))
            B_user_req[b] += len(re.findall(r"<user_request>", text))
            B_obs[b] += len(re.findall(r"<obs\b", text))
        elif t == "assistant":
            m = obj.get("message", {})
            if m.get("model", "?") == "<synthetic>":
                continue
            u = m.get("usage", {}) or {}
            cc = u.get("cache_creation", {}) or {}
            B_calls[b] += 1
            B_in[b] += u.get("input_tokens", 0)
            B_out[b] += u.get("output_tokens", 0)
            B_cr[b] += u.get("cache_read_input_tokens", 0)
            B_5m[b] += cc.get("ephemeral_5m_input_tokens", 0)
            B_1h[b] += cc.get("ephemeral_1h_input_tokens", 0)
            B_cost[b] += cost_of(m.get("model"), u)
            for blk in m.get("content", []):
                if blk.get("type") == "thinking":
                    B_thinking_chars[b] += len(blk.get("thinking", ""))
                elif blk.get("type") == "tool_use" and "remember" in blk.get("name", ""):
                    B_mem[b] += 1

    print(f"# mnemo per-version analysis (pricing snapshot {PRICING_SNAPSHOT_DATE})")
    print(f"# folder: {folder}\n")
    print("## per-band per main-agent turn")
    print(f"{'band':24} {'turns':>6} {'obs/t':>6} {'calls/t':>7} "
          f"{'in_load/t':>10} {'out/t':>6} {'mem/t':>6} {'$/turn':>8}")
    total_cost = 0.0
    for n, _, _ in MNEMO_BANDS:
        if n in ("V0_pre-batch", "V1_batch_no_trunc"):
            turns = B_user_req[n] or len(B_turns[n])
        else:
            turns = len(B_turns[n]) or B_user_req[n]
        total_cost += B_cost[n]
        if not turns:
            continue
        in_load = (B_in[n] + B_cr[n] + B_5m[n] + B_1h[n]) / turns
        print(f"{n:24} {turns:6} {B_obs[n]/turns:6.2f} {B_calls[n]/turns:7.2f} "
              f"{in_load:10,.0f} {B_out[n]/turns:6.0f} {B_mem[n]/turns:6.2f} "
              f"{B_cost[n]/turns:8.4f}")
    print(f"\n## totals")
    print(f"sessions:     {sum(1 for fn in os.listdir(folder) if fn.endswith('.jsonl'))}")
    print(f"prompts:      {sum(B_prompts.values())}")
    print(f"LLM calls:    {sum(B_calls.values())}")
    print(f"memories:     {sum(B_mem.values())}")
    print(f"cost:         ${total_cost:.2f}")


def analyze_mem(folder):
    """claude-mem aggregate analysis. Reproduces sidecar §4, §7."""
    sessions = 0; user_msgs = 0; asst_msgs = 0
    real_calls = 0; synth = 0
    in_t = 0; out_t = 0; cr = 0; c5m = 0; c1h = 0
    total_cost = 0.0
    user_req = 0; tool_exec = 0
    obs_outputs = 0; sum_outputs = 0
    queue_enq = 0; queue_deq = 0
    too_long = 0; not_logged = 0
    sessions_with_too_long = set()
    queue_pendings = []

    for fn in sorted(os.listdir(folder)):
        if not fn.endswith(".jsonl"):
            continue
        sessions += 1
        pending = 0; mp = 0
        # per-file iteration (queue depth is per-session)
        with open(os.path.join(folder, fn)) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                t = obj.get("type")
                if t == "queue-operation":
                    op = obj.get("operation")
                    if op == "enqueue":
                        queue_enq += 1; pending += 1
                        if pending > mp: mp = pending
                    elif op == "dequeue":
                        queue_deq += 1; pending = max(0, pending - 1)
                elif t == "user":
                    user_msgs += 1
                    text = extract_user_text(obj.get("message", {}))
                    user_req += len(re.findall(r"<user_request>", text))
                    tool_exec += len(re.findall(r"<tool_execution>|<what_happened>", text))
                elif t == "assistant":
                    asst_msgs += 1
                    m = obj.get("message", {})
                    model = m.get("model", "?")
                    if model == "<synthetic>":
                        synth += 1
                        text = extract_asst_text(m)
                        if "Prompt is too long" in text:
                            too_long += 1
                            sessions_with_too_long.add(fn)
                        if "Not logged in" in text:
                            not_logged += 1
                    else:
                        real_calls += 1
                        u = m.get("usage", {}) or {}
                        cc = u.get("cache_creation", {}) or {}
                        in_t += u.get("input_tokens", 0)
                        out_t += u.get("output_tokens", 0)
                        cr += u.get("cache_read_input_tokens", 0)
                        c5m += cc.get("ephemeral_5m_input_tokens", 0)
                        c1h += cc.get("ephemeral_1h_input_tokens", 0)
                        total_cost += cost_of(model, u)
                        text = extract_asst_text(m)
                        if "<observation>" in text:
                            obs_outputs += 1
                        elif "<summary>" in text:
                            sum_outputs += 1
        queue_pendings.append(mp)

    print(f"# claude-mem aggregate analysis (pricing snapshot {PRICING_SNAPSHOT_DATE})")
    print(f"# folder: {folder}\n")
    print("## totals")
    print(f"sessions:           {sessions}")
    print(f"queue enq/deq:      {queue_enq:,} / {queue_deq:,}")
    print(f"user msgs:          {user_msgs:,}  (real prompts ≈ user msgs)")
    print(f"asst msgs:          {asst_msgs:,}  (real {real_calls:,}, synthetic {synth:,})")
    print(f"<user_request>:     {user_req:,}  ← main-agent turn count")
    print(f"<tool_execution>:   {tool_exec:,}  ← obs count")
    print(f"<observation> out:  {obs_outputs:,}")
    print(f"<summary> out:      {sum_outputs:,}")
    print(f"memories total:     {obs_outputs + sum_outputs:,}")
    print(f"cost:               ${total_cost:.2f}")
    print(f"\n## per main-agent turn")
    if user_req:
        print(f"obs/turn:        {tool_exec/user_req:.2f}")
        print(f"calls/turn:      {real_calls/user_req:.2f}")
        in_load = (in_t + cr + c5m + c1h) / user_req
        print(f"in_load/turn:    {in_load:,.0f}")
        print(f"out/turn:        {out_t/user_req:.0f}")
        print(f"mem/turn:        {(obs_outputs + sum_outputs)/user_req:.2f}")
        print(f"$/turn:          ${total_cost/user_req:.4f}")
    print(f"\n## failure modes")
    print(f"'Prompt is too long' events: {too_long:,}")
    print(f"sessions hit overflow:        {len(sessions_with_too_long)} / {sessions} "
          f"({len(sessions_with_too_long)/sessions*100:.1f}%)")
    print(f"'Not logged in' events:       {not_logged:,}")
    if queue_pendings:
        queue_pendings.sort()
        print(f"max queue depth p50/p99/max: "
              f"{queue_pendings[len(queue_pendings)//2]} / "
              f"{queue_pendings[int(len(queue_pendings)*0.99)]} / "
              f"{queue_pendings[-1]}")
    cache_total = cr + c5m + c1h + in_t
    if cache_total:
        print(f"\ncache hit ratio: {cr/cache_total*100:.1f}%")


def analyze_per_turn(folder):
    """Generic per-turn rollup (works on either mnemo or mem dir)."""
    is_mnemo = "mnemo" in folder
    turns = 0; obs = 0; calls = 0; cost = 0.0; mem = 0
    in_t = 0; out_t = 0; cr = 0; c5m = 0; c1h = 0
    for fn, obj in iter_jsonl(folder):
        t = obj.get("type")
        if t == "user":
            text = extract_user_text(obj.get("message", {}))
            if is_mnemo:
                turns += len(set(re.findall(r'<turn id="(T\d+)"', text)))
                if not re.findall(r'<turn id="', text):
                    turns += len(re.findall(r"<user_request>", text))
                obs += len(re.findall(r"<obs\b", text))
            else:
                turns += len(re.findall(r"<user_request>", text))
                obs += len(re.findall(r"<tool_execution>|<what_happened>", text))
        elif t == "assistant":
            m = obj.get("message", {})
            if m.get("model", "?") == "<synthetic>":
                continue
            calls += 1
            u = m.get("usage", {}) or {}
            cc = u.get("cache_creation", {}) or {}
            in_t += u.get("input_tokens", 0)
            out_t += u.get("output_tokens", 0)
            cr += u.get("cache_read_input_tokens", 0)
            c5m += cc.get("ephemeral_5m_input_tokens", 0)
            c1h += cc.get("ephemeral_1h_input_tokens", 0)
            cost += cost_of(m.get("model"), u)
            text = extract_asst_text(m)
            if is_mnemo:
                for blk in m.get("content", []):
                    if blk.get("type") == "tool_use" and "remember" in blk.get("name", ""):
                        mem += 1
            else:
                if "<observation>" in text or "<summary>" in text:
                    mem += 1

    print(f"# per-turn analysis (mode={'mnemo' if is_mnemo else 'mem'})")
    print(f"# folder: {folder}\n")
    print(f"turns:           {turns:,}")
    print(f"obs:             {obs:,}")
    print(f"LLM calls:       {calls:,}")
    print(f"memories:        {mem:,}")
    print(f"cost:            ${cost:.2f}")
    if turns:
        print(f"\nper-turn:")
        print(f"  obs/turn:        {obs/turns:.2f}")
        print(f"  calls/turn:      {calls/turns:.2f}")
        print(f"  in_load/turn:    {(in_t+cr+c5m+c1h)/turns:,.0f}")
        print(f"  out/turn:        {out_t/turns:.0f}")
        print(f"  mem/turn:        {mem/turns:.2f}")
        print(f"  $/turn:          ${cost/turns:.4f}")


USAGE = """Usage:
  analyze-memory-logs.py mnemo <dir>
  analyze-memory-logs.py mem <dir>
  analyze-memory-logs.py per-turn <dir>
"""

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(USAGE, file=sys.stderr)
        sys.exit(2)
    mode, folder = sys.argv[1], sys.argv[2]
    if mode == "mnemo":
        analyze_mnemo(folder)
    elif mode == "mem":
        analyze_mem(folder)
    elif mode == "per-turn":
        analyze_per_turn(folder)
    else:
        print(USAGE, file=sys.stderr)
        sys.exit(2)
