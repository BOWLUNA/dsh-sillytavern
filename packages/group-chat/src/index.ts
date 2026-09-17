/**
 * dsh-group-chat host half: rooms, membership, and the durable room table.
 *
 * This is the standalone project. It depends on the platform and on nothing
 * tavern-specific — the tavern package bundles it and fills its context-seat
 * seam, but it runs fine alone.
 *
 * Two platform facts shape the code below, both learned the expensive way in
 * the legacy project:
 *
 *   1. `typert` validates nothing, and the storage layer runs zod only when a
 *      domain is *loaded*, never when a record is written. Validation therefore
 *      has to live on our side of the boundary. `wire.ts` is that boundary and
 *      it is the only one.
 *
 *   2. A required service is resolved by declaration, not by reading. The
 *      `inject` list on the service class is what makes the read legal; the
 *      sibling-context isolation means a service cannot simply be reached as a
 *      property.
 *
 * @module dsh-group-chat
 */

import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec, KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from '@deepseek-ai/schemastery'
import { Owner, SERVICE, reject } from '@dsh-tavern/contracts'
import type { MemberSummary, RoomSummary } from '@dsh-tavern/contracts'
import { GROUP_CHAT_DOMAIN } from './domain.ts'
import { randomUUID } from 'node:crypto'
import type { MemberRecord, RoomRecord } from './domain.ts'
import { requireTypertRegistry } from '@dsh-tavern/contracts'
import { GROUP_CHAT_REMOTES } from './remote.ts'
import { RoomRunner, toRoomInput } from './rooms.ts'
import type { RoomInput, RoomView, SpeakerFactory } from './rooms.ts'
import { LIMITS, requireId, sanitizeMemberCreate, sanitizeRoomCreate } from './wire.ts'

/**
 * Stable Cordis plugin name. The browser half exports the same one, and it
 * matches the `id` of this package's row in `cordis.patch.yml`. (The browser
 * *bundle* is keyed by package name instead — that id is written by the build
 * tool, not declared here.)
 */
export const name = 'group-chat'

/**
 * Services this plugin cannot mount without.
 *
 * Declared at module scope because that is where the loader reads it. The legacy
 * project put the equivalent on the service class instead, which only works when
 * the class is mounted *through Cordis*; `apply` here constructs the service
 * directly, so a class-level declaration would have been silently ignored and
 * `ctx.typert` could have been read before it existed.
 */
export const inject = ['typert', 'storageDomain']

export interface Config {
  /** Maximum pending speech deliveries before the queue rejects loudly. */
  maxQueue?: number
}

export const Config: z<Config> = z.object({
  maxQueue: z.natural().max(LIMITS.queue).default(LIMITS.queue),
})

/** The slice of the platform's `storageDomain` service this plugin uses. */
interface StorageDomainFacility {
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
}

/**
 * Resolve `storageDomain`, or say precisely what is wrong.
 *
 * A missing platform API here means a dsh version we have not been checked
 * against. The failure is announced once, at mount, naming the API and the
 * version we target — rather than surfacing later as an unexplained 500 on
 * every request that touches a room. The legacy project shipped without this
 * guard and paid for it in diagnosis time.
 */
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
 * Host-plane group-chat service, published as `ctx.groupChat`.
 *
 * The durable room table is opened asynchronously; until it is open the room
 * methods report unavailability instead of throwing from a half-built service.
 */
export class GroupChatService extends TypertRemoteService {
  private readonly maxQueue: number
  private readonly facility: StorageDomainFacility
  private domain: Domain<typeof GROUP_CHAT_DOMAIN> | null = null
  /**
   * The speaking machinery, built lazily on first start.
   *
   * It needs a `Speaker`, and a `Speaker` needs a model. Until an adapter
   * installs one, `startGroup` refuses with a message saying exactly that —
   * rather than starting a room that silently never speaks, which is the facade
   * this project keeps refusing to build.
   */
  private runner: RoomRunner | null = null
  private speakerFactory: SpeakerFactory | null = null
  private openFailure: unknown = null

  constructor(ctx: Context, config: Config, facility: StorageDomainFacility) {
    super(ctx, SERVICE.GroupChat)
    // The gateway resolves `/api/groupChat/<method>` from these descriptors.
    // There is no code generation for an out-of-tree package, so they are
    // stated here — and `tests/remote.test.ts` holds them to the class.
    requireTypertRegistry(ctx, name).register({
      package: 'dsh-group-chat',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: [...GROUP_CHAT_REMOTES],
    })
    this.maxQueue = config.maxQueue ?? LIMITS.queue
    this.facility = facility
  }

  /** Begin opening the durable room table. Never throws; failures are recorded. */
  start(): void {
    void this.facility.open(GROUP_CHAT_DOMAIN).then(
      (domain) => {
        this.domain = domain
      },
      (error: unknown) => {
        this.openFailure = error
        console.error(
          `[${name}] the group_chat storage domain did not open — rooms are unavailable this boot. `
          + 'A domain that refuses to open usually means one stored record failed its schema; '
          + 'the platform rejects the whole domain rather than the single record.',
          error,
        )
      },
    )
  }

  /** Release the domain. Idempotent. */
  async close(): Promise<void> {
    const domain = this.domain
    this.domain = null
    if (domain !== null) await domain.close()
  }

  // ── public surface ──────────────────────────────────────────────────────

  /** Liveness probe; the composition smoke test calls it. */
  ping(): string {
    return 'pong'
  }

  /** Configured queue depth. */
  queueLimit(): number {
    return this.maxQueue
  }

  /** Whether the durable room table is open. */
  get ready(): boolean {
    return this.domain !== null
  }

  /** Why the room table is unavailable, if it is. */
  openError(): unknown {
    return this.openFailure
  }

  /** The durable room table, or `null` while the domain is not open. */
  rooms(): KvTable<string, RoomRecord> | null {
    return this.domain?.table('rooms') ?? null
  }

  /** Number of persisted rooms. `0` while the domain is not open. */
  roomCount(): number {
    return this.rooms()?.size ?? 0
  }

  // ── rooms, over the wire ────────────────────────────────────────────────

  /** The room table, or a message saying why it is unavailable. */
  private requireRooms(): KvTable<string, RoomRecord> {
    const table = this.rooms()
    if (table === null) {
      throw new Error(
        `${name}: the room table is not open. `
        + (this.openFailure === null ? 'It is still opening.' : 'It failed to open — see the earlier error.'),
      )
    }
    return table
  }

  /** Every room, oldest first. Contains no `undefined`: the gateway rejects it. */
  listRooms(): RoomSummary[] {
    const table = this.rooms()
    if (table === null) return []
    return [...table.entries()]
      .map(([, record]) => toSummary(record))
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** One room, or `null`. */
  getRoom(roomId: unknown): RoomSummary | null {
    const id = requireId('roomId', roomId)
    const record = this.rooms()?.get(id)
    return record === undefined ? null : toSummary(record)
  }

  /**
   * Create a room.
   *
   * The parameter is `unknown` deliberately: this *is* the boundary, and
   * `wire.ts` is the only thing permitted to decide what a valid request is. A
   * typed parameter here would be a lie, because the value arrives as JSON.
   */
  async createRoom(config: unknown): Promise<RoomSummary> {
    const input = sanitizeRoomCreate(config)
    const table = this.requireRooms()
    const roomId = `room-${randomUUID()}`
    const record: RoomRecord = {
      roomId,
      owner: Owner.GroupChat,
      name: input.name,
      mode: input.mode,
      status: 'stopped',
      // No session until the room starts; see the note on the schema.
      sessionId: null,
      sessionIds: [],
      memberIds: input.memberIds === undefined ? [] : [...input.memberIds],
      members: [],
      maxRounds: input.maxRounds ?? 0,
      scenario: input.scenario ?? '',
      userPersona: input.userPersona ?? '',
      createdAt: Date.now(),
    }
    await table.put(roomId, record)
    return toSummary(record)
  }

  /** Delete a room. Resolves `true` when it existed. */
  async deleteRoom(roomId: unknown): Promise<boolean> {
    const id = requireId('roomId', roomId)
    return this.requireRooms().delete(id)
  }

  /**
   * Install the factory that builds a speaker per room.
   *
   * The single seam between this plugin and a model. Until it is called,
   * `startGroup` refuses; nothing pretends to speak.
   */
  installSpeaker(factory: SpeakerFactory): void {
    this.speakerFactory = factory
  }

  // ── running a room ──────────────────────────────────────────────────────

  private requireRunner(): RoomRunner {
    if (this.speakerFactory === null) {
      throw new Error(
        `${name}: no speaker is installed, so a room cannot be started. `
        + 'The speaking loop needs a model: install one with `installSpeaker(factory)`. '
        + 'Refusing outright is deliberate — a room that "starts" and never speaks is '
        + 'indistinguishable from a broken one.',
      )
    }
    if (this.runner === null) {
      this.runner = new RoomRunner({
        speakerFor: this.speakerFactory,
        nextId: () => randomUUID(),
        onTake: (roomId, take) => {
          console.log(`[${name}] room ${roomId}: ${take.memberId} take ${take.takeId} (turn ${take.turnId})`)
        },
        onFailure: (roomId, error) => {
          console.error(`[${name}] room ${roomId}: a delivery failed`, error)
        },
      })
    }
    return this.runner
  }

  /** Bring a room up and let it talk. Refuses when no speaker is installed. */
  startGroup(roomId: unknown): RoomView {
    const record = this.requireRoom(requireId('roomId', roomId))
    const runner = this.requireRunner()
    return runner.start(toRoomInput(record))
  }

  /** Stop a room and wait for its in-flight delivery to observe it. */
  async stopGroup(roomId: unknown): Promise<void> {
    const id = requireId('roomId', roomId)
    if (this.runner === null) return
    await this.runner.stop(id)
  }

  pauseGroup(roomId: unknown): RoomView {
    return this.requireRunner().pause(requireId('roomId', roomId))
  }

  resumeGroup(roomId: unknown): RoomView {
    return this.requireRunner().resume(requireId('roomId', roomId))
  }

  /** Free mode: point at a member. */
  pickSpeaker(roomId: unknown, memberId: unknown): RoomView {
    return this.requireRunner().pick(requireId('roomId', roomId), memberId)
  }

  /** Reroll one member's take from one turn. The relay is resolved, not supplied. */
  rerollTake(roomId: unknown, memberId: unknown, turnId: unknown): string {
    const intent = this.requireRunner().reroll(requireId('roomId', roomId), memberId, turnId)
    // The id, not the object: an intent carries no state a caller can use, and a
    // wire payload of the whole thing invites someone to build one by hand.
    return intent.intentId
  }

  /** One room's live state, or `null` when it is not running. */
  getRoomState(roomId: unknown): RoomView | null {
    const id = requireId('roomId', roomId)
    return this.runner?.view(id) ?? null
  }

  // ── members ─────────────────────────────────────────────────────────────

  /** Members of a room, in the room's order. */
  listMembers(roomId: unknown): MemberSummary[] {
    return this.requireRoom(requireId('roomId', roomId)).members.map(toMemberSummary)
  }

  /**
   * Add a member.
   *
   * The write goes through the domain's `update`, which is an atomic
   * read-modify-write on the write chain — so two concurrent adds cannot lose
   * one another the way a read-then-put pair would.
   */
  async addMember(roomId: unknown, config: unknown): Promise<MemberSummary> {
    const id = requireId('roomId', roomId)
    const input = sanitizeMemberCreate(config)
    const table = this.requireRooms()
    let created: MemberRecord | undefined

    await table.update(id, (current) => {
      if (current.members.length >= LIMITS.members) {
        reject('members', `a room holds at most ${LIMITS.members} members`)
      }
      const member: MemberRecord = {
        memberId: `member-${randomUUID()}`,
        name: input.name,
        emoji: input.emoji,
        description: input.description ?? '',
        personality: input.personality ?? '',
        scenario: input.scenario ?? '',
        greeting: input.greeting ?? '',
        cardFingerprint: null,
        bookId: null,
      }
      created = member
      return {
        ...current,
        members: [...current.members, member],
        memberIds: [...current.memberIds, member.memberId],
      }
    })

    if (created === undefined) {
      throw new Error(`${name}: addMember completed without producing a member record`)
    }
    return toMemberSummary(created)
  }

  /** Remove a member. Resolves `true` when the member existed. */
  async removeMember(roomId: unknown, memberId: unknown): Promise<boolean> {
    const id = requireId('roomId', roomId)
    const target = requireId('memberId', memberId)
    const table = this.requireRooms()
    let removed = false

    await table.update(id, (current) => {
      if (!current.members.some((member) => member.memberId === target)) return current
      removed = true
      return {
        ...current,
        members: current.members.filter((member) => member.memberId !== target),
        memberIds: current.memberIds.filter((candidate) => candidate !== target),
      }
    })

    return removed
  }

  /** One room, loudly absent rather than silently empty. */
  private requireRoom(roomId: string): RoomRecord {
    const record = this.requireRooms().get(roomId)
    if (record === undefined) reject('roomId', `no room ${JSON.stringify(roomId)}`)
    return record
  }
}

function toSummary(record: RoomRecord): RoomSummary {
  return {
    roomId: record.roomId,
    name: record.name,
    mode: record.mode,
    status: record.status,
    memberCount: record.members.length,
    maxRounds: record.maxRounds,
    hasSession: record.sessionId !== null,
    createdAt: record.createdAt,
  }
}

function toMemberSummary(record: MemberRecord): MemberSummary {
  return {
    memberId: record.memberId,
    name: record.name,
    emoji: record.emoji,
    description: record.description,
    personality: record.personality,
    scenario: record.scenario,
    greeting: record.greeting,
  }
}

export type { RoomView }

export type { MemberSummary, RoomSummary }

/** Cordis entry: mount the service into the plugin tree. */
export function apply(ctx: Context, config: Config): void {
  const facility = requireStorageDomain(ctx)
  const service = new GroupChatService(ctx, config, facility)

  ctx.effect(() => {
    service.start()
    return () => {
      void service.close()
    }
  })
}
