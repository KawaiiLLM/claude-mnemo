import csv, random, re, json, sqlite3, os
random.seed(20260828)
ROWS=list(csv.DictReader(open('/tmp/mstudy/all-features.tsv'),delimiter='\t'))
INT=lambda r,k:int(r[k])
by={}
for r in ROWS: by[r['turn_id']]=r

DECISION_HINT=re.compile(r'(user|User|裁定|ruled|ruling|decide|decided|decision|rejected|reject|abandon|dropped|chose|choice|instead of|not |wrong|corrected|approve|approv|endorse|verdict|定案|口径|判)')

def pick(pool,n,taken):
    pool=[r for r in pool if r['turn_id'] not in taken]
    random.shuffle(pool)
    out=pool[:n]
    for r in out: taken.add(r['turn_id'])
    return out

sample=[]
for seg in ('E60','E70'):
    S=[r for r in ROWS if r['seg']==seg]
    taken=set()
    elected=[r for r in S if r['elected']=='1']
    # 1. elected, stratified by tier
    tiers={}
    for r in elected: tiers.setdefault(r['tier'],[]).append(r)
    el_pick=[]
    quota=14
    per=max(1,quota//max(1,len(tiers)))
    for t,rs in sorted(tiers.items()):
        el_pick+=pick(rs,per,taken)
    el_pick+=pick(elected,quota-len(el_pick),taken)
    for r in el_pick: r['stratum']='elected'
    sample+=el_pick
    # 2. time-matched rejected: nearest non-elected neighbour by row index
    idx={r['turn_id']:i for i,r in enumerate(S)}
    rej=[]
    for r in el_pick:
        i=idx[r['turn_id']]
        for d in range(1,25):
            for j in (i-d,i+d):
                if 0<=j<len(S) and S[j]['elected']=='0' and S[j]['turn_id'] not in taken:
                    S[j]['stratum']='rejected-timematched'; taken.add(S[j]['turn_id']); rej.append(S[j]); break
            else: continue
            break
        if len(rej)>=12: break
    sample+=rej
    # 3. high in-degree, NOT elected, not tier1/2, not corrector
    hi=[r for r in S if r['elected']=='0' and INT(r,'in_pos')>=2 and r['tier'] not in ('1','2') and r['reason']!='corrector']
    p=pick(hi,7,taken)
    for r in p: r['stratum']='high-indegree-rejected'
    sample+=p
    # 4. low degree, not elected, decision-ish title
    lo=[r for r in S if r['elected']=='0' and INT(r,'in_pos')==0 and DECISION_HINT.search(r['title'])]
    p=pick(lo,7,taken)
    for r in p: r['stratum']='low-degree-decisive-looking'
    sample+=p

print('sample size',len(sample))
import collections
print(collections.Counter((r['seg'],r['stratum']) for r in sample))

# --- blind cards ---
db=sqlite3.connect('file:'+os.path.expanduser('~/.claude-mnemo/claude-mnemo.db')+'?mode=ro',uri=True)
ids=[int(r['turn_id']) for r in sample]
q=db.execute('select id,title,content,insight from turns where id in (%s)'%','.join('?'*len(ids)),ids)
txt={row[0]:row for row in q}

REF=re.compile(r'\[(S\d+/)?T\d+\]')
def clean(s,cap):
    if not s: return ''
    s=REF.sub('[REF]',s)
    s=re.sub(r'\s+',' ',s).strip()
    return s[:cap]

order=sample[:]
random.shuffle(order)
cards=[]
keymap={}
for i,r in enumerate(order,1):
    pid='B%03d'%i
    keymap[pid]=r['turn_id']
    _,ti,co,ins=txt[int(r['turn_id'])]
    cards.append(f"### {pid}\ntitle: {clean(ti,140)}\ncontent: {clean(co,650)}\ninsight: {clean(ins,260)}\n")
open('/tmp/mstudy/blind-cards.md','w').write('\n'.join(cards))
json.dump(keymap,open('/tmp/mstudy/keymap.json','w'))

# self-consistency subsample: 20%, re-shuffled, new pseudo-ids
sub=random.sample(order,16)
cards2=[];keymap2={}
for i,r in enumerate(sub,1):
    pid='C%03d'%i
    keymap2[pid]=r['turn_id']
    _,ti,co,ins=txt[int(r['turn_id'])]
    cards2.append(f"### {pid}\ntitle: {clean(ti,140)}\ncontent: {clean(co,650)}\ninsight: {clean(ins,260)}\n")
open('/tmp/mstudy/blind-cards-recheck.md','w').write('\n'.join(cards2))
json.dump(keymap2,open('/tmp/mstudy/keymap2.json','w'))

cols=list(sample[0].keys())
with open('/tmp/mstudy/sample-features.tsv','w') as f:
    f.write('\t'.join(cols)+'\n')
    for r in sample: f.write('\t'.join(str(r.get(c,'')) for c in cols)+'\n')
print('cards written', len(cards), len(cards2))
