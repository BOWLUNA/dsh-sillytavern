/**
 * The agent adapter: the one piece of this plugin that needs a model.
 *
 * It is expressed against a `MemberRuntime` port, and that is not indirection
 * for its own sake. Two reasons:
 *
 *   1. **The parts that broke in the legacy project are testable here.**
 *      Generation boundaries, a reused agent across deliveries, disposal order,
 *      abort during a delivery, a spawn that fails — none of those are about
 *      model output, and all of them shipped as bugs once.
 *   2. **What cannot be tested is named.** A `MemberRuntime` backed by real
 *      agents can only be exercised with credentials, so it is one small
 *      implementation at the edge. Everything above it is verified without a
 *      model, and the boundary of the unverified part is a single interface.
 *
 * ## Prompt safety is enforced on this side of the port
 *
 * The text handed to the runtime is produced by `sanitizePromptText`, so it
 * carries no `{{` — see `prompt.ts` for why that is the whole guarantee. The
 * runtime is therefore free to place it into prompt sections without further
 * thought, and the tests assert the property at the port: a hostile persona
 * cannot reach a real runtime unfiltered.
 *
 * @module dsh-group-chat/speaker
 */

import { reject } from '@dsh-tavern/contracts'
import type { SpeakRequest, Speaker } from './conductor.ts'
import { briefing, persona, relayLine, sanitizePromptText } from './prompt.ts'

/**
 * What a member is told when the room has nothing to answer yet.
 *
 * Deliberately not the member's own name: the relay convention is `name：text`,
 * and prefacing an opening with a name would read as though someone had spoken
 * first.
 */
export const OPENING_NOTE = '房间里还没有人说话。你来开这个头。'

/** One member, as the adapter needs to describe them to a runtime. */
export interface MemberSpec {
  readonly memberId: string
  readonly name: string
  readonly description: string
  readonly personality: string
  readonly scenario: string
}

/** What the runtime is told when bringing one member up. */
export interface SpawnOptions {
  readonly member: MemberSpec
  /** The generation this agent belongs to; a later generation replaces it. */
  readonly generation: number
  /** Already free of `{{`; safe to place in a prompt section. */
  readonly personaText: string
  /** Already free of `{{`; safe to place in a prompt section. */
  readonly briefingText: string
}

/** One live member agent. */
export interface MemberAgent {
  /**
   * Say `relay` to this member and resolve with their reply text.
   *
   * A rejection means the delivery failed; the caller's failure budget decides
   * whether to retry. `signal` aborts the underlying model call.
   */
  deliver(relay: string, signal: AbortSignal): Promise<string>
  /** Release the agent. Must be safe to call more than once. */
  dispose(): Promise<void>
}

/**
 * How to obtain member agents.
 *
 * The real implementation creates a member agent with its own session and
 * prompt sections. A fake one records what it was asked for.
 */
export interface MemberRuntime {
  spawn(options: SpawnOptions): Promise<MemberAgent>
}

/** Where the adapter reads the room's own lines. */
export interface TranscriptPort {
  /** The line that produced the take with this relay sequence, or `null`. */
  line(relaySeq: number): string | null
  /** The newest line in the room, or `null` for an empty room. */
  latest(): string | null
}

export interface AgentSpeakerOptions {
  readonly roomName: string
  readonly runtime: MemberRuntime
  readonly transcript: TranscriptPort
  /**
   * The members, read fresh on every delivery.
   *
   * A function rather than an array because membership changes while the room is
   * running, and a snapshot taken at construction is exactly the staleness the
   * legacy project kept re-fixing.
   */
  readonly members: () => readonly MemberSpec[]
  /** Names for the briefing roster; defaults to the members' names. */
  readonly rosterNames?: () => readonly string[]
}

interface LiveMember {
  readonly generation: number
  readonly spec: MemberSpec
  readonly agent: MemberAgent
}

export class AgentSpeaker implements Speaker {
  private readonly options: AgentSpeakerOptions
  /** One agent per member, for the current generation only. */
  private readonly live = new Map<string, LiveMember>()
  /** Spawns in flight, so two concurrent deliveries cannot both spawn one member. */
  private readonly spawning = new Map<string, Promise<MemberAgent>>()
  private disposed = false

  constructor(options: AgentSpeakerOptions) {
    this.options = options
  }

  /** How many member agents are currently up. */
  get liveCount(): number {
    return this.live.size
  }

  /**
   * Say something to one member and return their reply.
   *
   * The relay is chosen by the *request*, not by "whatever is newest": a speech
   * answers the room's latest line, while a reroll answers the exact relay that
   * was pinned when the user clicked. That distinction is the whole point of
   * `RerollIntent`, and this is where it would be thrown away if the adapter
   * looked up the latest line for both.
   */
  async produce(request: SpeakRequest, signal: AbortSignal): Promise<{ text: string }> {
    if (this.disposed) reject('speaker', 'the speaker has been disposed')

    const spec = this.members().find((member) => member.memberId === request.memberId)
    if (spec === undefined) {
      reject('memberId', `no member ${JSON.stringify(request.memberId)} in this room`)
    }

    const relay = this.relayFor(request)
    const agent = await this.ensureAgent(spec, request.generation)
    const text = await agent.deliver(relay, signal)
    return { text }
  }

  /** Release every member agent. Idempotent. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    const agents = [...this.live.values()]
    this.live.clear()
    this.spawning.clear()
    await Promise.all(agents.map((entry) => entry.agent.dispose().catch(() => undefined)))
  }

  // ── internals ────────────────────────────────────────────────────────────

  private members(): readonly MemberSpec[] {
    return this.options.members()
  }

  private relayFor(request: SpeakRequest): string {
    if (request.kind === 'reroll') {
      const pinned = this.options.transcript.line(request.relaySeq)
      // A reroll whose relay is gone cannot faithfully replace the take, so it is
      // refused rather than quietly answering something else. Same "no fallback
      // to the latest" rule the intent itself enforces.
      if (pinned === null) {
        reject(
          'relaySeq',
          `the relay for reroll ${request.intentId ?? '(unknown)'} is no longer in the room`,
        )
      }
      return relayLine(request.memberId, pinned)
    }

    // A speech answers the newest line, and in an empty room there is none. It
    // still speaks: opening the scene is what the first member is *for*, and
    // refusing here would make an empty room impossible to start — which is what
    // wiring this up revealed, three rounds after the refusal looked obviously
    // correct in isolation.
    const latest = this.options.transcript.latest()
    return latest === null
      ? `（${OPENING_NOTE}）`
      : relayLine(request.memberId, latest)
  }

  /**
   * The agent for this member, spawned if needed.
   *
   * In-flight spawns are shared, so two deliveries for the same member during
   * one generation cannot create two agents — the leak the legacy project hit by
   * claiming a slot after an await.
   */
  private async ensureAgent(spec: MemberSpec, generation: number): Promise<MemberAgent> {
    const current = this.live.get(spec.memberId)
    if (current !== undefined && current.generation === generation) return current.agent

    if (current !== undefined) {
      // A new generation: member agents do not survive one. Dispose before
      // spawning so the process never holds both.
      this.live.delete(spec.memberId)
      await current.agent.dispose()
    }

    const inFlight = this.spawning.get(spec.memberId)
    if (inFlight !== undefined) return inFlight

    const pending = this.options.runtime.spawn({
      member: spec,
      generation,
      personaText: this.personaTextFor(spec),
      briefingText: this.briefingText(),
    }).then((agent) => {
      // A disposeAll during the spawn wins: nothing may be left running.
      if (this.disposed) {
        void agent.dispose()
        reject('speaker', 'the speaker was disposed while an agent was starting')
      }
      this.live.set(spec.memberId, { generation, spec, agent })
      return agent
    }).finally(() => {
      this.spawning.delete(spec.memberId)
    })

    this.spawning.set(spec.memberId, pending)
    return pending
  }

  /** Member text, sanitised, with the room's macros supplied. */
  private personaTextFor(spec: MemberSpec): string {
    return sanitizePromptText(persona(spec), {
      char: spec.name,
      user: '用户',
      group: this.options.roomName,
    })
  }

  private briefingText(): string {
    const names = this.options.rosterNames?.() ?? this.members().map((member) => member.name)
    return sanitizePromptText(briefing(this.options.roomName, names), {
      group: this.options.roomName,
    })
  }
}
