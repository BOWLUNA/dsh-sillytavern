# dsh-group-chat

Standalone multi-agent group chat for DeepSeek Harness. Depends on the platform
and on nothing tavern-specific.

**Status: skeleton.** The durable room table, the boundary validator and the two
browser seats are in place and tested. Rooms do not yet run turns.

## What exists

- **`src/wire.ts`** — the single validation entry. Every untrusted value becomes
  a typed one here or is rejected. No trimming, no defaulting, no coercion: an
  unrecognised room mode is an error rather than a silent `round-robin`, and an
  empty name is an error rather than a row that takes the whole storage domain
  down on the next boot.
- **`src/domain.ts`** — the durable room table (`group_chat`, `per-record`
  layout). Every record carries an `owner` field.
- **`src/index.ts`** — the host half: `ctx.groupChat`, opened at mount, with one
  clear diagnostic if the platform's `storageDomain` API has moved.
- **`src/client/index.tsx`** — two additive browser seats: `conversation.view`
  (a group transcript beside the shipped chat and trajectory views) and
  `settings.section`.
- **`@dsh-tavern/contracts/client-slots`** — the seat-claiming helper, shared
  with the tavern rather than copied into both.

## What does not exist yet

Turn scheduling, reroll/swipe, message editing and tombstones, character cards,
slash commands, and the RPC surface that would let the browser half do anything.
Nothing here injects into a model prompt.

## Tests

```sh
node --test tests/*.test.ts
```

Ten assertions, all written against rejections rather than happy paths. Two pin
failures that corrupted real data in the previous project: an unknown room mode
silently becoming `round-robin` (leaving ghost rooms), and an empty name
reaching storage (making the whole domain refuse to open, so *every* room became
unreachable, not just the bad one).

## Installing

```sh
dsh plugin --profile <name> add ./packages/group-chat
```

Install this **or** `dsh-tavern`, not both — both declare a row with id
`group-chat`.
