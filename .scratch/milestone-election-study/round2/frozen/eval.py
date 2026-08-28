#!/usr/bin/env python3
"""Round-2 evaluation. Reads the four arms' real-card seated sets and the
merged label set; prints per-arm x per-segment K / MUST capture / NO
contamination, dev-vs-holdout, and the seated-set diffs vs arm A.
"""
import csv, json, collections, pathlib, re, sys

M = pathlib.Path("/tmp/mstudy2")
R1 = pathlib.Path("/Users/zhaoqixuan/Projects/claude-mnemo/.scratch/milestone-election-study")
CONTAMINATED = {"S15069/T1446", "S15069/T1862", "S15069/T1893",
                "S15440/T833", "S15440/T995", "S15440/T999"}
DEV, HOLDOUT = "E60", "E70"

# ---------- labels ----------
labels, source = {}, {}
for row in csv.DictReader(open(R1 / "labels.tsv"), delimiter="\t"):
    labels[row["turn_id"]] = row["label"]; source[row["turn_id"]] = "r1-train"
for row in csv.DictReader(open(R1 / "labels-validation.tsv"), delimiter="\t"):
    if row["addr"] in CONTAMINATED or row["turn_id"] in labels:
        continue
    labels[row["turn_id"]] = row["label"]; source[row["turn_id"]] = "r1-val"

keymap = json.load(open(M / "keymap-r2.json"))
r2 = {}
for j in (1, 2, 3, 4):
    path = M / f"labels-judge{j}.tsv"
    if not path.exists():
        sys.exit(f"missing {path}")
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        pid, lab = parts[0].strip(), parts[1].strip().upper()
        if pid not in keymap:
            continue
        r2[pid] = lab
missing = [p for p in keymap if p not in r2]
if missing:
    print(f"WARN: {len(missing)} pids unlabeled: {missing[:10]}")
for pid, lab in r2.items():
    tid = keymap[pid]["turn_id"]
    labels[tid] = lab
    source[tid] = "r2-" + keymap[pid]["batch"]

# ---------- inter-rater agreement ----------
if (M / "labels-recheck.tsv").exists():
    km2 = json.load(open(M / "keymap-r2-recheck.json"))
    same = must_same = n = 0
    flips = []
    for line in (M / "labels-recheck.tsv").read_text().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        xid, lab = parts[0].strip(), parts[1].strip().upper()
        if xid not in km2:
            continue
        orig = r2.get(km2[xid]["orig_pid"])
        if orig is None:
            continue
        n += 1
        same += orig == lab
        must_same += (orig == "MUST") == (lab == "MUST")
        if orig != lab:
            flips.append(f"{km2[xid]['orig_pid']}:{orig}->{lab}")
    print(f"\n== inter-rater (n={n}) exact {same}/{n} = {same/n:.2f} | "
          f"MUST-vs-rest {must_same}/{n} = {must_same/n:.2f}")
    print("   flips:", ", ".join(flips[:25]))

# ---------- arms ----------
man = {r["turn_id"]: r for r in csv.DictReader(open(M / "A" / "manifest.tsv"), delimiter="\t")}
arms = {}
for arm in "ABCD":
    rows = list(csv.DictReader(open(M / arm / "election.tsv"), delimiter="\t"))
    arms[arm] = rows

print("\n== label pool ==")
print("total labeled:", len(labels), collections.Counter(labels.values()))
print("by source:", collections.Counter(source.values()))
for seg in (DEV, HOLDOUT):
    pool = [t for t in labels if t in man and man[t]["seg"] == seg]
    print(f"  {seg}: labeled={len(pool)}", collections.Counter(labels[t] for t in pool))

print("\n== per arm x segment ==")
hdr = f"{'arm':<4}{'seg':<6}{'K':>4}{'Kold':>6}{'Krec':>6}{'MUSTcap':>18}{'NOcontam':>14}{'seatLabeled':>12}"
print(hdr)
results = {}
for arm in "ABCD":
    for seg in (DEV, HOLDOUT):
        rows = [r for r in arms[arm] if r["seg"] == seg]
        seated = [r for r in rows if r["seated"] == "1"]
        k = len(seated)
        kold = sum(1 for r in seated if r["side"] == "old")
        krec = k - kold
        pool_must = [r for r in rows if labels.get(r["turn_id"]) == "MUST"]
        cap = [r for r in pool_must if r["seated"] == "1"]
        seat_lab = [r for r in seated if r["turn_id"] in labels]
        seat_no = [r for r in seat_lab if labels[r["turn_id"]] == "NO"]
        results[(arm, seg)] = dict(k=k, kold=kold, krec=krec,
                                   must_n=len(pool_must), must_cap=len(cap),
                                   no=len(seat_no), seat_lab=len(seat_lab))
        capstr = f"{len(cap)}/{len(pool_must)} = {len(cap)/max(1,len(pool_must)):.2f}"
        nostr = f"{len(seat_no)}/{len(seat_lab)} = {len(seat_no)/max(1,len(seat_lab)):.2f}"
        print(f"{arm:<4}{seg:<6}{k:>4}{kold:>6}{krec:>6}{capstr:>18}{nostr:>14}{len(seat_lab):>12}")

print("\n== seated-set diff vs arm A ==")
seatsets = {}
for arm in "ABCD":
    for seg in (DEV, HOLDOUT):
        seatsets[(arm, seg)] = {r["turn_id"] for r in arms[arm] if r["seg"] == seg and r["seated"] == "1"}
byid = {(r["seg"], r["turn_id"]): r for arm in "A" for r in arms[arm]}
for arm in "BCD":
    for seg in (DEV, HOLDOUT):
        enter = seatsets[(arm, seg)] - seatsets[("A", seg)]
        leave = seatsets[("A", seg)] - seatsets[(arm, seg)]
        def tally(ids):
            return collections.Counter(labels.get(t, "-") for t in ids)
        print(f"\n{arm} vs A / {seg}: +{len(enter)} -{len(leave)}  ENTER {dict(tally(enter))}  LEAVE {dict(tally(leave))}")
        armrows = {r["turn_id"]: r for r in arms[arm] if r["seg"] == seg}
        for tag, ids in (("+", sorted(enter, key=int)), ("-", sorted(leave, key=int))):
            for t in ids:
                r = armrows.get(t) or byid[(seg, t)]
                print(f"   {tag} {r['addr']:<14} {labels.get(t,'-'):<7} {r['side']:<7} {r['reason']:<18} {r['type'][:26]:<27} {r['title'][:64]}")

# ---------- probes ----------
print("\n== probes ==")
for pname in ("dispatch", "user-ruling"):
    ids = set((M / f"probe-{pname}.ids").read_text().split())
    print(f"\n{pname}: {len(ids)} in manifest")
    for arm in "ABCD":
        line = []
        for seg in (DEV, HOLDOUT):
            rows = [r for r in arms[arm] if r["seg"] == seg and r["turn_id"] in ids]
            s = [r for r in rows if r["seated"] == "1"]
            lab = collections.Counter(labels.get(r["turn_id"], "-") for r in s)
            line.append(f"{seg} seated {len(s)}/{len(rows)} {dict(lab)}")
        print(f"  {arm}: " + " | ".join(line))

json.dump({f"{a}/{s}": v for (a, s), v in results.items()}, open(M / "results.json", "w"), indent=1)
