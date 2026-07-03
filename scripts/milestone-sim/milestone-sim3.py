#!/usr/bin/env python3
"""Weighted multi-signal milestone scoring (user-proposed architecture).

Score = type base + weighted signals; always-keep(∞) shrinks to a structural
core (endpoints, compact). Fold becomes a diversity constraint (max 2 picks per
same-type consecutive run per day). Per-day adaptive budget kept.

Weights:
  type base        decision 4 / feature 3 / refactor 3 / bugfix 2 / change 1 / discovery 1
                   (feature/refactor/change with 0 files -> 0, gate kept)
  insight          +2
  pure-spec files  +2   (all files_modified match docs/(plans|specs|superpowers)/*.md)
  tag family       +1   (bare OR topic:-stripped tags matching importance families)
  role tag         +1   (correction / final-decision)
  tool burst       +1   (toolCount > window threshold)
  cited-by         +1 per later in-session citation, cap +3
  marker: outcome anchor (post-coalesce) +6 · corrector +5 ·
          reversed-without-corrector +4 · invalidated +3 ·
          demoted ritual outcome +0 · superseded victim: hard-excluded (D)
"""
import json, re
from datetime import datetime, timezone, timedelta
from collections import defaultdict

TZ = timezone(timedelta(hours=8))
OUTCOME_TAGS = {"merged","shipped","released","release","ready-to-merge","approved","finalized"}
MANIFEST_SUFFIXES = ("marketplace.json","plugin/.claude-plugin/plugin.json",".claude-plugin/plugin.json")
TYPE_BASE = {"decision":4,"feature":3,"refactor":3,"bugfix":2,"change":1,"discovery":1}
REF_RE = re.compile(r"\[T(\d+)\]")
VER_RE = re.compile(r"\b0\.\d+\.\d+\b")
FAM_RE = re.compile(r"design|architecture|spec|simulat|review|audit|verif|bug|root|regress|correction|pivot|hotfix|misfire|decision")
SPEC_RE = re.compile(r"docs/(plans|specs|superpowers)/.*\.md$")
ROLE_BONUS = {"correction","final-decision"}
DAY_BASE, DAY_MAX, DAY_DIV = 4, 7, 8
RUN_CAP = 2

turns = json.load(open("/tmp/s1730_turns.json"))
for t in turns:
    t["tags_list"] = json.loads(t["tags"]) if t["tags"] else []
    # tagFam reads BARE tags only. topic: tags are DB-only and NEVER affect
    # milestones (0.2.37 two-class contract); bare tags are the role/session-arc class.
    bare = [x for x in t["tags_list"] if ":" not in x]
    t["files_mod"] = json.loads(t["files_modified"]) if t["files_modified"] else []
    t["has_insight"] = bool(t["insight"]) and t["insight"] not in ("[]","")
    t["tag_fam"] = any(FAM_RE.search(x) for x in bare)
    t["role_hit"] = any(x in ROLE_BONUS for x in bare)   # ⊆ tag_fam (correction/decision ∈ FAM_RE)
    t["pure_spec"] = bool(t["files_mod"]) and all(SPEC_RE.search(p) for p in t["files_mod"])
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

counts = sorted((t["tool_call_count"] or 0) for t in live)
mid = len(counts)//2
median = counts[mid] if len(counts)%2==1 else round((counts[mid-1]+counts[mid])/2)
THRESHOLD = median*2

# --- graph signals ---
indeg = defaultdict(int)          # cited-by count (later in-session turns)
correctors, victims = set(), set()
for c in seq:
    for m in REF_RE.finditer(c["content"] or ""):
        v = by_dbid.get(int(m.group(1)))
        if not v or v["prompt_number"] >= c["prompt_number"]: continue
        indeg[v["prompt_number"]] += 1
        if marker(v) == "reversed":
            correctors.add(c["prompt_number"]); victims.add(v["prompt_number"])

# --- outcome coalescing (A refined) ---
demoted_outcome = set()
by_day_outcome = defaultdict(list)
for t in seq:
    if marker(t) == "outcome": by_day_outcome[t["day"]].append(t)
def ver_of(t):
    ms = VER_RE.findall(t["title"] or "")
    return ms[-1] if ms else None
for day, members in by_day_outcome.items():
    members.sort(key=lambda t: t["prompt_number"])
    chain = [members[0]]
    def close(ch):
        for t in ch[:-1]: demoted_outcome.add(t["prompt_number"])
    for t in members[1:]:
        prev = chain[-1]
        gap_ok = t["prompt_number"] - prev["prompt_number"] <= 5
        v1, v2 = ver_of(prev), ver_of(t)
        if gap_ok and not (v1 and v2 and v1 != v2): chain.append(t)
        else: close(chain); chain=[t]
    close(chain)

endpoints = {seq[0]["prompt_number"]}
last_titled = next((t for t in reversed(seq) if t["title"]), seq[-1])
endpoints.add(last_titled["prompt_number"])

def score(t):
    pn = t["prompt_number"]
    if t["type"] == "compact" or pn in endpoints:
        return float("inf")
    ty = t["type"] or ""
    s = TYPE_BASE.get(ty, 0)
    if ty in ("feature","refactor","change") and not t["files_mod"]: s = 0
    if t["has_insight"]: s += 2
    if t["pure_spec"]: s += 2
    if t["tag_fam"]: s += 1
    if t["role_hit"]: s += 1
    if (t["tool_call_count"] or 0) > THRESHOLD: s += 1
    s += min(indeg.get(pn, 0), 3)
    mk = marker(t)
    if mk == "outcome" and pn not in demoted_outcome: s += 6
    if pn in correctors: s += 5
    if mk == "reversed" and pn not in victims: s += 4
    if mk == "invalidated": s += 3
    return s

# same-type consecutive run ids (for the diversity cap)
run_id = {}
rid, prev_type = 0, "___"
for t in seq:
    if t["type"] != prev_type:
        rid += 1; prev_type = t["type"]
    run_id[t["prompt_number"]] = rid

def select_weighted():
    pool = [t for t in seq
            if t["prompt_number"] not in victims
            or t["type"]=="compact" or t["prompt_number"] in endpoints]
    by_day = defaultdict(list)
    for t in pool: by_day[t["day"]].append(t)
    final = set()
    for day, day_turns in by_day.items():
        scored = [t for t in day_turns if score(t) > 0]
        cap = min(DAY_BASE + len(scored)//DAY_DIV, DAY_MAX)
        ranked = sorted(scored, key=lambda t: (-score(t), -(t["tool_call_count"] or 0), t["prompt_number"]))
        picks, per_run = [], defaultdict(int)
        for t in ranked:
            if score(t) == float("inf"):
                picks.append(t); continue
            if len([p for p in picks if score(p) != float("inf")]) >= cap: continue
            r = run_id[t["prompt_number"]]
            if per_run[r] >= RUN_CAP: continue
            per_run[r] += 1; picks.append(t)
        final |= {t["prompt_number"] for t in picks}
    return [t for t in seq if t["prompt_number"] in final]

weighted = select_weighted()
w_set = {t["prompt_number"] for t in weighted}

# reference sets: baseline + A+B+D from sim2
import importlib.util, io, contextlib
import os
spec2 = importlib.util.spec_from_file_location("s2", os.path.join(os.path.dirname(os.path.abspath(__file__)), "milestone-sim2.py"))
s2 = importlib.util.module_from_spec(spec2)
with contextlib.redirect_stdout(io.StringIO()):
    spec2.loader.exec_module(s2)
bl_set, ref_set = s2.pset(s2.baseline), s2.pset(s2.ref)

idx = {t["prompt_number"]: t for t in seq}
print(f"in-degree>0 turns: {sum(1 for v in indeg.values() if v>0)}; topic: tags present in S1730: "
      f"{sum(1 for t in seq if any(x.startswith('topic:') for x in t['tags_list']))}")
print(f"WEIGHTED kept={len(w_set)} ({len(w_set)/len(seq)*100:.1f}%) | baseline={len(bl_set)} | REF A+B+D={len(ref_set)}")

# spine integrity
anchors = {t["prompt_number"] for t in seq if marker(t)=="outcome" and t["prompt_number"] not in demoted_outcome}
print(f"spine: outcome anchors kept {len(anchors & w_set)}/{len(anchors)}, correctors kept {len(correctors & w_set)}/{len(correctors)}")
days_ref = {idx[pn]['day'] for pn in ref_set}
days_w = {idx[pn]['day'] for pn in w_set}
print(f"day coverage: REF {len(days_ref)} days, WEIGHTED {len(days_w)} days")

def show(title, pns, cap=30):
    print(f"\n=== {title} ({len(pns)}) ===")
    for pn in sorted(pns)[:cap]:
        t = idx[pn]
        sig = []
        if t["has_insight"]: sig.append("💡")
        if t["pure_spec"]: sig.append("📄")
        if t["tag_fam"]: sig.append("🏷")
        if indeg.get(pn,0): sig.append(f"←{indeg[pn]}")
        print(f"  T{pn:<4d} {t['type'] or '?':9s} s={score(t) if score(t)!=float('inf') else '∞':<4} "
              f"{''.join(sig):12s} {(t['title'] or '')[:60]}")
show("WEIGHTED 比 REF 多保留", w_set - ref_set)
show("WEIGHTED 比 REF 丢弃", ref_set - w_set)
