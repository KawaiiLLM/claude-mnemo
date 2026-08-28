import csv, collections, re, json
R=list(csv.DictReader(open('/tmp/mstudy/all-features.tsv'),delimiter='\t'))
I=lambda r,k:int(r[k])
LBL={}
S=list(csv.DictReader(open('/Users/zhaoqixuan/Projects/claude-mnemo/.scratch/milestone-election-study/labels.tsv'),delimiter='\t'))
for r in S: LBL[r['turn_id']]=r['label']

UR=re.compile(r'\b[Uu]ser\b|用户|裁定|ruled|ruling|orders|approve[sd]?\b|endorse')
OPSJOB=re.compile(r'\bjob \d+|dispatch|backfill', re.I)
RELEASE=re.compile(r'releas|ships?\b|\d+\.\d+\.\d+')

def is_opsdispatch(r):
    types={t for t in r['type'].split(',') if t}
    return bool(OPSJOB.search(r['title'])) and types <= {'ops','delegate','implement','review','measure'} \
           and not RELEASE.search(r['title'])

def is_decision(r):
    types={t for t in r['type'].split(',') if t}
    return bool(types & {'design','correction'}) and (I(r,'out_override')>=1 or bool(UR.search(r['title'])))

def wdeg(r):
    return 2*(I(r,'in_narrows')+I(r,'in_verifies')+I(r,'in_indexes')) \
         + 1*(I(r,'in_grounds')+I(r,'in_consume')) + 0.5*I(r,'in_extends')

def new_tier(r):
    t=r['tier']
    if t=='1': return 1
    if t=='2': return 2
    # ops-dispatch demotion applies ONLY to nodes that did not qualify on their
    # own (tier 1/2 = wrote index edges themselves) — a campaign-closing index
    # turn keeps its seat even though its title names the campaign.
    if is_opsdispatch(r): return 6
    if is_decision(r): return 3          # NEW tier: decision turns
    if t=='4': return 4                  # correctors promoted above indexed-by-elected
    if t=='3': return 5                  # indexed-by-elected demoted
    return 6

def key(r): return (new_tier(r), -wdeg(r), -I(r,'out_all'), -I(r,'turn_id'))

out=[]
def P(*a):
    s=' '.join(str(x) for x in a); print(s); out.append(s)

for seg in ('E60','E70'):
    P(f'\n===== {seg} =====')
    for side in ('old','recent'):
        G=[r for r in R if r['seg']==seg and r['side']==side]
        if not G: continue
        K=sum(1 for r in G if r['elected']=='1')
        if K==0:
            P(f'{side}: K=0, skipped'); continue
        new=sorted(G,key=key)[:K]
        cur={r['turn_id'] for r in G if r['elected']=='1'}
        nid={r['turn_id'] for r in new}
        P(f'{side}: K={K}  kept {len(cur&nid)}  dropped {len(cur-nid)}  added {len(nid-cur)}')
        def mix(rows,name):
            c=collections.Counter(t for r in rows for t in r['type'].split(',') if t)
            n=len(rows)
            P(f'   {name} type mix: '+', '.join(f'{k} {v}({v/n:.0%})' for k,v in c.most_common(6)))
            P(f'   {name} user-ruling-titled: {sum(1 for r in rows if UR.search(r["title"]))}/{n}'
              f' | ops-dispatch-shaped: {sum(1 for r in rows if is_opsdispatch(r))}/{n}')
        mix([r for r in G if r['elected']=='1'],'CURRENT')
        mix(new,'PROPOSED')
        drops=[r for r in G if r['turn_id'] in (cur-nid)]
        adds=[r for r in G if r['turn_id'] in (nid-cur)]
        P('   -- dropped (sample of 8) --')
        for r in drops[:8]: P(f'     {r["addr"]} t{r["tier"]}->{new_tier(r)} {r["type"]:28s} lbl={LBL.get(r["turn_id"],"-"):6s} | {r["title"][:62]}')
        P('   -- added (sample of 8) --')
        for r in adds[:8]: P(f'     {r["addr"]} t{r["tier"]}->{new_tier(r)} {r["type"]:28s} lbl={LBL.get(r["turn_id"],"-"):6s} | {r["title"][:62]}')
        # labeled-subset scoring
        lab=[r for r in G if r['turn_id'] in LBL]
        if lab:
            cm=sum(1 for r in lab if r['turn_id'] in cur and LBL[r['turn_id']]=='MUST')
            nm=sum(1 for r in lab if r['turn_id'] in nid and LBL[r['turn_id']]=='MUST')
            cn=sum(1 for r in lab if r['turn_id'] in cur and LBL[r['turn_id']]=='NO')
            nn=sum(1 for r in lab if r['turn_id'] in nid and LBL[r['turn_id']]=='NO')
            tot=sum(1 for r in lab if LBL[r['turn_id']]=='MUST')
            P(f'   labeled subset (n={len(lab)}, MUST={tot}): current seats {cm} MUST / {cn} NO -> proposed seats {nm} MUST / {nn} NO')

P('\n===== backfill-five fate =====')
for a in ('S15069/T1876','S15069/T1877','S15069/T1882','S15069/T1883','S15069/T1885','S15069/T1888'):
    r=[x for x in R if x['addr']==a]
    if not r: P(a,'not found'); continue
    r=r[0]
    G=[x for x in R if x['seg']==r['seg'] and x['side']==r['side']]
    K=sum(1 for x in G if x['elected']=='1')
    nid={x['turn_id'] for x in sorted(G,key=key)[:K]}
    P(f'  {a} type={r["type"]:22s} tier {r["tier"]}->{new_tier(r)}  elected_now={r["elected"]} elected_proposed={1 if r["turn_id"] in nid else 0}  opsdispatch={is_opsdispatch(r)} | {r["title"][:60]}')

open('/tmp/mstudy/simulation.txt','w').write('\n'.join(out))
