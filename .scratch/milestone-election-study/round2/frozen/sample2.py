#!/usr/bin/env python3
"""Round-2 frozen sampler. RNG SEED = 20260829, stated before any label exists.

Two disjoint label batches, merged and shuffled so no judge can tell them apart:
  S  stratified gap-fill: 35 per segment from the RECENT side of the frozen
     manifest, excluding anything already labeled in round 1 and excluding the
     union of what any arm seats (those are covered by D below). This is the
     non-seated recent coverage the MUST-capture denominator needs.
  D  label-on-demand: every turn ANY arm seats that carries no round-1 label.

Round-1 reuse: labels.tsv (80) + labels-validation.tsv minus the six rows that
overlapped training (S15069/T1446,T1862,T1893, S15440/T833,T995,T999) = 34.
"""
import csv, json, os, random, re, sqlite3, pathlib

SEED = 20260829
random.seed(SEED)

M = pathlib.Path("/tmp/mstudy2")
R1 = pathlib.Path("/Users/zhaoqixuan/Projects/claude-mnemo/.scratch/milestone-election-study")
CONTAMINATED = {"S15069/T1446", "S15069/T1862", "S15069/T1893",
                "S15440/T833", "S15440/T995", "S15440/T999"}

manifest = list(csv.DictReader(open(M / "A" / "manifest.tsv"), delimiter="\t"))
by_id = {r["turn_id"]: r for r in manifest}

labeled = {}
for row in csv.DictReader(open(R1 / "labels.tsv"), delimiter="\t"):
    labeled[row["turn_id"]] = row["label"]
for row in csv.DictReader(open(R1 / "labels-validation.tsv"), delimiter="\t"):
    if row["addr"] in CONTAMINATED:
        continue
    labeled.setdefault(row["turn_id"], row["label"])

seated_union = set()
for arm in "ABCD":
    for row in csv.DictReader(open(M / arm / "seated.tsv"), delimiter="\t"):
        seated_union.add(row["turn_id"])

# ---- batch S ----
batch_s = []
for seg in ("E60", "E70"):
    pool = [r for r in manifest
            if r["seg"] == seg and r["side"] == "recent"
            and r["turn_id"] not in labeled and r["turn_id"] not in seated_union]
    pool.sort(key=lambda r: int(r["turn_id"]))   # deterministic pre-shuffle order
    random.shuffle(pool)
    batch_s += pool[:35]

# ---- batch D ----
batch_d = sorted((t for t in seated_union if t not in labeled), key=int)

combined = [(r["turn_id"], "S") for r in batch_s] + [(t, "D") for t in batch_d]
random.shuffle(combined)

# ---- blind cards ----
db = sqlite3.connect("file:" + os.path.expanduser("~/.claude-mnemo/claude-mnemo.db") + "?mode=ro", uri=True)
ids = [int(t) for t, _ in combined]
txt = {row[0]: row for row in db.execute(
    "select id,title,content,insight from turns where id in (%s)" % ",".join("?" * len(ids)), ids)}

REF = re.compile(r"\[(S\d+/)?T\d+\]")
def clean(s, cap):
    if not s:
        return ""
    s = REF.sub("[REF]", s)
    return re.sub(r"\s+", " ", s).strip()[:cap]

def card(pid, tid):
    _, ti, co, ins = txt[int(tid)]
    return f"### {pid}\ntitle: {clean(ti,140)}\ncontent: {clean(co,650)}\ninsight: {clean(ins,260)}\n"

keymap, cards = {}, []
for i, (tid, batch) in enumerate(combined, 1):
    pid = "R%03d" % i
    keymap[pid] = {"turn_id": tid, "batch": batch,
                   "seg": by_id[tid]["seg"], "side": by_id[tid]["side"]}
    cards.append(card(pid, tid))

NJ = 4
per = -(-len(cards) // NJ)
for j in range(NJ):
    chunk = cards[j * per:(j + 1) * per]
    if chunk:
        (M / f"blind-batch-{j+1}.md").write_text("\n".join(chunk))

# ---- 20% relabel by a second judge, re-shuffled, fresh pseudo-ids ----
sub = random.sample(list(keymap.items()), max(1, round(0.20 * len(keymap))))
random.shuffle(sub)
keymap2, cards2 = {}, []
for i, (pid, info) in enumerate(sub, 1):
    xid = "X%03d" % i
    keymap2[xid] = {"turn_id": info["turn_id"], "orig_pid": pid}
    cards2.append(card(xid, info["turn_id"]))
(M / "blind-recheck.md").write_text("\n".join(cards2))

json.dump(keymap, open(M / "keymap-r2.json", "w"), indent=0)
json.dump(keymap2, open(M / "keymap-r2-recheck.json", "w"), indent=0)

# ---- type-drift audit: 15 `design` turns from July, 15 from late August ----
drift = []
for label, lo, hi in (("jul", "2026-07-01", "2026-07-31"), ("aug", "2026-08-20", "2026-08-31")):
    pool = [r for r in manifest
            if "design" in r["type"].split(",") and lo <= r["date"] <= hi]
    seen, uniq = set(), []
    for r in pool:                      # manifest lists a turn once per side; dedupe
        if r["turn_id"] in seen:
            continue
        seen.add(r["turn_id"])
        uniq.append(r)
    uniq.sort(key=lambda r: int(r["turn_id"]))
    random.shuffle(uniq)
    drift += [(r["turn_id"], label) for r in uniq[:15]]
random.shuffle(drift)
ids2 = [int(t) for t, _ in drift]
txt.update({row[0]: row for row in db.execute(
    "select id,title,content,insight from turns where id in (%s)" % ",".join("?" * len(ids2)), ids2)})
keymap3, cards3 = {}, []
for i, (tid, window) in enumerate(drift, 1):
    did = "D%03d" % i
    keymap3[did] = {"turn_id": tid, "window": window}
    cards3.append(card(did, tid))
(M / "blind-drift.md").write_text("\n".join(cards3))
json.dump(keymap3, open(M / "keymap-r2-drift.json", "w"), indent=0)

print(f"seed={SEED} batchS={len(batch_s)} batchD={len(batch_d)} total={len(combined)} "
      f"judgeBatches={NJ}x{per} recheck={len(cards2)} drift={len(cards3)} reused_r1={len(labeled)}")
