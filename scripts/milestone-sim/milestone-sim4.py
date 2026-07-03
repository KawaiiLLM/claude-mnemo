#!/usr/bin/env python3
"""Milestone-selection weight-table calibration (S1730).

Fixed converged architecture (weights are the only free variables):
  1. Structural core = always-keep (inf): endpoints, compact, outcome ANCHORS
     (post-coalesce, i.e. not demoted), correctors. Superseded victims are
     hard-excluded from the pool unless they are themselves structural.
  2. Weighted score for everyone else:
       score = TYPE_BASE[type]
             + max(W_insight*has_insight, W_spec*pure_spec, W_fam*tag_fam)
             # role tags fold into tag_fam (bare-only; correction/decision ∈ FAM_RE);
             # topic: tags never read. A dedicated role channel is deferred (T546).
             + min(indeg, CITE_CAP)*W_cite
             + W_burst*(toolCount > THRESHOLD)
     0-file gate: feature/refactor/change with empty files_modified -> base 0
     (signals still add).
  3. Budget: per-day pool = {score >= POOL_MIN}; cap = min(DAY_BASE +
     pool_day//DAY_DIV, DAY_MAX); inf-score structural picks bypass the cap.
  4. Run constraint: within one same-type consecutive run (run_id), per day at
     most 2 weighted picks = the run's LAST-in-prompt-order member + the
     highest-scored OTHER member (finality-preserving hybrid, NOT top-2-by-score);
     those reps then compete for the day cap by score.

Signals / graph facts (indeg, correctors, victims, demoted_outcome, endpoints,
run_id, marker, THRESHOLD, per-turn has_insight/pure_spec/tag_fam/role_hit) are
reused verbatim from milestone-sim3.py so they stay in lock-step with the
converged design. sim2.ref is the 94-turn A+B+D reference for the diff.
"""
import importlib.util, io, contextlib
from collections import defaultdict

INF = float("inf")
DAY_DIV = 8


def _load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(m)
    return m


import os
_HERE = os.path.dirname(os.path.abspath(__file__))
s3 = _load(os.path.join(_HERE, "milestone-sim3.py"), "s3sim")
s2 = _load(os.path.join(_HERE, "milestone-sim2.py"), "s2sim")

seq          = s3.seq
by_dbid      = s3.by_dbid
indeg        = s3.indeg
correctors   = s3.correctors
victims      = s3.victims
demoted_out  = s3.demoted_outcome
endpoints    = s3.endpoints
run_id       = s3.run_id
marker       = s3.marker
THRESHOLD    = s3.THRESHOLD

idx = {t["prompt_number"]: t for t in seq}
NONSKIP = len(seq)                       # 458

GOLD = {16,142,153,174,224,240,260,268,269,288,322,327,374,439,442,456,
        475,504,518,519,527,543,546,554,564,573,582,585}
MUD  = {40,72,124,143,165,179,180,293,294,303,483,521}

ANCHORS = {t["prompt_number"] for t in seq
           if marker(t) == "outcome" and t["prompt_number"] not in demoted_out}

# days (+08:00) with >=3 non-skipped turns must each keep >=1
_day_n = defaultdict(int)
for t in seq:
    _day_n[t["day"]] += 1
COVER_DAYS = {d for d, n in _day_n.items() if n >= 3}


def always_keep(t):
    pn = t["prompt_number"]
    if pn in correctors:
        return True
    if t["type"] == "compact" or pn in endpoints:
        return True
    mk = marker(t)
    if mk == "outcome" and pn not in demoted_out:
        return True
    if mk == "invalidated":                        # status=undone / was_interrupted
        return True
    if mk == "reversed" and pn not in victims:     # pure rewind, no in-session corrector
        return True
    return False


def make_score(cfg):
    TB = {"decision": cfg["decision"], "feature": cfg["feature"],
          "refactor": cfg["feature"], "bugfix": 2, "change": 1,
          "discovery": cfg["discovery"]}
    Wi, Ws, Wf = cfg["W_insight"], cfg["W_spec"], 1
    Wc, Ccap, Wb = cfg["W_cite"], cfg["CITE_CAP"], cfg["W_burst"]

    def sc(t):
        if always_keep(t):
            return INF
        ty = t["type"] or ""
        s = TB.get(ty, 0)
        if ty in ("feature", "refactor", "change") and not t["files_mod"]:
            s = 0
        # role tags fold into tag_fam (bare-only); dedicated role channel deferred (T546)
        s += max(Wi * t["has_insight"], Ws * t["pure_spec"], Wf * t["tag_fam"])
        s += min(indeg.get(t["prompt_number"], 0), Ccap) * Wc
        if (t["tool_call_count"] or 0) > THRESHOLD:
            s += Wb
        return s
    return sc


def select(sc, POOL_MIN, DAY_BASE, DAY_MAX):
    def in_pool(t):
        if always_keep(t):
            return True
        if t["prompt_number"] in victims:      # hard-exclude superseded victims
            return False
        return sc(t) >= POOL_MIN

    by_day = defaultdict(list)
    for t in seq:
        if in_pool(t):
            by_day[t["day"]].append(t)

    final = set()
    for day, members in by_day.items():
        cap = min(DAY_BASE + len(members) // DAY_DIV, DAY_MAX)
        # run constraint -> <=2 weighted reps per (run,day):
        #   the run's LAST-in-prompt-order member + the highest-scored OTHER
        weighted = [t for t in members if sc(t) != INF]
        runs = defaultdict(list)
        for t in weighted:
            runs[run_id[t["prompt_number"]]].append(t)
        reps = []
        for grp in runs.values():
            grp_by_prompt = sorted(grp, key=lambda t: t["prompt_number"])
            last = grp_by_prompt[-1]
            reps.append(last)
            others = [g for g in grp if g["prompt_number"] != last["prompt_number"]]
            if others:
                reps.append(max(others, key=lambda t: (
                    sc(t), (t["tool_call_count"] or 0), -t["prompt_number"])))
        # TOTAL per-day cap: structural (inf) + weighted reps compete together;
        # top-cap kept, plus any always-keep that overflows past the cap.
        structural = [t for t in members if sc(t) == INF]
        candidates = structural + reps
        candidates.sort(key=lambda t: (-sc(t), -(t["tool_call_count"] or 0),
                                       t["prompt_number"]))
        for t in candidates[:cap]:
            final.add(t["prompt_number"])
        for t in candidates[cap:]:
            if sc(t) == INF:                      # always-keep overflow
                final.add(t["prompt_number"])
    return final


def hard_checks(final):
    anchors_ok    = ANCHORS <= final
    correctors_ok = correctors <= final
    covered = {idx[pn]["day"] for pn in final}
    cover_ok = COVER_DAYS <= covered
    total = len(final)
    total_ok = 82 <= total <= 105
    return {
        "anchors": anchors_ok, "correctors": correctors_ok,
        "cover": cover_ok, "total": total_ok,
        "all": anchors_ok and correctors_ok and cover_ok and total_ok,
        "total_n": total, "missing_days": sorted(COVER_DAYS - covered),
    }


def objective(final):
    return 2 * len(final & GOLD) - 3 * len(final & MUD)


# ---- grid ----
GRID = {
    "decision":  [3, 4],
    "feature":   [2, 3],
    "discovery": [1, 2],
    "W_insight": [2, 3],
    "W_spec":    [2, 3],
    "W_cite":    [1, 2],
    "CITE_CAP":  [2, 3],
    "W_burst":   [0, 1],
    "POOL_MIN":  [1, 2, 3],
    "DAY_BASE":  [3, 4],
    "DAY_MAX":   [6, 7, 8],
}
KEYS = list(GRID.keys())


def iter_grid():
    import itertools
    for combo in itertools.product(*(GRID[k] for k in KEYS)):
        yield dict(zip(KEYS, combo))


def evaluate(cfg):
    sc = make_score(cfg)
    final = select(sc, cfg["POOL_MIN"], cfg["DAY_BASE"], cfg["DAY_MAX"])
    hc = hard_checks(final)
    obj = objective(final)
    return final, hc, obj


def run_grid():
    valid = []
    n_total = 0
    for cfg in iter_grid():
        n_total += 1
        final, hc, obj = evaluate(cfg)
        if hc["all"]:
            valid.append((cfg, final, hc, obj))
    # deterministic ordering: max objective, more GOLD, fewer MUD,
    # total nearest 93 (mid of 82-105), then canonical param tuple
    def key(rec):
        cfg, final, hc, obj = rec
        return (-obj, -len(final & GOLD), len(final & MUD),
                abs(hc["total_n"] - 93), tuple(cfg[k] for k in KEYS))
    valid.sort(key=key)
    return valid, n_total


if __name__ == "__main__":
    valid, n_total = run_grid()
    print(f"grid: {n_total} configs, {len(valid)} pass all hard constraints")
    print(f"seq(non-skipped)={NONSKIP}  outcome-anchors={len(ANCHORS)}  "
          f"correctors={len(correctors)}  victims={len(victims)}  "
          f"cover-days>=3={len(COVER_DAYS)}  THRESHOLD>{THRESHOLD}")
    if not valid:
        raise SystemExit("no config satisfies the hard constraints")

    def line(cfg, final, hc, obj, tag):
        g, m = len(final & GOLD), len(final & MUD)
        return (f"{tag} obj={obj:+d}  GOLD={g}/28  MUD={m}/12  "
                f"kept={hc['total_n']} ({hc['total_n']/NONSKIP*100:.1f}%)  "
                f"cfg={ {k: cfg[k] for k in KEYS} }")

    print("\n=== TOP-3 CONFIGS ===")
    for i, (cfg, final, hc, obj) in enumerate(valid[:3], 1):
        print(line(cfg, final, hc, obj, f"#{i}"))

    win_cfg, win_final, win_hc, win_obj = valid[0]
    g, m = len(win_final & GOLD), len(win_final & MUD)
    print("\n=== WINNER ===")
    print(f"config       : { {k: win_cfg[k] for k in KEYS} }")
    print(f"objective    : {win_obj:+d}  (= 2*{g} - 3*{m})")
    print(f"GOLD hits    : {g}/28   (miss: {sorted(GOLD - win_final)})")
    print(f"MUD violate  : {m}/12   (viol: {sorted(MUD & win_final)})")
    print(f"total kept   : {win_hc['total_n']}  retention {win_hc['total_n']/NONSKIP*100:.1f}%")
    print("hard checks  : "
          f"anchors={'OK' if win_hc['anchors'] else 'FAIL'} "
          f"correctors={'OK' if win_hc['correctors'] else 'FAIL'} "
          f"day-coverage={'OK' if win_hc['cover'] else 'FAIL'} "
          f"total-in-[82,105]={'OK' if win_hc['total'] else 'FAIL'}")

    ref = s2.pset(s2.ref)
    added = sorted(win_final - ref)
    removed = sorted(ref - win_final)

    def row(pn):
        t = idx[pn]
        sg = []
        if t["has_insight"]: sg.append("insight")
        if t["pure_spec"]:   sg.append("spec")
        if t["tag_fam"]:     sg.append("fam")
        if t["role_hit"]:    sg.append("role")
        if indeg.get(pn, 0): sg.append(f"cite{indeg[pn]}")
        mk = marker(t) or ""
        return (f"  T{pn:<4d} {t['type'] or '?':9s} {mk:10s} "
                f"[{','.join(sg)}]  {(t['title'] or '(untitled)')[:66]}")

    print(f"\n=== WINNER vs REF(94)  added={len(added)} removed={len(removed)} ===")
    print(f"--- ADDED (in winner, not in REF)  [{len(added)}] ---")
    for pn in added:
        print(row(pn))
    print(f"--- REMOVED (in REF, not in winner)  [{len(removed)}] ---")
    for pn in removed:
        print(row(pn))

    # ---- sensitivity: hold winner fixed, sweep one param at a time ----
    print("\n=== SENSITIVITY (winner-local, objective range per param) ===")
    for k in KEYS:
        objs = []
        for v in GRID[k]:
            c = dict(win_cfg); c[k] = v
            final, hc, obj = evaluate(c)
            objs.append((v, obj if hc["all"] else None))
        vals = [o for _, o in objs if o is not None]
        if vals:
            spread = max(vals) - min(vals)
        else:
            spread = 0
        detail = ", ".join(f"{v}:{'X' if o is None else f'{o:+d}'}" for v, o in objs)
        flag = "MATERIAL" if spread >= 2 else ("minor" if spread == 1 else "flat")
        print(f"  {k:10s} spread={spread:>2d} [{flag:8s}]  {detail}")
