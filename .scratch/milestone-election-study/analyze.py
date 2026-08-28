import csv, json, collections, re, sys, os
OUT='/Users/zhaoqixuan/Projects/claude-mnemo/.scratch/milestone-election-study'
S=list(csv.DictReader(open('/tmp/mstudy/sample-features.tsv'),delimiter='\t'))
I=lambda r,k:int(r[k])
km=json.load(open('/tmp/mstudy/keymap.json'))
km2=json.load(open('/tmp/mstudy/keymap2.json'))
A={}
for line in open('/tmp/mstudy/labels-A.tsv'):
    p=line.rstrip('\n').split('\t')
    if len(p)>=2 and p[0].startswith('B'): A[p[0]]=(p[1].strip(),p[2] if len(p)>2 else '')
B={}
for line in open('/tmp/mstudy/labels-B.tsv'):
    p=line.rstrip('\n').split('\t')
    if len(p)>=2 and p[0].startswith('C'): B[p[0]]=(p[1].strip(),p[2] if len(p)>2 else '')
lab={}   # turn_id -> label
rsn={}
for pid,(l,r) in A.items(): lab[km[pid]]=l; rsn[km[pid]]=r
for r in S:
    r['label']=lab.get(r['turn_id'],'?')
    r['label_reason']=rsn.get(r['turn_id'],'')

report=[]
def P(*a):
    s=' '.join(str(x) for x in a); print(s); report.append(s)

P('## label distribution')
P('overall', collections.Counter(r['label'] for r in S))
for seg in ('E60','E70'):
    P(seg, collections.Counter(r['label'] for r in S if r['seg']==seg))
P('by stratum:')
for st in sorted(set(r['stratum'] for r in S)):
    P('  ',st, collections.Counter(r['label'] for r in S if r['stratum']==st))

P('\n## self-consistency (pass B vs pass A on 16 re-shuffled cards)')
agree=0; flips=[]
for pid,(l,_) in B.items():
    tid=km2[pid]; la=lab.get(tid,'?')
    if la==l: agree+=1
    else: flips.append((tid,la,l))
P(f'exact agreement {agree}/{len(B)} = {agree/len(B):.0%}')
# collapsed MUST vs not
ag2=sum(1 for pid,(l,_) in B.items() if (l=='MUST')==(lab.get(km2[pid])=='MUST'))
P(f'MUST-vs-rest agreement {ag2}/{len(B)} = {ag2/len(B):.0%}')
for tid,la,lb in flips:
    row=[r for r in S if r['turn_id']==tid][0]
    P(f'  FLIP {row["seg"]} {row["addr"]} A={la} B={lb} | {row["title"][:70]}')

P('\n## 1. current election vs MUST labels')
for seg in ('E60','E70','ALL'):
    G=[r for r in S if seg=='ALL' or r['seg']==seg]
    tp=sum(1 for r in G if r['elected']=='1' and r['label']=='MUST')
    fp=sum(1 for r in G if r['elected']=='1' and r['label']!='MUST')
    fn=sum(1 for r in G if r['elected']=='0' and r['label']=='MUST')
    tn=sum(1 for r in G if r['elected']=='0' and r['label']!='MUST')
    prec=tp/(tp+fp) if tp+fp else 0; rec=tp/(tp+fn) if tp+fn else 0
    P(f'{seg}: elected={tp+fp} MUST={tp+fn} TP={tp} FP={fp} FN={fn} TN={tn} precision={prec:.2f} recall={rec:.2f}')
    # MUST+USEFUL as positive
    tp2=sum(1 for r in G if r['elected']=='1' and r['label'] in ('MUST','USEFUL'))
    fp2=sum(1 for r in G if r['elected']=='1' and r['label']=='NO')
    P(f'   (MUST+USEFUL positive) elected precision={tp2/(tp2+fp2):.2f}  NO-rate among elected={fp2}/{tp2+fp2}')

P('\n## 2. feature table  (MUST-rate with feature vs without)')
def feat_rows():
    yield ('elected today', lambda r: r['elected']=='1')
    yield ('tier1 unsettled-index (release)', lambda r: r['tier']=='1')
    yield ('tier2 declares-index', lambda r: r['tier']=='2')
    yield ('tier3 indexed-by-elected', lambda r: r['tier']=='3')
    yield ('tier4 corrector', lambda r: r['tier']=='4')
    yield ('tier5 other', lambda r: r['tier']=='5')
    yield ('in_pos>=2', lambda r: I(r,'in_pos')>=2)
    yield ('in_pos==0', lambda r: I(r,'in_pos')==0)
    yield ('in_extends>=1', lambda r: I(r,'in_extends')>=1)
    yield ('in_extends>=2', lambda r: I(r,'in_extends')>=2)
    yield ('in_indexes>=1', lambda r: I(r,'in_indexes')>=1)
    yield ('in_narrows>=1', lambda r: I(r,'in_narrows')>=1)
    yield ('in_verifies>=1', lambda r: I(r,'in_verifies')>=1)
    yield ('in_grounds>=1', lambda r: I(r,'in_grounds')>=1)
    yield ('in_consume>=1', lambda r: I(r,'in_consume')>=1)
    yield ('out_override>=1 (corrector)', lambda r: I(r,'out_override')>=1)
    yield ('out_indexes>=1 (declares index)', lambda r: I(r,'out_indexes')>=1)
    yield ('out_extends>=1', lambda r: I(r,'out_extends')>=1)
    yield ('extends_depth>=5', lambda r: I(r,'extends_depth')>=5)
    yield ('type: ops', lambda r: 'ops' in r['type'])
    yield ('type: design', lambda r: 'design' in r['type'])
    yield ('type: correction', lambda r: 'correction' in r['type'])
    yield ('type: discuss', lambda r: 'discuss' in r['type'])
    yield ('type: review', lambda r: 'review' in r['type'])
    yield ('type: measure', lambda r: 'measure' in r['type'])
    yield ('type: delegate', lambda r: 'delegate' in r['type'])
    yield ('type: implement', lambda r: 'implement' in r['type'])
    yield ('type: research', lambda r: 'research' in r['type'])
    yield ('type: fix', lambda r: 'fix' in r['type'])
    yield ('has insight', lambda r: r['has_insight']=='1')
    yield ('title mentions user ruling', lambda r: bool(re.search(r'\b[Uu]ser\b|用户|裁定|ruling|ruled|approve|endorse|orders', r['title'])))
    yield ('title job/dispatch/backfill ops', lambda r: bool(re.search(r'[Jj]ob \d|dispatch|backfill|released|commits', r['title'])))
P(f'{"feature":42s} {"n":>4s} {"MUSTin":>7s} {"rate":>6s} | {"nOut":>4s} {"MUSTout":>8s} {"rate":>6s}')
FT=[]
for name,f in feat_rows():
    ins=[r for r in S if f(r)]; outs=[r for r in S if not f(r)]
    mi=sum(1 for r in ins if r['label']=='MUST'); mo=sum(1 for r in outs if r['label']=='MUST')
    ri=mi/len(ins) if ins else 0; ro=mo/len(outs) if outs else 0
    P(f'{name:42s} {len(ins):4d} {mi:7d} {ri:6.2f} | {len(outs):4d} {mo:8d} {ro:6.2f}')
    FT.append((name,len(ins),mi,ri,len(outs),mo,ro))

P('\n## 3. the backfill-dispatch class')
BF=[r for r in S if re.search(r'[Jj]ob \d|backfill|dispatch',r['title'],re.I)]
for r in sorted(BF,key=lambda r:r['addr']):
    P(f'  {r["seg"]} {r["addr"]} elected={r["elected"]} tier={r["tier"]}/{r["reason"]} in={r["in_pos"]} in_ext={r["in_extends"]} in_idx={r["in_indexes"]} depth={r["extends_depth"]} type={r["type"]} LABEL={r["label"]} | {r["title"][:60]}')

P('\n## 4. false negatives (labeled MUST, election rejects)')
FN=[r for r in S if r['label']=='MUST' and r['elected']=='0']
for r in FN:
    P(f'  {r["seg"]} {r["addr"]} tier={r["tier"]}/{r["reason"]} in={r["in_pos"]} out_ovr={r["out_override"]} out_idx={r["out_indexes"]} type={r["type"]} | {r["title"][:70]}')
P(' FN tier dist',collections.Counter(r['tier'] for r in FN))
P(' FN type dist',collections.Counter(t for r in FN for t in r['type'].split(',') if t))
P(' FN in_pos dist',collections.Counter(r['in_pos'] for r in FN))
P('\n## 4b. false positives (elected, labeled NO)')
FP=[r for r in S if r['label']=='NO' and r['elected']=='1']
for r in FP:
    P(f'  {r["seg"]} {r["addr"]} tier={r["tier"]}/{r["reason"]} in={r["in_pos"]} in_ext={r["in_extends"]} type={r["type"]} | {r["title"][:70]}')
P(' FP tier dist',collections.Counter(r['tier'] for r in FP))
P(' FP type dist',collections.Counter(t for r in FP for t in r['type'].split(',') if t))

# ---- candidate rescoring simulation on the sample ----
P('\n## 5. proposal simulation (sample-level, rank-quality proxy)')
def score(r):
    s=0.0
    # tier signal, but demoted for ops-only chain rows
    if r['tier']=='1': s+=3
    elif r['tier']=='2': s+=3
    elif r['tier']=='3': s+=1
    elif r['tier']=='4': s+=3
    s += 1.5*min(I(r,'in_indexes'),3) + 1.5*min(I(r,'in_narrows'),3) + 1.0*min(I(r,'in_verifies'),3) \
       + 0.5*min(I(r,'in_grounds'),3) + 0.25*min(I(r,'in_extends'),3) + 0.25*min(I(r,'in_consume'),3)
    if I(r,'out_override')>=1: s+=2
    if 'correction' in r['type'] or 'discuss' in r['type']: s+=1.5
    if re.search(r'\b[Uu]ser\b|用户|裁定|ruling|ruled|orders|approve', r['title']): s+=1.5
    if 'ops' in r['type'] and not re.search(r'released|release|ships|0\.\d+\.\d+', r['title']): s-=2
    if re.search(r'[Jj]ob \d+|dispatch', r['title']): s-=2
    return s
for seg in ('E60','E70'):
    G=[r for r in S if r['seg']==seg]
    k=sum(1 for r in G if r['elected']=='1')
    top=sorted(G,key=score,reverse=True)[:k]
    tp=sum(1 for r in top if r['label']=='MUST'); m=sum(1 for r in G if r['label']=='MUST')
    no=sum(1 for r in top if r['label']=='NO')
    cur_tp=sum(1 for r in G if r['elected']=='1' and r['label']=='MUST')
    cur_no=sum(1 for r in G if r['elected']=='1' and r['label']=='NO')
    P(f'{seg}: same seat count K={k} | current TP={cur_tp}/{m} NO={cur_no} -> proposed TP={tp}/{m} NO={no}')

with open('/tmp/mstudy/analysis.txt','w') as f: f.write('\n'.join(report))
# labels.tsv deliverable
cols=[c for c in S[0].keys()]
with open(OUT+'/labels.tsv','w') as f:
    f.write('\t'.join(cols)+'\n')
    for r in S: f.write('\t'.join(str(r.get(c,'')) for c in cols)+'\n')
print('\nwrote', OUT+'/labels.tsv')
