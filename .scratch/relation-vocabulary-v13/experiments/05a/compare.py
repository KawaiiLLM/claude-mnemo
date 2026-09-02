#!/usr/bin/env python3
"""05a — candidate vs A, on both elected surfaces.

`frontier`: the SessionStart milestone slot, parsed back into per-LANE row sets
(`#tag` digest line, then that lane's accepted rows). The lane is the unit the
ticket asks for; a row's text carries its address and title.

`milestones`: the per-SEGMENT election (`electMilestones`) — the surface tier ④
lives on. Unit is the segment.
"""
import json, re, sys

SC = "/private/tmp/claude-501/-Users-zhaoqixuan-Projects-claude-mnemo/e8541c19-7fef-4ead-9f31-c7bb88aa75b1/scratchpad/05a"
SUFFIX = sys.argv[1] if len(sys.argv) > 1 else ""

def load(c):
    return {s["segmentId"]: s for s in json.load(open(f"{SC}/{c}{SUFFIX}.json"))}

SESSION_PREFIX = re.compile(r"^S\d+/")

def norm(row):
    """The `S<n>/` prefix renders only when the session CHANGES from the row
    above, so a pure reordering flips it on rows that did not otherwise move.
    Strip it: the row's identity is its `T<n>` plus date plus title."""
    return SESSION_PREFIX.sub("", row)

def lanes(block):
    """-> {laneTag: [row text, ...]} from one rendered frontier block."""
    out, cur = {}, None
    for line in block.split("\n")[1:]:
        if line.startswith("#"):
            cur = line.split(" · ")[0][1:]
            out.setdefault(cur, [])
        elif line.startswith("… +"):
            cur = None
        elif cur is not None:
            out[cur].append(norm(line))
    return out

base = load("A")
print(f"{'cand':5} | {'lanes chg':9} | {'rows +':6} | {'rows -':6} | {'segs chg':8} | {'ms +':5} | {'ms -':5}")
print("-" * 70)
details = {}
for c in ["B", "C", "D", "E3", "E5", "E8"]:
    cur = load(c)
    lane_changed, radd, rdrop = 0, 0, 0
    seg_changed, madd, mdrop = 0, 0, 0
    samples = []
    milestone_samples = []
    for sid, b in base.items():
        bl, cl = lanes(b["frontier"]), lanes(cur[sid]["frontier"])
        for tag in sorted(set(bl) | set(cl)):
            bset, cset = set(bl.get(tag, [])), set(cl.get(tag, []))
            if bset != cset:
                lane_changed += 1
                added, dropped = sorted(cset - bset), sorted(bset - cset)
                radd += len(added); rdrop += len(dropped)
                if len(samples) < 5:
                    samples.append((f"E{sid}/#{tag}", added, dropped))
        bm = {m["turnId"]: m for m in b["milestones"]}
        cm = {m["turnId"]: m for m in cur[sid]["milestones"]}
        if set(bm) != set(cm):
            seg_changed += 1
            madd += len(set(cm) - set(bm)); mdrop += len(set(bm) - set(cm))
            if len(milestone_samples) < 5:
                milestone_samples.append((
                    f"E{sid}",
                    [f'{cm[t]["address"]} {cm[t]["title"]}' for t in sorted(set(cm) - set(bm))],
                    [f'{bm[t]["address"]} {bm[t]["title"]}' for t in sorted(set(bm) - set(cm))],
                ))
    print(f"{c:5} | {lane_changed:9} | {radd:6} | {rdrop:6} | {seg_changed:8} | {madd:5} | {mdrop:5}")
    details[c] = (samples, milestone_samples)

for c, (samples, msamples) in details.items():
    if samples:
        print(f"\n===== {c}: first {len(samples)} changed LANES (frontier slot) =====")
        for tag, added, dropped in samples:
            print(f"  {tag}")
            for r in added:   print(f"    + {r}")
            for r in dropped: print(f"    - {r}")
    if msamples:
        print(f"\n===== {c}: first {len(msamples)} changed SEGMENTS (milestone election) =====")
        for tag, added, dropped in msamples:
            print(f"  {tag}")
            for r in added:   print(f"    + {r}")
            for r in dropped: print(f"    - {r}")
