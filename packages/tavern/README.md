# dsh-tavern

The tavern for DeepSeek Harness: a full central page, character cards, world
info — and it bundles `dsh-group-chat` so one install gives the whole thing.

**Status: skeleton.** The binding table is real and tested; the books, cards and
engine behind it are not written yet.

## The one structural idea worth reading

`src/bindings.ts` is the answer to the previous project's most expensive bug.

There, one table held "the books bound to target X", and two legitimate writers
used it: the group lifecycle (adding its own book on start, removing it on stop)
and a human editing the binding overview. The overview saved a whole row from a
snapshot taken earlier, so a save silently deleted whatever the lifecycle had
added in between. It was found, fixed on one side, and found again from the
other. Two audits, two packages, one lost-data path — and the fix that finally
held was a rule for humans, which is exactly the kind of rule that gets
forgotten.

Here, ownership is **structural**: every row is keyed by `owner + target`, and no
operation can reach another owner's row. The clobbering write is not discouraged,
it is unrepresentable. Injection resolves the union of the rows.

```sh
node --test tests/*.test.ts     # 15 assertions, the first one being the invariant
```

## What exists

- **`src/bindings.ts`** — binding rows, ownership isolation, deterministic
  resolution order.
- **`src/domain.ts`** — the durable `tavern_seat` table.
- **`src/index.ts`** — `ctx.tavernContextSeat`: `addBinding` / `removeBinding`
  (owned by group chat), `setUserBinding` (owned by the human),
  `setTavernBinding` (owned by the tavern), and `booksFor(target)`.
- **`src/client/index.tsx`** — claims `main` with its own key plus a
  `sidebar.panellist` icon, giving the tavern a **whole page** rather than a
  settings dialog. The previous project put everything in `settings.section`,
  inside a fixed-width container with `overflow: hidden` — which cost two review
  rounds of `max-width` patching, one selector at a time, and never left room to
  be a tavern.

## What does not exist yet

Books, the world-info engine, character cards, prompt injection. Specifically,
`ContextSeatSeam.mount` is declared in the contract but **deliberately absent
from the service** — nothing injects into a prompt yet, and a no-op that returned
a disposer would look like it worked. A loud absence beats a silent one.

## Installing

```sh
dsh plugin --profile <name> add ./packages/tavern
```

This is the aggregate: its patch inserts both its own row and `dsh-group-chat`'s.
Install it **or** `dsh-group-chat` alone, never both.
