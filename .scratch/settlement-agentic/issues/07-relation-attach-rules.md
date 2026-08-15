# 07 — A relation must be argued in the body that carries it

**What to build:** Saying "this overturns that" requires having said why in the prose. Settlement can improve a relation with hindsight but cannot invent the link.

**Blocked by:** 06

**Status:** ready-for-agent

Named fields, not a generic `{turn, relation}` list: with four values a named field makes an illegal relation unrepresentable. The four ordered questions and the counterfactual wording for `depends-on` are in spec C3-C4 and must reach the prompt verbatim.

- [ ] Relations are set through named fields, one per relation
- [ ] A relation naming a turn the body does not cite is rejected
- [ ] The same target under two relation fields is rejected
- [ ] The main agent may attach a relation to a pair its own write is creating
- [ ] Settlement may attach or correct a relation only on a pair present in its transaction's pre-state, and may not attach one to a pair the same call creates
- [ ] Settlement writing a body whose citations create bare pairs stays legal — it authors segment bodies, and a new segment has no citing node before it exists
- [ ] Full suite green
