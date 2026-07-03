#!/usr/bin/env python3
"""Cross-session validation of the calibrated milestone winner (post Part-1 fix).

Self-contained: build_session(path) replicates milestone-sim3.py's signal logic
verbatim (FAM_RE / SPEC_RE / ROLE_BONUS / marker / THRESHOLD / indeg-correctors-
victims / outcome coalescing / endpoints / run_id) so the identical selector can
run on ANY <session>_turns.json. always_keep() carries the Part-1 fix
(invalidated + pure-rewind reversed added to the inf core).

No GOLD/MUD objective for the new sessions — qualitative validation only.
"""
import json, re
from datetime import datetime, timezone, timedelta
from collections import defaultdict

TZ = timezone(timedelta(hours=8))
OUTCOME_TAGS = {"merged","shipped","released","release","ready-to-merge","approved","finalized"}
MANIFEST_SUFFIXES = ("marketplace.json","plugin/.claude-plugin/plugin.json",".claude-plugin/plugin.json")
FAM_RE  = re.compile(r"design|architecture|spec|simulat|review|audit|verif|bug|root|regress|correction|pivot|hotfix|misfire|decision")
SPEC_RE = re.compile(r"docs/(plans|specs|superpowers)/.*\.md$")
ROLE_BONUS = {"correction","final-decision"}
REF_RE = re.compile(r"\[T(\d+)\]")
VER_RE = re.compile(r"\b0\.\d+\.\d+\b")
INF = float("inf")
DAY_DIV = 8

WINNER = {"decision":4,"feature":2,"discovery":1,"W_insight":2,"W_spec":3,
          "W_cite":1,"CITE_CAP":2,"W_burst":0,"POOL_MIN":2,"DAY_BASE":4,"DAY_MAX":7}


def is_version_bump(t):
    fm = t["files_mod"]
    return any(p.endswith("package.json") for p in fm) and \
           any(p.endswith(s) for p in fm for s in MANIFEST_SUFFIXES)


def marker(t):
    if t["status"] == "undone" or t["was_interrupted"]: return "invalidated"
    if t["was_rolled_back"] or "rolled-back" in t["tags_list"]: return "reversed"
    if OUTCOME_TAGS & set(t["tags_list"]) or is_version_bump(t): return "outcome"
    return None


class Session:
    pass


def build_session(path):
    turns = json.load(open(path))
    for t in turns:
        t["tags_list"] = json.loads(t["tags"]) if t["tags"] else []
        bare = [x for x in t["tags_list"] if ":" not in x]   # role class; topic: never read
        t["files_mod"] = json.loads(t["files_modified"]) if t["files_modified"] else []
        t["has_insight"] = bool(t["insight"]) and t["insight"] not in ("[]","")
        t["tag_fam"] = any(FAM_RE.search(x) for x in bare)
        t["role_hit"] = any(x in ROLE_BONUS for x in bare)   # ⊆ tag_fam
        t["pure_spec"] = bool(t["files_mod"]) and all(SPEC_RE.search(p) for p in t["files_mod"])
        t["day"] = datetime.fromtimestamp(t["created_at_epoch"], TZ).strftime("%Y-%m-%d")

    S = Session()
    S.turns = turns
    S.by_dbid = {t["id"]: t for t in turns}
    S.seq = [t for t in turns if t["status"] != "skipped"]
    live = [t for t in turns if t["status"] not in ("undone","skipped")]

    counts = sorted((t["tool_call_count"] or 0) for t in live)
    mid = len(counts)//2
    median = counts[mid] if len(counts)%2==1 else round((counts[mid-1]+counts[mid])/2)
    S.THRESHOLD = median*2

    S.indeg = defaultdict(int)
    S.correctors, S.victims = set(), set()
    for c in S.seq:
        for m in REF_RE.finditer(c["content"] or ""):
            v = S.by_dbid.get(int(m.group(1)))
            if not v or v["prompt_number"] >= c["prompt_number"]: continue
            S.indeg[v["prompt_number"]] += 1
            if marker(v) == "reversed":
                S.correctors.add(c["prompt_number"]); S.victims.add(v["prompt_number"])

    S.demoted_out = set()
    by_day_outcome = defaultdict(list)
    for t in S.seq:
        if marker(t) == "outcome": by_day_outcome[t["day"]].append(t)
    def ver_of(t):
        ms = VER_RE.findall(t["title"] or "")
        return ms[-1] if ms else None
    for day, members in by_day_outcome.items():
        members.sort(key=lambda t: t["prompt_number"])
        chain = [members[0]]
        def close(ch):
            for t in ch[:-1]: S.demoted_out.add(t["prompt_number"])
        for t in members[1:]:
            prev = chain[-1]
            gap_ok = t["prompt_number"] - prev["prompt_number"] <= 5
            v1, v2 = ver_of(prev), ver_of(t)
            if gap_ok and not (v1 and v2 and v1 != v2): chain.append(t)
            else: close(chain); chain=[t]
        close(chain)

    S.endpoints = {S.seq[0]["prompt_number"]}
    last_titled = next((t for t in reversed(S.seq) if t["title"]), S.seq[-1])
    S.endpoints.add(last_titled["prompt_number"])

    S.run_id = {}
    rid, prev_type = 0, "___"
    for t in S.seq:
        if t["type"] != prev_type:
            rid += 1; prev_type = t["type"]
        S.run_id[t["prompt_number"]] = rid

    S.idx = {t["prompt_number"]: t for t in S.seq}
    dn = defaultdict(int)
    for t in S.seq: dn[t["day"]] += 1
    S.cover_days = {d for d, n in dn.items() if n >= 3}
    S.anchors = {t["prompt_number"] for t in S.seq
                 if marker(t)=="outcome" and t["prompt_number"] not in S.demoted_out}
    return S


def always_keep(S, t):
    pn = t["prompt_number"]
    if pn in S.correctors: return True
    if t["type"]=="compact" or pn in S.endpoints: return True
    mk = marker(t)
    if mk == "outcome" and pn not in S.demoted_out: return True
    if mk == "invalidated": return True
    if mk == "reversed" and pn not in S.victims: return True
    return False


def make_score(S, cfg):
    TB = {"decision":cfg["decision"],"feature":cfg["feature"],"refactor":cfg["feature"],
          "bugfix":2,"change":1,"discovery":cfg["discovery"]}
    Wi,Ws,Wf = cfg["W_insight"],cfg["W_spec"],1
    Wc,Ccap,Wb = cfg["W_cite"],cfg["CITE_CAP"],cfg["W_burst"]
    def sc(t):
        if always_keep(S, t): return INF
        ty = t["type"] or ""
        s = TB.get(ty, 0)
        if ty in ("feature","refactor","change") and not t["files_mod"]: s = 0
        s += max(Wi*t["has_insight"], Ws*t["pure_spec"], Wf*t["tag_fam"])   # role folds into tag_fam
        s += min(S.indeg.get(t["prompt_number"],0), Ccap)*Wc
        if (t["tool_call_count"] or 0) > S.THRESHOLD: s += Wb
        return s
    return sc


def select(S, cfg):
    sc = make_score(S, cfg)
    POOL_MIN, DAY_BASE, DAY_MAX = cfg["POOL_MIN"], cfg["DAY_BASE"], cfg["DAY_MAX"]
    def in_pool(t):
        if always_keep(S, t): return True
        if t["prompt_number"] in S.victims: return False
        return sc(t) >= POOL_MIN
    by_day = defaultdict(list)
    for t in S.seq:
        if in_pool(t): by_day[t["day"]].append(t)
    final = set()
    for day, members in by_day.items():
        cap = min(DAY_BASE + len(members)//DAY_DIV, DAY_MAX)
        weighted = [t for t in members if sc(t) != INF]
        runs = defaultdict(list)
        for t in weighted: runs[S.run_id[t["prompt_number"]]].append(t)
        reps = []
        for grp in runs.values():
            grp_by_prompt = sorted(grp, key=lambda t: t["prompt_number"])
            last = grp_by_prompt[-1]
            reps.append(last)
            others = [g for g in grp if g["prompt_number"] != last["prompt_number"]]
            if others:
                reps.append(max(others, key=lambda t: (sc(t), (t["tool_call_count"] or 0), -t["prompt_number"])))
        structural = [t for t in members if sc(t) == INF]
        cand = structural + reps
        cand.sort(key=lambda t: (-sc(t), -(t["tool_call_count"] or 0), t["prompt_number"]))
        for t in cand[:cap]: final.add(t["prompt_number"])
        for t in cand[cap:]:
            if sc(t) == INF: final.add(t["prompt_number"])
    return final, sc


def report(name, path, cfg=WINNER, dump_titles=True):
    S = build_session(path)
    final, sc = select(S, cfg)
    seqn = len(S.seq)
    print(f"\n########## {name}  ({path}) ##########")
    print(f"non-skipped={seqn}  kept={len(final)}  retention={len(final)/seqn*100:.1f}%"
          f"  {'[FLAG <15 or >25%]' if not (15<=len(final)/seqn*100<=25) else '[in 15-25%]'}")
    covered = {S.idx[pn]["day"] for pn in final}
    miss = sorted(S.cover_days - covered)
    print(f"cover-days(>=3 turns)={len(S.cover_days)}  covered={'ALL' if not miss else 'MISS '+str(miss)}")
    print(f"spine: outcome-anchors={len(S.anchors)} kept {len(S.anchors & final)}/{len(S.anchors)} | "
          f"correctors={len(S.correctors)} kept {len(S.correctors & final)}/{len(S.correctors)} | "
          f"victims(demoted)={len(S.victims)} | invalidated={sum(1 for t in S.seq if marker(t)=='invalidated')} "
          f"| pure-rewind={sum(1 for t in S.seq if marker(t)=='reversed' and t['prompt_number'] not in S.victims)}")
    # signal distribution
    def cnt(pred): return sum(1 for t in S.seq if pred(t))
    print(f"signals over seq: insight={cnt(lambda t:t['has_insight'])} "
          f"pure_spec={cnt(lambda t:t['pure_spec'])} tag_fam={cnt(lambda t:t['tag_fam'])} "
          f"role_hit={cnt(lambda t:t['role_hit'])} indeg>0={sum(1 for pn in S.indeg if S.indeg[pn]>0)} "
          f"outcome-mark={cnt(lambda t:marker(t)=='outcome')} THRESHOLD>{S.THRESHOLD}")
    if dump_titles:
        with open(f"/tmp/kept_{name}.txt","w") as f:
            for pn in sorted(final):
                t = S.idx[pn]; sg=[]
                if t["has_insight"]: sg.append("ins")
                if t["pure_spec"]: sg.append("spec")
                if t["tag_fam"]: sg.append("fam")
                if t["role_hit"]: sg.append("role")
                if S.indeg.get(pn,0): sg.append(f"c{S.indeg[pn]}")
                mk = marker(t) or ""
                svv = sc(t); ss = "inf" if svv==INF else str(svv)
                f.write(f"T{pn:<5d} {t['type'] or '?':9s} s={ss:<4} {mk:11s} [{','.join(sg):16s}] {(t['title'] or '')}\n")
        # dropped important candidates: decision/feature with insight, or reversed/outcome, or indeg>=2
        with open(f"/tmp/dropped_{name}.txt","w") as f:
            for t in S.seq:
                pn = t["prompt_number"]
                if pn in final: continue
                important = ((t["type"] in ("decision","feature") and t["has_insight"])
                             or marker(t) in ("outcome","reversed","invalidated")
                             or S.indeg.get(pn,0) >= 2)
                if important:
                    mk = marker(t) or ""
                    f.write(f"T{pn:<5d} {t['type'] or '?':9s} {mk:11s} ins={int(t['has_insight'])} c={S.indeg.get(pn,0)} {(t['title'] or '')}\n")
    return S, final, sc


def swap(name, path, key, val):
    S = build_session(path)
    base, _ = select(S, WINNER)
    cfg = dict(WINNER); cfg[key] = val
    alt, _ = select(S, cfg)
    added = sorted(alt - base); removed = sorted(base - alt)
    print(f"\n--- {name} sensitivity {key}={WINNER[key]}->{val}: kept {len(base)}->{len(alt)} "
          f"(+{len(added)}/-{len(removed)}) ---")
    for tag, lst in (("+added", added), ("-removed", removed)):
        for pn in lst:
            t = S.idx[pn]
            print(f"   {tag} T{pn:<5d} {t['type'] or '?':9s} ins={int(t['has_insight'])} {(t['title'] or '')[:58]}")
    return added, removed


SESSIONS = [("S1730","/tmp/s1730_turns.json"),
            ("S5233","/tmp/s5233_turns.json"),
            ("S9262","/tmp/s9262_turns.json")]

if __name__ == "__main__":
    print(f"WINNER cfg = {WINNER}")
    for name, path in SESSIONS:
        report(name, path)
    print("\n\n================ SENSITIVITY SPOT-CHECK (winner-relative) ================")
    for name, path in SESSIONS:
        swap(name, path, "W_burst", 1)
        swap(name, path, "feature", 3)
