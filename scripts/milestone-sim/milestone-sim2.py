#!/usr/bin/env python3
"""Tag-keyword bonus experiment on top of the A(+B)(+D) milestone simulation.

Decomposition:
  A   : outcome coalescing (refined: gap<=5 chain, version-change break)
  B1  : discovery structural entry — discovery joins fold-run types; readmit floor 1
  B2  : insight signal — insight-bearing discovery base=2
  T   : tag-keyword signal — +2 when any bare tag matches the importance families
        (design|architecture|spec|simulat|review|audit|verif|bug|root|regress|
         correction|pivot|hotfix|misfire|decision); applied AFTER the 0-file gate
        so tag-hit zero-file turns can re-enter.
  D   : superseded-victim hard demote

Arms:
  REF  = A+B1+B2+D      (the previously reported A+B+D)
  TAGS = A+B1+T+D       (tags REPLACE insight)
  BOTH = A+B1+B2+T+D    (tags ADD to insight)
"""
import json, re
from datetime import datetime, timezone, timedelta
from collections import defaultdict

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
FAM_RE = re.compile(r"design|architecture|spec|simulat|review|audit|verif|bug|root|regress|correction|pivot|hotfix|misfire|decision")

turns = json.load(open("/tmp/s1730_turns.json"))
for t in turns:
    t["tags_list"] = json.loads(t["tags"]) if t["tags"] else []
    t["bare_tags"] = [x for x in t["tags_list"] if ":" not in x]
    t["files_mod"] = json.loads(t["files_modified"]) if t["files_modified"] else []
    t["has_insight"] = bool(t["insight"]) and t["insight"] not in ("[]","")
    t["tag_hit"] = any(FAM_RE.search(x) for x in t["bare_tags"])
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

def readmitted(t):
    return t["type"]=="discovery" and (t["tool_call_count"] or 0) > THRESHOLD

def select(a=False, b1=False, b2=False, tg=False, d=False):
    def base_score(t):
        ty = t["type"] or ""
        if ty == "discovery":
            s = 2 if (b2 and t["has_insight"]) else 0
        else:
            s = BASE.get(ty, 0)
            if ty in ("feature","refactor","change") and not t["files_mod"]:
                s = 0
        if tg and t["tag_hit"]:
            s += 2
        return s

    endpoints = {seq[0]["prompt_number"]}
    last_titled = next((t for t in reversed(seq) if t["title"]), seq[-1])
    endpoints.add(last_titled["prompt_number"])

    correctors, victims = set(), set()
    for c in seq:
        for m in REF_RE.finditer(c["content"] or ""):
            v = by_dbid.get(int(m.group(1)))
            if not v or v["prompt_number"] >= c["prompt_number"]: continue
            if marker(v) != "reversed": continue
            correctors.add(c["prompt_number"]); victims.add(v["prompt_number"])

    demoted_outcome = set()
    if a:
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

    def always_keep(t):
        pn = t["prompt_number"]
        if pn in correctors: return True
        structural = t["type"]=="compact" or pn in endpoints
        if pn in victims: return structural
        mk = marker(t)
        if mk == "outcome" and pn in demoted_outcome: return structural
        return mk is not None or structural

    def significance(t):
        if always_keep(t): return float("inf")
        s = base_score(t)
        if readmitted(t): return max(s, 1 if b1 else 0.5)
        return s

    fold_run = FOLD_RUN | ({"discovery"} if b1 else set())
    fold_first = FOLD_FIRST | ({"discovery"} if b1 else set())

    kept_prompts = set()
    run_type, members = "___", []
    def flush():
        if run_type in fold_run:
            foldable = [t for t in members if base_score(t) > 0 and not always_keep(t)]
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
        if always_keep(t) or readmitted(t): kept_prompts.add(t["prompt_number"])

    if d:
        pn_index = {t["prompt_number"]: t for t in seq}
        kept_prompts -= {pn for pn in victims
                         if not (pn_index[pn]["type"]=="compact" or pn in endpoints)}

    survivors = [t for t in seq if t["prompt_number"] in kept_prompts]
    by_day = defaultdict(list)
    for t in survivors: by_day[t["day"]].append(t)

    final = set()
    for day, day_turns in by_day.items():
        cap = min(DAY_BASE + len(day_turns)//DAY_DIV, DAY_MAX)
        ranked = sorted(day_turns, key=lambda t: (-significance(t), -(t["tool_call_count"] or 0), t["prompt_number"]))
        for t in ranked[:cap]: final.add(t["prompt_number"])
        for t in ranked[cap:]:
            if always_keep(t): final.add(t["prompt_number"])
    return [t for t in seq if t["prompt_number"] in final]

baseline = select()
ref  = select(a=1, b1=1, b2=1, d=1)
tags = select(a=1, b1=1, tg=1, d=1)
both = select(a=1, b1=1, b2=1, tg=1, d=1)

def pset(kept): return {t["prompt_number"] for t in kept}
bl_s, ref_s, tags_s, both_s = pset(baseline), pset(ref), pset(tags), pset(both)

print(f"tag_hit turns in seq: {sum(1 for t in seq if t['tag_hit'])}/{len(seq)}")
for name, k in [("baseline",bl_s),("REF A+B+D",ref_s),("TAGS(替代)",tags_s),("BOTH(叠加)",both_s)]:
    print(f"{name:12s} kept={len(k)} ({len(k)/len(seq)*100:.1f}%)")

def show(title, pns):
    print(f"\n=== {title} ({len(pns)}) ===")
    idx = {t["prompt_number"]: t for t in seq}
    for pn in sorted(pns):
        t = idx[pn]
        ftags = [x for x in t["bare_tags"] if FAM_RE.search(x)][:3]
        print(f"  T{pn:<4d} {t['type'] or '?':9s} 🔧{t['tool_call_count'] or 0:<3d} "
              f"{'💡' if t['has_insight'] else '  '} tags={','.join(ftags):40s} {(t['title'] or '')[:64]}")

show("TAGS 挖出而 REF 没有的（tag 独有贡献,替代臂）", tags_s - ref_s)
show("BOTH 比 REF 多挖出的（tag 叠加后的净增）", both_s - ref_s)
show("REF 有而 TAGS 丢的（insight 独有、tag 抓不到）", ref_s - tags_s)
