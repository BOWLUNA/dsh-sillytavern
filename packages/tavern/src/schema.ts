/**
 * The tavern's durable shapes, as zod schemas — with no platform import.
 *
 * Split out of `domain.ts` for the same reason `seat.ts` is split out of the
 * service: `defineDomain` is the only part that needs the platform, and a module
 * that imports it cannot be loaded by a test in this workspace, where platform
 * packages are deliberately absent. Schemas are pure data; they belong on the
 * testable side of that line.
 *
 * **The same schemas validate the wire and the stored record.** That is not a
 * convenience. The legacy project kept a hand-written wire validator beside its
 * domain schema, the two drifted repeatedly, and a field one accepted and the
 * other rejected is a poison pill: the platform validates on *load*, so one bad
 * record takes the whole domain down. One schema cannot drift from itself.
 *
 * @module dsh-tavern/schema
 */

import { LIMITS, Owner, reject } from '@dsh-tavern/contracts'
import { z } from 'zod'

// ────────────────────────────────────────────────────────────────────────────
// Bindings
// ────────────────────────────────────────────────────────────────────────────

/**
 * One binding row.
 *
 * Keyed by `owner + target` on the medium — ownership is part of the key, which
 * is what makes the legacy project's clobbering whole-row write unrepresentable
 * rather than merely discouraged. See `bindings.ts`.
 */
export const bindingRecordSchema = z.object({
  owner: z.enum([Owner.Tavern, Owner.GroupChat, Owner.User]),
  targetId: z.string().min(1).max(LIMITS.id),
  bookIds: z.array(z.string().min(1).max(LIMITS.id)).max(LIMITS.bindings),
  updatedAt: z.number().int().nonnegative(),
})

export type BindingRecord = z.infer<typeof bindingRecordSchema>

// ────────────────────────────────────────────────────────────────────────────
// Shared field shapes
// ────────────────────────────────────────────────────────────────────────────

/**
 * A required display name.
 *
 * `min(1)` alone accepts `"   "`, which is a name that looks empty in every UI
 * and behaves like one everywhere except in a length check — the poison-pill
 * shape. Rejected with a `refine` rather than `.trim()` on purpose: trimming
 * would silently rewrite what the user typed, and the project's rule is that a
 * boundary rejects rather than corrects. `LIMITS` and the whitespace rule match
 * the shared `requireName` in the contracts package.
 */
const nameSchema = z
  .string()
  .min(1)
  .max(LIMITS.name)
  .refine((value) => value.trim().length > 0, { message: 'must not be empty or whitespace-only' })

// ────────────────────────────────────────────────────────────────────────────
// Books
// ────────────────────────────────────────────────────────────────────────────

/**
 * One world-info entry.
 *
 * Bounds are per-field and generous. `content` is the largest at 256 KiB — an
 * entry that big is almost certainly a mistake, and refusing it at write time is
 * cheaper than discovering it during a scan.
 *
 * `selectiveLogic` is a four-value union rather than a number so that an
 * out-of-range value is a schema failure instead of a silently-defaulted mode.
 */
const entrySchema = z.object({
  entryId: z.string().min(1).max(LIMITS.id),
  keys: z.array(z.string().max(500)).max(200).default([]),
  secondaryKeys: z.array(z.string().max(500)).max(200).default([]),
  content: z.string().max(256 * 1024).default(''),
  comment: z.string().max(4000).default(''),
  constant: z.boolean().default(false),
  selective: z.boolean().default(false),
  selectiveLogic: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).default(0),
  order: z.number().int().min(-10_000).max(10_000).default(100),
  position: z.enum(['before', 'after']).default('before'),
  probability: z.number().int().min(0).max(100).default(100),
  useProbability: z.boolean().default(false),
  group: z.string().max(200).default(''),
  groupWeight: z.number().int().min(1).max(10_000).default(100),
  groupOverride: z.boolean().default(false),
  disable: z.boolean().default(false),
  ignoreBudget: z.boolean().default(false),
  scanDepth: z.number().int().min(0).max(1000).nullable().default(null),
  caseSensitive: z.boolean().nullable().default(null),
  matchWholeWords: z.boolean().nullable().default(null),
  excludeRecursion: z.boolean().default(false),
  preventRecursion: z.boolean().default(false),
})

const bookSettingsSchema = z.object({
  scanDepth: z.number().int().min(0).max(1000).default(2),
  budgetPercent: z.number().int().min(0).max(100).default(25),
  budgetCap: z.number().int().min(0).default(0),
  caseSensitive: z.boolean().default(false),
  matchWholeWords: z.boolean().default(false),
  recursive: z.boolean().default(false),
  maxRecursionSteps: z.number().int().min(0).max(100).default(0),
  allowRegex: z.boolean().default(true),
})

export const bookRecordSchema = z.object({
  bookId: z.string().min(1).max(LIMITS.id),
  /** Same ownership rule as bindings: the tavern owns books, the user edits them. */
  owner: z.literal(Owner.Tavern),
  name: z.string().min(1).max(LIMITS.name),
  enabled: z.boolean().default(true),
  entries: z.array(entrySchema).max(4096).default([]),
  settings: bookSettingsSchema,
  /**
   * Bumped on every write. `updateBook` may pin `baseRevision` and is refused
   * when it does not match — a plain refusal rather than a merge, because a
   * merge of two edits to the same entry is not something a user can predict.
   */
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.number().int().nonnegative(),
})

/** What a caller may supply when creating a book. Identity and timestamps are ours. */
const bookCreateSchema = z.object({
  name: nameSchema,
  enabled: z.boolean().default(true),
  entries: z.array(entrySchema).max(4096).default([]),
  settings: bookSettingsSchema.optional(),
})

/** A patch: every field optional, and at least the shape is checked. */
const bookPatchSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  entries: z.array(entrySchema).max(4096).optional(),
  settings: bookSettingsSchema.optional(),
  baseRevision: z.number().int().nonnegative().optional(),
})

/**
 * Validate one value against one of the schemas above, as a `RejectError`.
 *
 * The same schemas guard the wire **and** the durable record. That is not a
 * convenience: the legacy project kept a hand-written wire validator beside the
 * domain schema, and the two drifted repeatedly — a field one accepted and the
 * other rejected is a poison pill, because the platform validates on *load* and
 * a bad record takes the whole domain down. One schema cannot drift from itself.
 */
function parseOrReject<T>(schema: z.ZodType<T>, field: string, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') ?? ''
  reject(path === '' ? field : `${field}.${path}`, issue?.message ?? 'is not valid')
}

/**
 * A fully-defaulted settings object.
 *
 * `bookSettingsSchema.default({})` reads naturally and does not typecheck —
 * zod's `.default()` wants a value of the *output* type, and `{}` is only valid
 * as input because every field has its own default. Parsing an empty object is
 * the honest way to say "the defaults".
 */
export const defaultBookSettings = (): BookSettingsRecord => bookSettingsSchema.parse({})

export const parseBookCreate = (value: unknown): BookCreate => {
  const input = parseOrReject(bookCreateSchema, 'book', value)
  return { ...input, settings: input.settings ?? defaultBookSettings() }
}

export const parseBookPatch = (value: unknown): z.infer<typeof bookPatchSchema> =>
  parseOrReject(bookPatchSchema, 'patch', value)

/** One entry, with defaults filled. */
export const parseEntry = (value: unknown): EntryRecord => parseOrReject(entrySchema, 'entry', value)

/** A tester request. */
const scanRequestSchema = z.object({
  bookIds: z.array(z.string().min(1).max(LIMITS.id)).max(100).default([]),
  messages: z.array(z.string().max(200_000)).max(200).default([]),
  contextTokens: z.number().int().min(1).max(10_000_000).default(64_000),
})

export type ScanRequest = z.infer<typeof scanRequestSchema>

export const parseScanRequest = (value: unknown): ScanRequest =>
  parseOrReject(scanRequestSchema, 'scan', value)

type BookCreateInput = z.infer<typeof bookCreateSchema>

/**
 * A create request with everything filled in.
 *
 * `settings` is required here even though the input may omit it: a caller should
 * never have to know which fields have defaults, and the service should never
 * have to remember to apply them.
 */
export type BookCreate = Omit<BookCreateInput, 'settings'> & { readonly settings: BookSettingsRecord }
export type BookPatch = z.infer<typeof bookPatchSchema>
export type EntryRecord = z.infer<typeof entrySchema>
export type BookSettingsRecord = z.infer<typeof bookSettingsSchema>
export type BookRecord = z.infer<typeof bookRecordSchema>

