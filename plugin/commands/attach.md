---
description: Choose which segment this session is attached to — the segment whose card and lane vocabulary get injected. Re-picks, or cancels.
argument-hint: "[E<n> | detach]"
disable-model-invocation: true
---

Attachment decides which segment cards this session sees at SessionStart, and
therefore which lane vocabulary it may write. It is the user's call, not yours —
never pick on their behalf.

`$ARGUMENTS`

1. **If the argument is already an `E<n>` address**, skip straight to step 4.
   **If it is `detach`**, skip to step 5. Otherwise continue.

2. Call `remember` with `verb: "attach"` and **no `id`**. That returns the pick
   list: one row per live segment, `E<n> <title> — #<tag>`, with `(unnamed)`
   where nobody has named the segment yet (that is the common case today) and
   `(attached)` on the bindings this session already has.

3. Ask the user with `AskUserQuestion`. It allows at most four options, and
   there are usually more live segments than that, so:
   - offer the **first three rows** of the list as options — label `E<n>`,
     description the row's title and tag;
   - offer `Detach` as the fourth;
   - say in the question text that any other segment on the list above can be
     typed into "Other" as its bare `E<n>` address.
   Never invent a row that was not on the list.

4. **Attach:** call `remember` with `verb: "attach"` and `id: "E<n>"`. The
   result is that segment's card — its own tag in the header, its working state
   below — followed by a separate `- lanes:` line naming the lanes declared in
   it. Those two vocabularies, the segment tag and the declared lanes, are the
   whole of what this session may now write into a turn's `tags`; the card
   itself lists no lanes. Report to the user which segment is now attached, in
   one line. Do not restate the card; they can see it.

5. **Detach:** call `remember` with `verb: "detach"` and, if the user named one,
   `id: "E<n>"`; with no `id` it cancels every binding this session has. Say in
   one line what is no longer attached. A detach sticks: writing that segment's
   tag again will not re-attach this session, so coming back means running this
   command again.

Two facts worth telling the user if they ask:

- Writing a segment's tag into a turn's `tags` already attaches this session to
  that segment on its own — but only for a turn of THIS session, and only for a
  segment this session has not explicitly detached. This command is the
  override, for attaching before anything has been written, changing the
  choice, or cancelling it.
- A new attachment's card is injected from the next SessionStart on, and its
  lane vocabulary rides that SessionStart's roster row; the card and the
  `- lanes:` line returned right now are how this session sees both in the
  meantime.
