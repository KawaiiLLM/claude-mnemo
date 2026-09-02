#!/usr/bin/env python3
"""05a — the three 0.29.0 windows on the FRONTIER surface.

`windows.ts` runs the per-window `electMilestones`; this runs the other half —
the lanes those windows' turns belong to, in the SessionStart frontier slot,
under each `use`-weight candidate. (The `use` weight touches only the frontier;
the convergence rule touches only `electMilestones`, so E-candidates appear in
`windows.ts` and not here.)
"""
import json, re
SC = "/private/tmp/claude-501/-Users-zhaoqixuan-Projects-claude-mnemo/e8541c19-7fef-4ead-9f31-c7bb88aa75b1/scratchpad/05a"
P = re.compile(r"^S\d+/")

def lanes(block):
    out, cur = {}, None
    for line in block.split("\n")[1:]:
        if line.startswith("#"):
            cur = line.split(" · ")[0][1:]; out.setdefault(cur, [])
        elif line.startswith("… +"):
            cur = None
        elif cur is not None:
            out[cur].append(P.sub("", line))
    return out

def load(c):
    return {s["segmentId"]: lanes(s["frontier"]) for s in json.load(open(f"{SC}/{c}.json"))}

# Lane tags carried by the three windows' own turns (`turns.tags`, topic: namespace excluded).
WINDOWS = {
    "S15069/T2302-2351": ["relation-vocabulary", "lane-impressions", "settlement-scope",
                          "dream-agent", "workflow", "watchdog-liveness", "process-audit"],
    "S23566/T101-150": ["action-as-cosplay", "rp-harness", "extraction-pipeline"],
    "S18993/T101-150": ["san11-ai-npc", "visual-style", "kernel-architecture", "map-data-extraction"],
}

A = load("A")
for c in ["B", "C", "D"]:
    X = load(c)
    print(f"=== {c} — frontier lanes carrying the three windows' turns ===")
    for window, tags in WINDOWS.items():
        hits = []
        for sid in A:
            for tag in tags:
                if tag in A[sid] or tag in X[sid]:
                    before, after = set(A[sid].get(tag, [])), set(X[sid].get(tag, []))
                    if before != after:
                        hits.append((f"E{sid}/#{tag}", sorted(after - before), sorted(before - after)))
        print(f"  {window}: {len(hits)} lane(s) changed")
        for tag, added, dropped in hits:
            print(f"    {tag}  +{len(added)} / -{len(dropped)}")
            for r in added: print(f"      + {r}")
            for r in dropped: print(f"      - {r}")
