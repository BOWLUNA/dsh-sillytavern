# Structure

Why this rewrite exists, what it changed, and what has actually been verified.

This file is the single entry point for the project's reasoning. It is written
from measurements and from the legacy tree in `../../_legacy/`, and it states
plainly what is *not* yet true — because the legacy project's most expensive
failure was documentation that read as evidence while being neither.

---

## 1. What went wrong last time

Three complaints, all true, all with the same shape: a conclusion was written
down instead of a check.

**"The UI could never be got right."** The browser suites existed but were not
run. Of twelve, six executed for the first time in the final review round. Tool
failures meant three review rounds verified client fixes with `typecheck` only.
Tombstone deletion and message editing were marked fixed across five rounds and
98 unit tests, and never once rendered — every assertion was made at the RPC
layer, and the platform's human transcript projection discards the event type
those features produce. Nobody had asserted a rendered result.

**"The features kept conflicting."** One table had two legitimate writers, and
the resulting clobber was found twice, in both directions, across two packages.
The fix that finally held was a rule for humans — "cross-plugin binding may only
be targeted add/remove" — which is exactly the kind of rule that gets forgotten.
The deeper cause was that ordering, queues and speaker selection were three
state machines whose failure paths were never wired together.

**"The development was messy."** Contracts arrived by audit patch rather than by
design. Validation was added field by field over three rounds; the word
"silently" appears 26 times in the legacy review documents, twice describing
data corruption. One bug's responsibility was spread over six variables, and
each audit round added another. Meanwhile the documents drifted: the
architecture file still describes the synthetic turn number as `0` while the
code and the changelog say `1`, and three packages carried two different
versions against one changelog.

The single most expensive incident: to work around the platform treating
log-only sessions as "blank", the plugin wrote synthetic `turn` events into
session logs. It used `turn: 0`. The platform's persistence layer requires
`turn >= 1` and rejects the whole session otherwise, so **52 sessions became
unopenable** and needed a bespoke migration tool. The lesson is not "be careful
with turn numbers" — it is: *anything written into a platform-owned structure
needs its validator found first, and a regression test that violates it.*

---

## 2. The five rules

Each answers one of those failures, and each has a home in the code where it can
be checked rather than remembered.

| # | Rule | Where it lives | How it is checked |
| --- | --- | --- | --- |
| 1 | A table has one writer per row, and ownership is part of the data | `contracts/src/index.ts` (`Owner`), `tavern/src/bindings.ts` (rows keyed by owner+target) | `tavern/tests/bindings.test.ts` — one owner's write cannot drop another's books |
| 2 | One validation entry per boundary, and it rejects loudly | `group-chat/src/wire.ts`, `contracts` (`RejectError`, `reject`) | `group-chat/tests/wire.test.ts` — unknown enum values reject instead of defaulting |
| 3 | "What the user clicked" is one immutable value, frozen at click time | `group-chat/src/intent.ts` (`RerollIntent`), `group-chat/src/scheduler.ts` | `group-chat/tests/reroll.test.ts` — the intent keeps its turn and relay after the room moves on; a failed delivery re-queues rather than freezing |
| 4 | Never forge platform events; read the raw stream and own the projection | not yet implemented (transcript) | not yet |
| 5 | An unclicked "fixed" is not fixed | `tools/browser-verify.mjs` + the lab | the four browser assertions, and the screenshots in `images/` |

Rules 1–3 are implemented and tested: 51 assertions across the two packages, all
of them written against rejections or pinned values rather than happy paths.
Rules 4 and 5 are design commitments waiting for the features that need them;
they are listed here so the features get built against them rather than
retrofitted. (Rule 5's tooling exists and has run; it becomes a *rule* once UI
work starts landing against it.)

### What rule 3 looks like in code

`RerollIntent` is frozen at acceptance and carries every dimension the legacy
project spread across six mutable fields — room, member, turn, relay, generation,
id. There are **no fallbacks**: a request whose turn or relay cannot be pinned is
rejected rather than aimed at "the latest", because that fallback is exactly how
replacement text ended up in the wrong round.

The scheduler around it is a pure state machine, which is what makes the legacy
concurrency bugs unrepresentable rather than merely unlikely:

| Legacy bug | Why it cannot happen here |
| --- | --- |
| Two fork replays both claimed the floor (claimed after an `await`) | `claim` is synchronous, explicit, and throws when the floor is held |
| A drain that threw left nothing scheduled — carousel frozen, no error | `settle(…, 'failed')` always re-queues the work and releases the floor |
| A reroll queued while paused was silently shelved | the drain gate excludes only `stopped`, not `paused` |
| A second click for the same member+turn overwrote the first | duplicate `(member, turn)` keys are refused, not merged |
| A reroll from before a restart targeted takes that no longer exist | the generation is captured in the intent; `beginGeneration` drops the rest |

### Keeping the platform out of the testable part

Three times now the same boundary has been drawn, and it has paid each time:
`MemberRuntime` (group-chat), `SeatHost` plus `seatText` (tavern), and the schema
split. The rule is one sentence: **a module that imports a platform package
cannot be loaded by a test in this workspace**, where those packages are
deliberately absent.

So the parts that can be *wrong in an interesting way* are reachable without a
host, and the platform-touching edge is a thin function. That is why `mount`
delegates to `seatText` rather than containing the logic, why `domain.ts` holds
only the `defineDomain` call with the schemas beside it in `schema.ts`, and why
the prompt sanitiser and the validator primitives live in the shared contract
package instead of being copied into both plugins — which is exactly what the
legacy project did with `prompt-macros.ts` and `ui.tsx`, twice each.

### The loop that consumes it

`conductor.ts` drives the scheduler: claim, ask a `Speaker` for a take, settle
the outcome, repeat. It never talks to an agent directly — the `Speaker` port is
the whole interface. That is not indirection for its own sake:

- **the loop's rules are testable.** Member agents need credentials and a model,
  so a loop verified only end-to-end is verified by hand, at best. The legacy
  project's scheduling rules were never exercised by a test at all.
- **the agent wiring stays thin.** If a bug turns out to be in the loop, no part
  of the agent adapter is implicated.

Two bounds are worth naming. `pump` is single-flight, so there is never a window
with two deliveries in it — the legacy double-fork came from claiming the floor
*after* an await. And a consecutive-failure budget pauses the room rather than
retrying forever: a persistently failing speaker would otherwise spin as fast as
the microtask queue allows, which the legacy harness hit and worked around by
suspending its mock until abort.

### Seven bugs the gates caught while building this

Each is an argument for a specific check, not an anecdote.

1. **Two words for one concept.** `Delivery` says `'speak'`; an earlier draft of
   the conductor said `'speech'`. So `delivery.kind === 'speech'` was never true
   and relay sequence numbers silently stopped advancing. Node's type stripping
   does not care, and the shadowed branch still "worked" — only `tsc` objected.
   The vocabulary is now single, and the reason is written where the next person
   will read it.
2. **A field and a getter with the same name.** `private state` alongside
   `get state()` is a duplicate identifier to `tsc`, and at runtime the own field
   simply shadows the prototype getter — so all 49 tests passed while the class
   was wrong. Renamed to `current` behind the getter. This is the cleanest
   illustration available of why *tests passing* and *verified* are different
   claims.
3. **The assertions passed and the screen was wrong.** After adding a member, the
   member list refreshed but the room row did not, so the row read "0 名成员"
   directly above a member that was plainly visible. Every DOM assertion was
   looking in the right place and found what it expected; the wrong number was
   somewhere none of them looked. The screenshot caught it.

   That third one is the reason this project takes screenshots at all, and the
   reason `browser-verify.mjs` now asserts the row's count as well as the list.
   A visual check is not decoration on top of assertions — it is the only check
   that sees the whole page, including the parts nobody thought to query.
4. **A test that asserted nothing.** A lorebook fixture set
   `secondaryLogic: logic` — but the field is `selectiveLogic`. Node's type
   stripping does not check types, so the key was inert, the field kept its
   default, and four assertions about secondary-key logic ran against mode 0
   while claiming to run against modes 0–3. Green, and worthless.

   This is a failure mode worth naming separately: the *test* was wrong, not the
   code, and nothing about a passing suite reveals it. The typecheck gate caught
   it — the same gate as bug 2, on the opposite side of the fence. It is the
   argument for having both a test runner and a compiler, rather than trusting
   either alone.
5. **A descriptor named a service that does not exist.** The tavern's service key
   is `tavernContextSeat`; the descriptors said `service: 'tavern'`. The gateway
   answered `active Service "tavern" is unavailable` — from a browser, and from
   nowhere earlier, because `remote.test.ts` deliberately checks only the table's
   internal consistency (importing the service class needs the platform, which
   this workspace does not have). That limitation was documented when the test was
   written; this is the debt it predicted coming due, and it was cheap.
6. **…and then the namespace disagreed with the binding.** With the service key
   fixed, the gateway said `inconsistent typertRemote binding`:
   `TypertRemoteService` defaults its wire namespace to the service key, while the
   descriptors used `tavern`. One line — `super(ctx, key, { namespace })` — and
   the errors 5 and 6 together are the best argument in this document for keeping
   the browser round-trip in the loop. Both were invisible to 158 green tests and
   to a clean typecheck; the first real call reported each precisely.
7. **A kick that arrived mid-loop was swallowed.** `pump()` is single-flight, so a
   request accepted while a run was finishing got handed the already-finished
   promise and was never scheduled. The work sat in the queue with no error —
   the *silently shelved* shape the legacy project kept rediscovering, this time
   in code written specifically to avoid it. Found by wiring the room runner up,
   not by a test, because the window only exists when a real caller lands a
   request while a delivery is unwinding. The fix — record the kick and run at
   least one more pass — is now pinned by `conductor.test.ts`.

   Seven bugs, and the pattern is by now unmistakable: **each was found by the
   gate that exercises the thing end to end, and by no earlier gate.** The
   typecheck found two, the screenshot found two, a real browser call found two,
   and this one was found by a real caller. None of them was found by reading.

---

## 3. Seat table

Every seat this project claims, and what kind of seat it is. The distinction
that matters: `list` seats are **additive** — many plugins coexist — while
`single` seats and occupied `keyed` cells have exactly one occupant, and
registering an occupied key *replaces* it. Two features wanting the same chair
was the legacy project's most common "features conflict" shape.

| Seat | Package | Kind | Replaces anything? |
| --- | --- | --- | --- |
| `conversation.view` | group-chat | list, session | no — sits beside the shipped `chat` and `trajectory` views |
| `settings.section` | group-chat | list, root | no |
| `main` (key `tavern`) | tavern | keyed, root | no — its own key; the shipped `conversation` key is untouched |
| `sidebar.panellist` | tavern | list, root | no |

Claims are made through `contracts/src/client-slots.ts`, which retries while the
platform has not yet declared the target slot's table and gives up with a
diagnostic instead of failing the whole plugin apply.

**Seats deliberately not taken**, with reasons:

- `conversation.chat.node` — its key table is fixed by the platform, so styling
  the user bubble means *replacing* the shipped renderer.
- `conversation.composer` — a `chain` seat whose selector is evaluated once per
  session render, so reacting to state needs re-registration. The tavern owns
  the composer story instead.
- `sidebar.footer.action` — the platform's sidebar does not respond to entries
  registered after boot. The legacy project recorded this as a dead end and then
  kept depending on it as its only entry point.

---

## 4. Platform facts, measured

Each of these was read out of the running install, not inferred. Re-verify after
a dsh upgrade.

**The browser module table is nine specifiers.** A client bundle may value-import
only these; anything else fails at page load, not at build time, which is why
`tools/build-plugin.mjs` refuses it at build time instead:

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

Two specifiers the legacy project depended on — `@deepseek-ai/dsh-client-web-react`
and `@deepseek-ai/dsh-client-runtime` — do not exist on this platform.

**`dsh.client` in package.json is `DshClientManifest`:**

```ts
{ platform: string; inject?: string[]; immediately?: boolean; external?: string[] }
```

`inject` is *not* cordis service injection — it is informational package-name
edges. `external` lists module requests beyond the baseline; type-only imports
are erased, so they create no request.

**Client bundles must export `{ name, inject, apply }`.** `inject` there *is*
the cordis service list, and it is load-bearing: the client registry guards
service reads, so leaving it out makes `get('slots')` return nothing and
`apply` be refused — silently, with the module present and correctly versioned
in the graph.

**Storage domains validate on load, not on write.** `defineDomain` /
`domainTable` pin the record schemas and the platform runs them when a domain is
opened. A record that fails takes the whole domain down (`invalid-record`), so
the writer-side validator must be at least as strict as the reader-side schema.
`invalidRecords: 'backup-and-skip'` exists for genuinely disposable derived data;
neither of our tables uses it, because a corrupt room must stop the boot loudly
rather than disappear quietly.

**`typert` validates nothing.** RPC arguments must be guarded on our side.

**`ctx.typert`'s declared type is narrower than the live service.** The type in
`@deepseek-ai/dsh-typert-protocol` (`TypertRegistryContract`) describes only the
read side — `local`, `remotes`, `lookups`, `contexts` — while the running service
also exposes the write side, which the host's own service directory reports as
`register(contribution: TypertContribution): TypertDisposer`. `remote.ts` names
the one method it uses and guards it at runtime rather than casting at the call
site. Ask the live host, not the `.d.ts`, when the two disagree.

**Descriptors are the only way in for an out-of-tree plugin.** There is no code
generation, and the `@Remote` decorator is doubly unavailable here: it needs
source-mode parameter names that bundling destroys, and this project's compiler
is Node's type stripper, which erases types and rejects decorator syntax. So
invocations are stated explicitly, and their correspondence to the class is
checked from the browser rather than by the compiler (see §5).

### The prompt renderer throws, and where

`@deepseek-ai/dsh-system-prompt` interpolates every prompt section and context
with a strict scanner. Read out of the running 0.1.6-alpha.1 build:

```js
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
for (let open = text.indexOf("{{"); open >= 0; open = text.indexOf("{{", last)) {
  // a {{ with a later }} that is not a clean {{name}} group   -> throw
  // a well-formed name that is not a registered variable       -> throw
  // a registered name whose value is undefined                 -> throw
  // otherwise                                                  -> substitute
}
return result + text.slice(last)   // reached with no throw when there is no {{
```

Three of those four are reachable from ordinary writing. A character persona
containing `{{char}}` — the most natural thing in the world to write — is an
**unregistered** variable, so *every request for that member fails*. It is not a
display problem; the turn cannot complete. That was a late P0 in the legacy
project.

The last line is the useful one: the loop's entry condition is
`indexOf('{{')`, so **a string containing no `{{` cannot throw**, whatever the
scanner does afterwards and whatever a future version adds. `prompt.ts` is built
to that property rather than to a list of known-bad names, because the registered
variable set is not enumerable from a plugin and can change under us. The
guarantee is asserted directly — `!output.includes('{{')` — over a corpus of
hostile inputs, and again at the runtime port where a real agent would receive it.

### Blank sessions, and why nothing here forges one

Re-measured on 0.1.6-alpha.1, because the legacy project's conclusion came from an
older build and this is exactly the kind of finding that deserves re-checking
rather than inheriting. Two quotes from the installed platform:

- `dsh-client-ui-conversation`, `ConversationSession`: *"Renders the active
  Session view inside the resident scrollport … **or null while the Session
  remains blank**."*
- `dsh-client-ui-workspace`, `tree.d.ts`: *"Blank sessions are **excluded** except
  for the selected provisional New Session row"*, and *"the renderer substitutes
  the localized New Session label for blank rows."*

So it still holds: a session with no turn is a *provisional* session — the hero
page, a "New Session" row — and a plugin's `conversation.view` does not render in
one. The legacy project responded by writing synthetic `turn/start` + `turn/end`
pairs to make its rooms stop looking blank. That is how `turn: 0` reached session
logs and left 52 sessions unopenable.

We do not do that. A room that has not spoken *is* empty, and the hero page is the
honest rendering of that. The room's own surface is `settings.section` (and the
tavern's `main` page), which do not depend on the session being non-blank. The
cost is real and accepted: a freshly created room does not appear as a titled row
in the sidebar until it has taken a turn.

**A second constraint, measured at the same time.** `ctx.sessions.create` says:

> *"Persistence is intentionally not implemented here — the agent lifecycle
> attaches a session-log writer to each published session's write handle; a
> session published outside that lifecycle persists nothing."*

A room session created directly by this plugin would therefore be **in-memory
only**: its transcript would not survive a restart. So durable room transcripts
require the agent lifecycle, which requires the agent adapter — which is why
sessions come after it rather than before. Recorded here so the ordering is a
decision, not an accident.

**A bundle patch may only `insert`; a profile `cordis.patch.yml` may only
replace rows that already exist.** An insert in the profile patch fails with
"entry not found".

---

## 5. Verification status

Kept current by hand for now; the intent is that a gate writes it.

| Check | Status | Evidence |
| --- | --- | --- |
| Host half builds | ✅ | `lib/index.js`, 5.7 KB (group-chat) / 10.9 KB (tavern) |
| Browser half builds | ✅ | `lib/client.js`, wrapped in `window.__ModuleLoader__.load`, 8.4 KB / 6.0 KB |
| `dsh.client` is accepted by the platform | ✅ | `pnpm run verify:client` feeds each declaration to the platform's own `parseDshClient`; both return a valid manifest |
| The promised bundle exists where it is promised | ✅ | same gate resolves `exports["./client"]` and checks `lib/client.js` is on disk |
| Client bundle requires nothing outside the baseline | ✅ | same gate reads the built artifact and finds only `react`, `react/jsx-runtime` — both baseline, so `external` is correctly empty |
| No second copy of a platform package is installed | ✅ | `node_modules/@deepseek-ai/` does not exist; `autoInstallPeers: false` |
| Typecheck | ✅ | `tsc` exit 0 across both packages, client halves included |
| Boundary + ownership invariants | ✅ | 172 tests, `node --test` (16 wire + 17 bindings + 26 reroll/scheduler + 14 conductor + 10 rooms + 4 remote + 13 prompt + 17 speaker + 35 lorebook + 20 seat/schema) |
| Nothing can make the prompt renderer throw | ✅ | `prompt.test.ts` asserts `!output.includes('{{')` over a hostile corpus, and `speaker.test.ts` re-asserts it at the runtime port |
| The agent adapter's lifecycle | ✅ | `speaker.test.ts` — generation replacement, one spawn per member under concurrency, disposal is idempotent, a late agent is still disposed, a reroll answers its pinned relay |
| The world-info engine | ✅ | `lorebook.test.ts` — 35 assertions, one per bug that shipped: cross-book id collision, a macro expanding to empty, an unsafe regex, group skipping, probability re-rolling, the `\W` boundary rule, budget and output caps |
| Entry editing and the injection tester | ✅ | `browser-verify.mjs` adds an entry, saves it against the revision it read, runs the tester, and asserts the injected text plus the trace's reason. It then sets a **secondary key with AND_ALL** and asserts the entry is refused (`secondary-failed`) and accepted again when the sample satisfies it — so the editor's later fields are proven to reach the engine, not merely to render. `docs/images/tavern-tester.png` |
| Book-level settings | ✅ | the same run turns on **recursion** in the settings block and adds a second entry keyed on a word that appears *only* in the first entry's content. It fires — so the setting reached the engine. The probe cannot pass by accident: without recursion there is nothing to match |
| World books, from a browser | ✅ | `browser-verify.mjs` creates a book through the tavern's `main` page and reads it back, on the second namespace and the second browser half — so a broken descriptor or a missing `inject` entry fails here rather than in the group-chat section that already passes |
| The seat, end to end short of the host | ✅ | `seat.test.ts` — binding filters what applies, a disabled book contributes nothing, ordering follows `order` not binding order, and entry content with `{{char}}` cannot reach the renderer as a macro |
| One schema guards the wire and the record | ✅ | `parseBookCreate` / `parseBookPatch` reject whitespace-only names, out-of-range `selectiveLogic`, oversized content, and name the offending field path |
| The frozen-reroll core | ✅ | `reroll.test.ts` — 26 assertions, each corresponding to a defect the legacy project shipped |
| The room RPC surface | ✅ | `browser-verify.mjs` clicks 开始 on a room and asserts the page reports the **model boundary** — the host has no speaker installed, says so, and refuses. That verifies the whole chain (descriptor → gateway → service → runner) up to the one piece that needs a model, and pins that this path refuses rather than silently doing nothing |
| The room runner | ✅ | `rooms.test.ts` — start is idempotent, stop waits for the in-flight delivery, and a reroll's relay is resolved **from the transcript** rather than accepted from the caller |
| The delivery loop | ✅ | `conductor.test.ts` — 13 assertions: single-flight, no spin on failure, work survives a failure, a stop mid-delivery records nothing |
| Browser → host round-trip | ✅ | `browser-verify.mjs` drives the real UI: creates a room, adds a member, reads both back, removes the member, deletes the room. One browser action therefore exercises the descriptor table, the gateway, the host validator, the durable domain and the JSON return path |
| The screenshot agrees with the assertions | ✅ | see §2 — it did not, once, and the screenshot was right |
| Rows enter the composition tree | ✅ | isolated `DSH_HOME`, `--patch packages/tavern/cordis.patch.yml --dump-config`: both rows present, attributed to the patch file |
| A profile installed by our own tooling composes | ✅ | `install-local.mjs` against a clean profile, then `dsh --profile web --dump-config`: 560 lines, both rows present, attributed to `# == dsh-tavern` |
| The project builds on a second, independent machine | ✅ | copied the tree to `bl-server-tcus03`, installed dsh 0.1.6-alpha.1 there, `pnpm run verify` → exit 0. Confirms the no-hardcoded-paths design: `resolve-platform.mjs` located that machine's own dsh install |
| The plugin tree loads from a profile | ✅ | on `tcus03`, `dsh --profile lab` boots clean; the log prints only the activation URL |
| Client bundles are discovered and composed | ✅ | `window.__DSH_BOOT__` on the booted instance contains `{"id":"dsh-tavern","url":"/plugins/??dsh-tavern/client.js&rev=…","inject":[]}` and the same for `dsh-group-chat` |
| Client bundles are served | ✅ | fetched the 11.8 MB initial combo script; the bytes contain `window.__ModuleLoader__.load({ id: "dsh-tavern" …` and the group-chat wrapper |
| Client halves materialize and render | ✅ | `tools/browser-verify.mjs` against the booted lab instance: the panellist icon resolves to `<span class="dtv-icon" aria-hidden="true">🍶</span>` in the DOM |
| The whole-page seat pairing works | ✅ | clicking that icon opened the tavern page; `docs/images/tavern-books.png` is the screenshot |
| Any model-facing behaviour | ⬜ | not yet; nothing injects into a prompt |

`pnpm run verify` runs the build, the typecheck, all tests, and the client
manifest gate, and needs no server. It passes end to end on the lab machine. On
the session machine — 1.6 GB total, most of it held by the running harness — the
individual stages pass but the chained run is unreliable; run the stages
separately there, or run the whole thing on the lab.

The boot-level and browser checks are made against the lab instance on
`bl-server-tcus03`; see §7.

---

## 6. Known gaps

Honest list, in the order they should be closed.

1. **A real model round-trip is unverified — and it is now the only thing
   standing between this project and a working tavern.** Everything around the
   model is built, wired and verified: the scheduler, the delivery loop, the room
   runner, the RPC surface, and a browser assertion that starting a room reaches
   the host and stops at exactly this boundary. What does not exist is a
   `SpeakerFactory` backed by real agents, because that needs credentials and this
   lab has none. So `startGroup` refuses with a message naming the boundary.

   That is a deliberate, named hole rather than a hopeful claim, and it is one
   interface wide: `(room, transcript, takes) => Speaker`.
2. **The `conversation.view` seat is unverified in a browser.** The run covers
   the panellist icon and the tavern's `main` page. The group-chat
   `conversation.view` tab needs a session to appear in, and the lab profile has
   none — a fresh profile cannot create one without a model configured. So that
   seat is proven by the boot graph and the served bundle only, not by a DOM
   marker.

   The earlier attempts to verify any of this on the *session* machine were
   abandoned for a reason worth keeping: **that box has ~1.6 GB of RAM and the
   running instance already holds a few hundred megabytes**, so a second full
   `dsh web` is an out-of-memory event, not a test. The second attempt took the
   running harness down. Do not boot a second instance there.

   Note also that nothing on either page *does* anything yet: the tavern page is
   three cards reading "待实现". Rendering is verified; behaviour is not, because
   there is none.
3. ~~Local install of the aggregate.~~ **Done** — `tools/install-local.mjs`, and
   it copies rather than symlinks, which §7 explains was not a preference.
4. **World info is complete except for the seam itself.** The engine, the schemas, the durable table
   and the seat are all in place and tested, and `mount` registers the context —
   Books, entries, bindings, book-level settings and the injection tester all
   have descriptors, handlers, UI and a browser round-trip. Two things are
   missing, in order of how much they matter:

   - **Nothing has been observed reaching a real prompt.** That needs a member
     agent, which needs the model — see gap 1.
   - **The binding picker falls back to typing a raw target id** when there are
     no rooms, and `previewScan` / `readBook` have no unit tests of their own:
     their logic is `seatScan`, which is tested, and the transport is covered by
     the browser round-trip. That is a thinner margin than the rest of the
     project, and it is written down rather than assumed away.
5. ~~No RPC surface.~~ **Done, for rooms and members.** `remote.ts` declares nine
   invocation descriptors and `settings.section` creates, lists and deletes rooms
   and members through the real gateway — verified from a browser including both
   write round-trips (§5). What is still in-process-only: `start`/`stop`,
   `reroll` and `pick`. Those are blocked on the agent adapter, and on the
   persistence constraint recorded in §4: a session created outside the agent
   lifecycle persists nothing, so a room cannot have a durable transcript until
   the adapter exists.
6. **Rules 4–5 unimplemented**, as noted in §2 — rule 3 landed this round.
   Related: the loop's `Speaker` port has one implementation — the fake in its
   tests. No adapter drives real member agents yet, so a room can be driven
   deterministically but cannot yet talk. That adapter is the next piece; it is
   deliberately last because it is the only part that needs a model.
7. **No i18n.** Labels are literal strings; the slot registration already takes
   thunks, so this is mechanical when it matters.
8. **No packaging story.** Both packages declare `workspace:*` dependencies and
   have never been packed, versioned or published. `dsh-tavern`'s README says
   "install the aggregate", which currently only works from a checkout.

---

## 7. The lab, and the bug it caught

Testing happens on **`bl-server-tcus03`** (`100.94.39.65`, reached over the
tailnet): 2 vCPU, 3.7 GB RAM, 47 GB free, Node 24 and pnpm already present, and
nothing else deployed. Boots in about ten seconds. The session machine is
`bl-server-acus04` — the one running the harness — and is not a test target.

Setting the lab up immediately paid for itself by producing a real failure with
a precise message:

```
failed to import loader entry group-chat (dsh-group-chat):
Cannot find package '@deepseek-ai/cordis' imported from
/root/dsh-lab/dsh-tavern-v2/packages/group-chat/lib/index.js
```

**Cause.** The host half keeps `@deepseek-ai/*` external on purpose, so that one
process shares one platform instance. The loader imports a row by its **real
path**; a symlinked install therefore resolves those imports by walking up from
the checkout, where no platform package exists — by design, since
`autoInstallPeers: false` keeps a second copy out. The profile's own platform
fallback (`<profiles>/node_modules`, 117 links into the dsh install) was never
consulted, because resolution never reached it.

**Fix.** Copy the built package into `<profile>/node_modules/<name>`. The real
path then sits inside the profile, resolution reaches the fallback, and Node
dedupes by real path — so the shared instance stays shared, with no fork.
Confirmed by booting the same profile both ways: symlink fails, copy boots clean.

This is exactly the class of thing the plan expected to find and could not find
without a machine. It is also why the installer now refuses to offer a symlink
mode: a convenience that does not boot is not a convenience.

### Running the lab

The lab lives at `/root/dsh-lab/dsh-tavern-v2` on `bl-server-tcus03`, installed
into profile `lab`. It boots in about ten seconds.

```sh
# 1. copy the tree over (the lab has its own checkout; node_modules and lib are
#    excluded because both are rebuilt there)
tar czf - --exclude=node_modules --exclude=lib -C <repo-parent> dsh-tavern-v2 \
  | ssh root@100.94.39.65 'tar xzf - -C /root/dsh-lab'

# 2. rebuild and reinstall — the installer COPIES, so this is required
#    (and re-add playwright: the tar overwrites the lab's package.json, which is
#     the only place that devDependency lives)
ssh root@100.94.39.65 'cd /root/dsh-lab/dsh-tavern-v2 && pnpm add -D playwright \
  && pnpm run build && node tools/install-local.mjs --home /root/.dsh --profile lab'

# 3. boot and wait for the activation URL
ssh root@100.94.39.65 '/root/lab-boot.sh && sleep 20 && cat /root/lab-boot.log'

# 4. verify in a real browser
ssh root@100.94.39.65 'cd /root/dsh-lab/dsh-tavern-v2 \
  && node tools/browser-verify.mjs --url "$(grep -oE "http://127.0.0.1:3081/\?token=[A-Za-z0-9_-]+" /root/lab-boot.log)" \
     --out /root/lab-shot.png'
```

Two things this costs, both learned the hard way. The activation URL is printed
**only after a successful boot**, so an empty log means the tree failed to load —
read it before concluding anything about the browser. And onboarding on a fresh
profile is a **sequence** of modals (a testing notice, then an API-key prompt),
each behind a pointer-event-intercepting mask; `browser-verify.mjs` clears them
in a loop, because a click that is intercepted is indistinguishable from a dead
control — which is the exact bug class it exists to catch.

---

## 8. Resuming this work

Written for whoever picks this up — including a future session of the same agent,
which after a restart knows none of the above.

### Where it stands

A two-plugin project that **builds, typechecks, tests and mounts** on
`@deepseek-ai/dsh` 0.1.6-alpha.1, with everything verified by the gate that can
actually see it: 168 unit tests, a clean typecheck, an artifact-level client
manifest check, and 19 assertions driven through a real browser against a real
booted instance.

| Piece | State |
| --- | --- |
| Composition and mounting | done; two rows in the tree, plugin tree loads, client bundles discovered and served |
| `dsh-group-chat` — rooms, members | done, with RPC, UI and browser round-trip |
| `dsh-group-chat` — scheduler, frozen rerolls, delivery loop, room runner | built and tested; wired to the service; **cannot speak** (see below) |
| `dsh-tavern` — world info (engine, schemas, bindings, CRUD, editor, tester) | done, with RPC, UI and browser round-trip |
| `dsh-tavern` — the prompt seat | wired; nothing has been observed reaching a real prompt |
| Rules 1–3 (`§2`) | implemented and tested |
| Rules 4–5 | not implemented; §6 explains why 4 is blocked |

### The one blocker

**There is no `SpeakerFactory` backed by real agents, because that needs model
credentials and the lab has none.**

The interface is one function wide:

```ts
type SpeakerFactory = (room: RoomInput, transcript: TranscriptPort, takes: () => readonly Take[]) => Speaker
type Speaker = { produce(request: SpeakRequest, signal: AbortSignal): Promise<{ text: string }> }
```

That is the whole gap. `GroupChatService.installSpeaker()`
takes it; `startGroup` refuses until something calls it. Everything downstream —
scheduler, loop, runner, RPC, UI — is built and tested against a fake.

Two consequences worth stating plainly, because they are easy to mistake for bugs:

- **`startGroup` is *supposed* to refuse right now**, with a message naming the
  speaker. `tools/browser-verify.mjs` asserts that refusal. If it ever succeeds
  without a model, someone has installed a fake and the tests are lying.
- **Rule 4 is blocked behind the same door.** A plugin's `conversation.view` does
  not render for a blank session (`§4`), and a room session becomes non-blank only
  by taking a turn — which needs an agent. The only way around it is a *durable*
  room session, and `ctx.sessions.create` persists nothing outside the agent
  lifecycle. So: agent adapter first, then sessions, then rule 4.

### If you have credentials

1. Put a `SpeakerFactory` in a new module — say
   `packages/group-chat/src/agent-speaker.ts` — implementing `Speaker` over
   `ctx.agents.create(...)` and `agent.followup(...)`, and have `apply` call
   `service.installSpeaker(factory)`.
2. Keep the platform-touching part thin. Every rule worth getting right is
   already on the testable side of the interface.
3. `pnpm run verify`, then deploy to the lab and run `tools/browser-verify.mjs`.
4. Add a browser assertion that a room **speaks**: at least one take appears, and
   its text is not an echo of the request.

### If you do not

The two silent-failure mappings that used to live in platform-coupled modules are
now on the testable side and asserted directly: `bookIdsForTargets` (whether world
info applies at all) and `toRoomInput` (whether members arrive with their
personas). Both failed silently before, which is the worst way to fail.

What is left is genuinely polish, and it does not unlock anything: the binding
picker still falls back to typing a raw target id when no room exists, and there
is no i18n. Further rounds without credentials would produce only that.
