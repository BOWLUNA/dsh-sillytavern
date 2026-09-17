/**
 * dsh-tavern host half.
 *
 * The tavern is the aggregate project: it owns the tavern experience (books,
 * cards, the tavern page) and it bundles `dsh-group-chat` so one install gives
 * the whole thing. The dependency runs one way only — the tavern knows about
 * group chat, group chat never knows about the tavern. What crosses the line is
 * the context-seat seam declared in `@dsh-tavern/contracts`, and nothing else.
 *
 * What is implemented at this stage: the durable binding table, with ownership
 * enforced structurally. That is deliberate — it is the part that corrupted
 * data twice in the legacy project, so it is the part worth getting right
 * before any book content exists.
 *
 * What is *not* implemented, and is not pretended to be: the books themselves,
 * the world-info engine, and `ContextSeatSeam.mount` — nothing injects into a
 * prompt yet. The service therefore exposes the binding operations and leaves
 * `mount` off its surface rather than shipping a no-op that would silently do
 * nothing while looking like it worked.
 *
 * @module dsh-tavern
 */

import { randomUUID } from 'node:crypto'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { Owner, SERVICE, isId, reject, requireTypertRegistry, sanitizePromptText } from '@dsh-tavern/contracts'
import type { BookRef, LorebookEntry, LorebookSettings, SeatMountRequest } from '@dsh-tavern/contracts'
import { seatScan, seatText } from './seat.ts'
import { LOREBOOK_ORDER, NAMESPACE, TAVERN_REMOTES } from './remote.ts'
import { parseBookCreate, parseBookPatch, parseScanRequest } from './schema.ts'
import type { BookRecord } from './schema.ts'
import {
  addBook,
  bookIdsForTargets,
  bindingKey,
  dropOwnerRows,
  removeBook,
  resolveBooks,
  setBooks,
} from './bindings.ts'
import type { BindingRow } from './bindings.ts'
import { TAVERN_SEAT_DOMAIN } from './domain.ts'
import type { BindingRecord } from './schema.ts'

/**
 * Stable Cordis plugin name, shared with the browser half and matching this
 * package's row id in `cordis.patch.yml`.
 */
export const name = 'tavern'

/**
 * Services this plugin cannot mount without.
 *
 * `systemPrompt` is here because the seat registers a prompt context; `typert`
 * because it registers invocations. Declared at module scope, where the loader
 * reads it — the service is constructed directly by `apply`, so a class-level
 * declaration would be ignored.
 */
export const inject = ['typert', 'storageDomain', 'systemPrompt']

export interface Config {
  /** Reserved. The tavern has no tunables until the book engine lands. */
  readonly _reserved?: never
}

export const Config: z<Config> = z.object({})

/** The slice of the platform's `storageDomain` service this plugin uses. */
interface StorageDomainFacility {
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
}

function requireStorageDomain(ctx: Context): StorageDomainFacility {
  const facility = ctx.get('storageDomain') as unknown
  if (
    facility === undefined
    || facility === null
    || typeof (facility as StorageDomainFacility).open !== 'function'
  ) {
    throw new Error(
      `${name}: the platform exposes no usable \`storageDomain\` service. `
      + 'This plugin targets @deepseek-ai/dsh 0.1.6-alpha.1, where the service declares `open(spec)`. '
      + `Got: ${facility === undefined ? 'service absent' : typeof facility}.`,
    )
  }
  return facility as StorageDomainFacility
}

/**
 * The context-seat service, published as `ctx.tavernContextSeat`.
 *
 * Rows are held in memory and mirrored to one durable record per row. Every
 * mutation goes through the pure functions in `bindings.ts`, so the ownership
 * invariant holds identically whether it is exercised by a test or by the
 * running process.
 */
export class TavernSeatService extends TypertRemoteService {
  private readonly facility: StorageDomainFacility
  private domain: Domain<typeof TAVERN_SEAT_DOMAIN> | null = null
  private openFailure: unknown = null
  private cached: readonly BindingRow[] = []

  constructor(ctx: Context, facility: StorageDomainFacility) {
    // The namespace must be stated: `TypertRemoteService` defaults it to the
    // service key, and the descriptors below use `tavern`. Left implicit, the
    // binding and the descriptors disagree and the gateway refuses every call
    // with "inconsistent typertRemote binding".
    super(ctx, SERVICE.ContextSeat, { namespace: NAMESPACE })
    requireTypertRegistry(ctx, name).register({
      package: 'dsh-tavern',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [...TAVERN_REMOTES],
    })
    this.facility = facility
  }

  /** Begin opening the durable table and hydrating the in-memory rows. */
  start(): void {
    void this.facility.open(TAVERN_SEAT_DOMAIN).then(
      (domain) => {
        this.domain = domain
        this.cached = [...this.table(domain).entries()].map(([key, record]) => toRow(key, record))
      },
      (error: unknown) => {
        this.openFailure = error
        console.error(`[${name}] the tavern_seat storage domain did not open — bindings are unavailable this boot.`, error)
      },
    )
  }

  /** Release the domain. Idempotent. */
  async close(): Promise<void> {
    const domain = this.domain
    this.domain = null
    if (domain !== null) await domain.close()
  }

  private table(domain: Domain<typeof TAVERN_SEAT_DOMAIN>): KvTable<string, BindingRecord> {
    return domain.table('bindings')
  }

  private requireTable(): { domain: Domain<typeof TAVERN_SEAT_DOMAIN>; table: KvTable<string, BindingRecord> } {
    const domain = this.domain
    if (domain === null) {
      throw new Error(
        `${name}: the binding table is not open. `
        + (this.openFailure === undefined
          ? 'It is still opening.'
          : 'It failed to open — see the earlier error for the cause.'),
      )
    }
    return { domain, table: this.table(domain) }
  }

  /** Commit a computed row set: write changed rows, delete vanished ones. */
  private async commit(next: readonly BindingRow[]): Promise<void> {
    const { table } = this.requireTable()
    const before = new Map(this.cached.map((row) => [bindingKey(row.owner, row.targetId), row]))
    const after = new Map(next.map((row) => [bindingKey(row.owner, row.targetId), row]))

    for (const [key, row] of after) {
      const previous = before.get(key)
      const unchanged = previous !== undefined
        && previous.updatedAt === row.updatedAt
        && previous.bookIds.length === row.bookIds.length
        && previous.bookIds.every((id, index) => id === row.bookIds[index])
      if (unchanged) continue
      await table.put(key, {
        owner: row.owner,
        targetId: row.targetId,
        bookIds: [...row.bookIds],
        updatedAt: row.updatedAt,
      })
    }

    for (const key of before.keys()) {
      if (!after.has(key)) await table.delete(key)
    }

    this.cached = next
  }

  // ── public surface ──────────────────────────────────────────────────────

  /** Liveness probe; the composition smoke test calls it. */
  ping(): string {
    return 'pong'
  }

  /** Whether the durable binding table is open. */
  get ready(): boolean {
    return this.domain !== null
  }

  /** Why the table is unavailable, if it is. */
  openError(): unknown {
    return this.openFailure
  }

  /** A snapshot of every row. */
  rows(): readonly BindingRow[] {
    return this.cached
  }

  /** Every binding row, flattened for the wire. Contains no `undefined`. */
  listBindings(): BindingView[] {
    return this.cached.map((row) => ({
      owner: row.owner,
      targetId: row.targetId,
      bookIds: [...row.bookIds],
      updatedAt: row.updatedAt,
    }))
  }

  /** Every book attached to a target, unioned across owners. */
  booksFor(targetId: string): readonly string[] {
    return resolveBooks(this.cached, targetId)
  }

  /**
   * Attach a book on behalf of the group-chat lifecycle.
   *
   * The owner is fixed here, not passed in: the caller cannot accidentally
   * write into the human's row, and a future caller cannot get it wrong either.
   */
  async addBinding(targetId: string, bookId: string): Promise<void> {
    await this.commit(addBook(this.cached, Owner.GroupChat, targetId, bookId, Date.now()))
  }

  /** Detach a book on behalf of the group-chat lifecycle. Idempotent. */
  async removeBinding(targetId: string, bookId: string): Promise<void> {
    await this.commit(removeBook(this.cached, Owner.GroupChat, targetId, bookId))
  }

  /** Drop the lifecycle's rows for a target that no longer exists. */
  async releaseTarget(targetId: string): Promise<void> {
    await this.commit(dropOwnerRows(this.cached, Owner.GroupChat, targetId))
  }

  /** Replace the human's row for a target. */
  async setUserBinding(targetId: string, bookIds: readonly string[]): Promise<void> {
    await this.commit(setBooks(this.cached, Owner.User, targetId, bookIds, Date.now()))
  }

  /** Replace the tavern's own row for a target. */
  async setTavernBinding(targetId: string, bookIds: readonly string[]): Promise<void> {
    await this.commit(setBooks(this.cached, Owner.Tavern, targetId, bookIds, Date.now()))
  }

  // ── books ───────────────────────────────────────────────────────────────

  /** The durable book table, or a message saying why it is unavailable. */
  private requireBooks(): KvTable<string, BookRecord> {
    const domain = this.domain
    if (domain === null) {
      throw new Error(
        `${name}: the book table is not open. `
        + (this.openFailure === null ? 'It is still opening.' : 'It failed to open — see the earlier error.'),
      )
    }
    return domain.table('books')
  }

  /** Every book, oldest first. */
  listBooks(): BookSummary[] {
    const domain = this.domain
    if (domain === null) return []
    return [...domain.table('books').entries()]
      .map(([, record]) => toBookSummary(record))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** One book, or `null`. */
  getBook(bookId: unknown): BookSummary | null {
    const id = requireBookId(bookId)
    const record = this.requireBooks().get(id)
    return record === undefined ? null : toBookSummary(record)
  }

  /**
   * The full record, entries included.
   *
   * `getBook` returns a summary for lists; editing needs the entries and the
   * revision that `updateBook` will check, so it gets its own read rather than
   * making every list call pay for content the list does not show.
   */
  readBook(bookId: unknown): BookDetail | null {
    const id = requireBookId(bookId)
    const record = this.requireBooks().get(id)
    if (record === undefined) return null
    return {
      bookId: record.bookId,
      name: record.name,
      enabled: record.enabled,
      revision: record.revision,
      createdAt: record.createdAt,
      settings: { ...record.settings },
      // Returned whole. Every field the editor can change is here, and so is
      // every field it cannot — which is what makes a save preserve what the UI
      // does not show, without the editor needing a list of fields to remember.
      entries: record.entries.map((entry) => ({ ...entry, keys: [...entry.keys], secondaryKeys: [...entry.secondaryKeys] })),
    }
  }

  /** Create a book. */
  async createBook(config: unknown): Promise<BookSummary> {
    const input = parseBookCreate(config)
    const table = this.requireBooks()
    const bookId = `book-${randomUUID()}`
    const record: BookRecord = {
      bookId,
      owner: Owner.Tavern,
      name: input.name,
      enabled: input.enabled,
      entries: input.entries,
      settings: input.settings,
      revision: 0,
      createdAt: Date.now(),
    }
    await table.put(bookId, record)
    return toBookSummary(record)
  }

  /**
   * Update a book.
   *
   * `baseRevision` is optional and, when supplied, must match — a plain refusal
   * rather than a merge. Merging two edits to one entry produces a book neither
   * author wrote, and there is no UI that could explain the result.
   */
  async updateBook(bookId: unknown, patch: unknown): Promise<BookSummary> {
    const id = requireBookId(bookId)
    const input = parseBookPatch(patch)
    const table = this.requireBooks()
    let updated: BookRecord | undefined

    await table.update(id, (current) => {
      if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
        reject(
          'baseRevision',
          `this book has moved on: expected revision ${input.baseRevision}, found ${current.revision}`,
        )
      }
      const next: BookRecord = {
        ...current,
        name: input.name ?? current.name,
        enabled: input.enabled ?? current.enabled,
        entries: input.entries ?? current.entries,
        settings: input.settings ?? current.settings,
        revision: current.revision + 1,
      }
      updated = next
      return next
    })

    if (updated === undefined) throw new Error(`${name}: updateBook completed without a record`)
    return toBookSummary(updated)
  }

  /** Delete a book, and every binding that pointed at it. */
  async deleteBook(bookId: unknown): Promise<boolean> {
    const id = requireBookId(bookId)
    const removed = await this.requireBooks().delete(id)
    if (!removed) return false

    // Leaving dangling bindings would make a later book with a recycled id
    // silently inherit them. Legacy's engine had exactly that class of bug.
    const bindings = this.rows().filter((row) => row.bookIds.includes(id))
    if (bindings.length > 0) {
      await this.commit(this.rows().map((row) => (
        row.bookIds.includes(id) ? { ...row, bookIds: row.bookIds.filter((candidate) => candidate !== id) } : row
      )))
    }
    return true
  }

  /**
   * Run the engine over chosen books and sample messages, and return the trace.
   *
   * No prompt, no agent, no session — which is the point. An author's question
   * is almost never "what did it produce" but "why did *this entry* not fire",
   * and answering it should not require starting a room.
   *
   * The text returned here is the **unsanitised** scan output, so the tester
   * shows what the book actually says rather than what survives the prompt
   * rules. The real path sanitises; see `seatText`.
   */
  previewScan(bookIds: unknown, messages: unknown, contextTokens: unknown): ScanPreview {
    const request = parseScanRequest({
      bookIds: bookIds ?? [],
      messages: messages ?? [],
      ...(contextTokens === undefined || contextTokens === null ? {} : { contextTokens }),
    })

    const all = this.allBooks()
    const chosen = request.bookIds.length === 0
      ? all
      : all.filter((book) => request.bookIds.includes(book.bookId))

    const result = seatScan(
      {
        books: chosen,
        // Testing a book means testing it, whether or not it is bound yet —
        // otherwise the tester would silently test nothing on a fresh book.
        boundBookIds: chosen.map((book) => book.bookId),
        macros: {},
        contextTokens: request.contextTokens,
        random: Math.random,
      },
      request.messages,
    )

    if (result === null) {
      return {
        text: '',
        activated: [],
        trace: [],
        budgetBytes: 0,
        activatedBytes: 0,
        budgetExcluded: 0,
        outputLimited: false,
        rounds: 0,
      }
    }

    return {
      text: result.text,
      activated: result.activated.map((entry) => ({
        bookId: entry.bookId,
        entryId: entry.entryId,
        content: entry.content,
        order: entry.order,
        round: entry.round,
      })),
      trace: result.trace.map((record) => ({
        bookId: record.bookId,
        entryId: record.entryId,
        reason: record.reason,
        round: record.round,
        matchedKeys: [...record.matchedKeys],
        matchedSecondaryKeys: [...record.matchedSecondaryKeys],
      })),
      budgetBytes: result.budgetBytes,
      activatedBytes: result.activatedBytes,
      budgetExcluded: result.budgetExcluded,
      outputLimited: result.outputLimited,
      rounds: result.rounds,
    }
  }

  // ── the seam ────────────────────────────────────────────────────────────

  /**
   * Attach a target's bound books to one agent's prompt assembly.
   *
   * The provider is evaluated on **every** assembly, which is what makes world
   * info follow the conversation instead of freezing at mount time. What it is
   * not given is the conversation itself — the platform's `AssembleContext`
   * carries only `{ scope, signal }` — so the messages come from the caller, who
   * owns the transcript.
   */
  mount(request: SeatMountRequest): () => void {
    const targets = [...request.targetIds]
    const macros = request.macros ?? {}
    const contextTokens = request.contextTokens ?? DEFAULT_CONTEXT_TOKENS
    const random = request.random ?? Math.random

    return request.host.systemPrompt.context({
      // Unique per target set: the platform refuses a duplicate context name.
      name: `${SEAT_NAME}:${targets.join('+')}`,
      order: LOREBOOK_ORDER,
      text: () => seatText(
        {
          books: this.allBooks(),
          boundBookIds: bookIdsForTargets(this.rows(), targets),
          macros,
          contextTokens,
          random,
        },
        request.messages(),
      ),
    })
  }

  /** Every stored book. */
  private allBooks(): BookRecord[] {
    const domain = this.domain
    if (domain === null) return []
    return [...domain.table('books').entries()].map(([, record]) => record)
  }

}

/** Stable name for the seat's prompt context. */
export const SEAT_NAME = 'tavern-lorebook'

/** Budget denominator when the caller does not supply one. */
export const DEFAULT_CONTEXT_TOKENS = 64_000

function requireBookId(value: unknown): string {
  if (!isId(value)) reject('bookId', `must be a well-formed book id, got ${typeof value}`)
  return value
}

/**
 * The tester's result.
 *
 * Every field is required and spelled out: the gateway rejects a payload
 * containing `undefined`, so an optional field here would be a hole in the
 * response rather than a missing key.
 */
export interface ScanPreview {
  readonly text: string
  readonly activated: readonly {
    readonly bookId: string
    readonly entryId: string
    readonly content: string
    readonly order: number
    readonly round: number
  }[]
  readonly trace: readonly {
    readonly bookId: string
    readonly entryId: string
    readonly reason: string
    readonly round: number
    readonly matchedKeys: readonly string[]
    readonly matchedSecondaryKeys: readonly string[]
  }[]
  readonly budgetBytes: number
  readonly activatedBytes: number
  readonly budgetExcluded: number
  readonly outputLimited: boolean
  readonly rounds: number
}

export interface BindingView {
  readonly owner: string
  readonly targetId: string
  readonly bookIds: readonly string[]
  readonly updatedAt: number
}

/**
 * A book with its entries, for the editor.
 *
 * Only the fields the editor exposes are sent. The rest of an entry — secondary
 * keys, groups, probability, scan depth — lives in the record and the engine, and
 * is preserved by a save because the save writes back entries the editor read
 * from here plus the fields it changed. Sending fewer fields is not a shortcut
 * around validation: `updateBook` parses the whole entry against the same schema
 * the record uses.
 */
export interface BookDetail {
  readonly bookId: string
  readonly name: string
  readonly enabled: boolean
  readonly revision: number
  readonly createdAt: number
  readonly settings: LorebookSettings
  readonly entries: readonly LorebookEntry[]
}

export interface BookSummary {
  readonly bookId: string
  readonly name: string
  readonly enabled: boolean
  readonly entryCount: number
  readonly revision: number
  readonly createdAt: number
}

function toBookSummary(record: BookRecord): BookSummary {
  return {
    bookId: record.bookId,
    name: record.name,
    enabled: record.enabled,
    entryCount: record.entries.length,
    revision: record.revision,
    createdAt: record.createdAt,
  }
}

/** Rebuild a row from its durable record whose key was `owner\u0000target`. */
function toRow(key: string, record: BindingRecord): BindingRow {
  return {
    owner: record.owner,
    targetId: record.targetId,
    bookIds: record.bookIds,
    updatedAt: record.updatedAt,
  }
}

/** Cordis entry: mount the service into the plugin tree. */
export function apply(ctx: Context): void {
  const facility = requireStorageDomain(ctx)
  const service = new TavernSeatService(ctx, facility)

  ctx.effect(() => {
    service.start()
    return () => {
      void service.close()
    }
  })
}
