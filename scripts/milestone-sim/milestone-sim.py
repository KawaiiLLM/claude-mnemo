#!/usr/bin/env python3
"""Milestone selection simulation on S1730 real data.

Baseline mirrors src/mcp/timeline.ts selectMilestoneTurns exactly.
Variants:
  A: outcome coalescing — same-day outcome turns grouped by version string in
     title (fallback: prompt-gap<=5 chaining); only the LAST of each group keeps
     the always-keep guarantee, earlier ones compete at base score.
  B: discovery scoring — insight-bearing discovery base=2, readmitted floor=1,
     discovery joins fold-run types (last of run enters pool, +first if run>=4).
  D: superseded victims (demoted by a corrector) drop from first-class entirely
     unless structural (endpoint/compact) — they live on as the corrector's ↳.
  C (render-only): suppress ↳ whose target is itself a kept milestone in the
     same day group; counted, not part of selection.
"""
import json, re, statistics
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
OUTCOME_TAGS = {"merged","shipped","released","release","ready-to-merge","approved","finalized"}
MANIFEST_SUFFIXES = ("marketplace.json","plugin/.claude-plugin/plugin.json",".claude-plugin/plugin.json")
BASE = {"decision":4,"feature":3,"refactor":3,"bugfix":2,"change":1}
FOLD_RUN = {"decision","feature","change","refactor","bugfix"}
FOLD_FIRST = {"decision","feature","change","refactor"}
FOLD_FIRST_MIN = 4
DAY_BASE, DAY_MAX, DAY_DIV = 4, 7, 8
REF_RE = re.compile(r"\[T(\d+)\]")
VER_RE = re.compile(r"\b0\.\d+\.\d+\b")

turns = json.load(open("/tmp/s1730_turns.json"))
for t in turns:
    t["tags_list"] = json.loads(t["tags"]) if t["tags"] else []
    t["files_mod"] = json.loads(t["files_modified"]) if t["files_modified"] else []
    ins = t["insight"]
    t["has_insight"] = bool(ins) and ins not in ("[]","")
    t["day"] = datetime.fromtimestamp(t["created_at_epoch"], TZ).strftime("%Y-%m-%d")

by_dbid = {t["id"]: t for t in turns}
seq = [t for t in turns if t["status"] != "skipped"]
live = [t for t in turns if t["status"] not in ("undone","skipped")]

def is_version_bump(t):
    fm = t["files_mod"]
    return any(p.endswith("package.json") for p in fm) and \
           any(p.endswith(s) for p in fm for s in MANIFEST_SUFFIXES)

def marker(t):
    if t["status"] == "undone" or t["was_interrupted"]: return "invalidated"
    if t["was_rolled_back"] or "rolled-back" in t["tags_list"]: return "reversed"
    if OUTCOME_TAGS & set(t["tags_list"]) or is_version_bump(t): return "outcome"
    return None

def base_score(t, variant_b=False):
    ty = t["type"] or ""
    if variant_b and ty == "discovery":
        return 2 if t["has_insight"] else 0
    s = BASE.get(ty, 0)
    if ty in ("feature","refactor","change") and not t["files_mod"]:
        return 0
    return s

# burst threshold: median(tool counts over live) * 2, median rounded like the TS impl
counts = sorted((t["tool_call_count"] or 0) for t in live)
mid = len(counts)//2
median = counts[mid] if len(counts)%2==1 else round((counts[mid-1]+counts[mid])/2)
THRESHOLD = median*2

def readmitted(t):
    return t["type"]=="discovery" and (t["tool_call_count"] or 0) > THRESHOLD

def select(variant_a=False, variant_b=False, variant_d=False):
    endpoints = {seq[0]["prompt_number"]}
    last_titled = next((t for t in reversed(seq) if t["title"]), seq[-1])
    endpoints.add(last_titled["prompt_number"])

    # correction graph
    correctors, victims = set(), set()
    for c in seq:
        for m in REF_RE.finditer(c["content"] or ""):
            v = by_dbid.get(int(m.group(1)))
            if not v or v["prompt_number"] >= c["prompt_number"]: continue
            if marker(v) != "reversed": continue
            correctors.add(c["prompt_number"])
            victims.add(v["prompt_number"])

    # variant A (refined): same-day adjacent outcome turns chain (gap<=5);
    # chain breaks when the version string (LAST match in title = bump target)
    # changes between neighbors. Only the chain's last turn keeps always-keep.
    demoted_outcome = set()
    if variant_a:
        from collections import defaultdict
        by_day_outcome = defaultdict(list)
        for t in seq:
            if marker(t) == "outcome": by_day_outcome[t["day"]].append(t)
        def ver_of(t):
            ms = VER_RE.findall(t["title"] or "")
            return ms[-1] if ms else None
        for day, members in by_day_outcome.items():
            members.sort(key=lambda t: t["prompt_number"])
            chain = [members[0]]
            def close(chain):
                for t in chain[:-1]: demoted_outcome.add(t["prompt_number"])
            for t in members[1:]:
                prev = chain[-1]
                gap_ok = t["prompt_number"] - prev["prompt_number"] <= 5
                v1, v2 = ver_of(prev), ver_of(t)
                if gap_ok and not (v1 and v2 and v1 != v2):
                    chain.append(t)
                else:
                    close(chain); chain=[t]
            close(chain)

    def always_keep(t):
        pn = t["prompt_number"]
        if pn in correctors: return True
        structural = t["type"]=="compact" or pn in endpoints
        if pn in victims: return structural
        mk = marker(t)
        if mk == "outcome" and pn in demoted_outcome:
            return structural
        return mk is not None or structural

    def significance(t):
        if always_keep(t): return float("inf")
        b = base_score(t, variant_b)
        if readmitted(t): return max(b, 1 if variant_b else 0.5)
        return b

    fold_run = FOLD_RUN | ({"discovery"} if variant_b else set())
    fold_first = FOLD_FIRST | ({"discovery"} if variant_b else set())

    kept_prompts = set()
    run_type, members = "___", []
    def flush():
        if run_type in fold_run:
            foldable = [t for t in members if base_score(t, variant_b) > 0 and not always_keep(t)]
            if foldable:
                kept_prompts.add(foldable[-1]["prompt_number"])
                if run_type in fold_first and len(foldable) >= FOLD_FIRST_MIN:
                    kept_prompts.add(foldable[0]["prompt_number"])
    for t in seq:
        if t["type"] != run_type:
            flush(); run_type = t["type"]; members = []
        members.append(t)
    flush()

    for t in seq:
        if always_keep(t) or readmitted(t):
            kept_prompts.add(t["prompt_number"])

    if variant_d:
        kept_prompts -= {pn for pn in victims
                         if not (by_dbid_pn(pn)["type"]=="compact" or pn in endpoints)}

    survivors = [t for t in seq if t["prompt_number"] in kept_prompts]

    from collections import defaultdict
    by_day = defaultdict(list)
    for t in survivors: by_day[t["day"]].append(t)

    final, overflow = set(), {}
    for day, day_turns in by_day.items():
        cap = min(DAY_BASE + len(day_turns)//DAY_DIV, DAY_MAX)
        ranked = sorted(day_turns, key=lambda t: (-significance(t), -(t["tool_call_count"] or 0), t["prompt_number"]))
        for t in ranked[:cap]: final.add(t["prompt_number"])
        for t in ranked[cap:]:
            if always_keep(t): final.add(t["prompt_number"])
        dropped = [t for t in ranked if t["prompt_number"] not in final]
        if dropped: overflow[day] = len(dropped)

    kept = [t for t in seq if t["prompt_number"] in final]
    return {"kept": kept, "overflow": overflow, "correctors": correctors,
            "victims": victims, "demoted_outcome": demoted_outcome,
            "always_keep": always_keep, "significance": significance}

_pn_index = {t["prompt_number"]: t for t in seq}
def by_dbid_pn(pn): return _pn_index[pn]

def refs_of(t):
    out, seen = [], set()
    for m in REF_RE.finditer(t["content"] or ""):
        i = int(m.group(1))
        if i in seen: continue
        seen.add(i)
        v = by_dbid.get(i)
        if v and v["prompt_number"] < t["prompt_number"]:
            out.append(v)
        if len(out) >= 2: break
    return out

def render_stats(kept):
    kept_set = {t["prompt_number"] for t in kept}
    total_rows = len(kept); sub_rows = 0; dup_sub_rows = 0
    day_of = {t["prompt_number"]: t["day"] for t in kept}
    for t in kept:
        for v in refs_of(t):
            sub_rows += 1
            if v["prompt_number"] in kept_set and day_of.get(v["prompt_number"]) == t["day"]:
                dup_sub_rows += 1
    return total_rows, sub_rows, dup_sub_rows

def outcome_share(sel, days):
    rows = {}
    for d in days:
        k = [t for t in sel["kept"] if t["day"]==d]
        o = [t for t in k if marker(t)=="outcome" and t["prompt_number"] not in sel["demoted_outcome"]]
        o_all = [t for t in k if marker(t)=="outcome"]
        rows[d] = (len(k), len(o_all))
    return rows

baseline = select()
va  = select(variant_a=True)
vab = select(variant_a=True, variant_b=True)
vabd= select(variant_a=True, variant_b=True, variant_d=True)

def summary(name, sel):
    kept = sel["kept"]
    n = len(kept)
    disc = sum(1 for t in kept if t["type"]=="discovery")
    outc = sum(1 for t in kept if marker(t)=="outcome")
    rows, subs, dups = render_stats(kept)
    print(f"{name:10s} kept={n:3d} ({n/len(seq)*100:.1f}%)  discovery={disc:2d}  outcome-marked={outc:2d}  lines={rows+subs}  dup-subrows={dups}")

print(f"seq={len(seq)} live={len(live)} threshold>{THRESHOLD}")
print()
summary("baseline", baseline)
summary("A", va)
summary("A+B", vab)
summary("A+B+D", vabd)

bl_set = {t["prompt_number"] for t in baseline["kept"]}
fin_set = {t["prompt_number"] for t in vabd["kept"]}
print("\n=== newly KEPT in A+B+D (vs baseline) ===")
for t in vabd["kept"]:
    if t["prompt_number"] not in bl_set:
        print(f"  +T{t['prompt_number']:<4d} {t['type'] or '?':9s} 🔧{t['tool_call_count'] or 0:<3d} {'💡' if t['has_insight'] else '  '} {(t['title'] or '(untitled)')[:78]}")
print("\n=== DROPPED in A+B+D (vs baseline) ===")
for t in baseline["kept"]:
    if t["prompt_number"] not in fin_set:
        mk = marker(t)
        print(f"  -T{t['prompt_number']:<4d} {t['type'] or '?':9s} {mk or '':11s} {(t['title'] or '(untitled)')[:72]}")

print("\n=== per-day kept (baseline -> A+B+D), release-heavy + dense days ===")
from collections import Counter
bl_days = Counter(t["day"] for t in baseline["kept"])
fin_days = Counter(t["day"] for t in vabd["kept"])
for d in sorted(set(bl_days) | set(fin_days)):
    print(f"  {d}: {bl_days.get(d,0):2d} -> {fin_days.get(d,0):2d}")
