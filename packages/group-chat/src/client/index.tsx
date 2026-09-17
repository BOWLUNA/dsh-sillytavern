/**
 * The browser half of dsh-group-chat.
 *
 * Two seats, both additive — neither replaces a shipped surface:
 *
 *   `settings.section`   room management, backed by real host calls
 *   `conversation.view`  a group-room transcript beside the platform's own
 *                        `chat` and `trajectory` views
 *
 * What is deliberately NOT here:
 *
 *   - No `conversation.chat.node` override. That slot's key table is fixed by the
 *     platform and registering an occupied key *replaces* its occupant; two
 *     features that both wanted to restyle the user bubble was the legacy
 *     project's most common "features conflict" shape.
 *   - No `conversation.composer` chain entry. Its selector is evaluated once per
 *     session render, so reacting to state needs a re-registration dance.
 *   - No `sidebar.footer.action`. The platform's sidebar does not respond to
 *     entries registered after boot — a dead end the legacy project recorded and
 *     then kept depending on anyway.
 */

import type { MemberSummary, RoomSummary } from '@dsh-tavern/contracts'
import { claimSlot, resolveSlots } from '@dsh-tavern/contracts/client-slots'
import * as React from 'react'
import { callRemote, describeError, resolveConnection } from '@dsh-tavern/contracts/client-rpc'
import type { ClientConnection } from '@dsh-tavern/contracts/client-rpc'
import './styles.module.css'

/**
 * Stable Cordis plugin name — the same string the host half exports. The browser
 * *bundle* is keyed by package name (`dsh-group-chat`); that id is written by the
 * build tool and is a different thing.
 */
export const name = 'group-chat'

/**
 * Declared, not merely read.
 *
 * The client registry guards service reads: without this array `get('slots')` and
 * `get('connection')` return nothing and `apply` is refused — with no error, and
 * with the module present and correctly versioned in the browser graph.
 */
export const inject = ['slots', 'connection']

/** The slice of a Cordis `Context` this half uses. */
interface ClientContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void): unknown
}

/** The wire namespace of this plugin's host half. */
const NAMESPACE = 'groupChat'

// ────────────────────────────────────────────────────────────────────────────
// Room management
// ────────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────────
// Members
// ────────────────────────────────────────────────────────────────────────────

/**
 * The member list for one room, and the form that adds to it.
 *
 * Mounted only while a room row is expanded, so collapsing a room stops its
 * reads — the list call is not made for rooms nobody is looking at.
 */
function Members({ connection, roomId, onChanged }: {
  connection: ClientConnection
  roomId: string
  /**
   * Called after a member is added or removed.
   *
   * The room row shows a member count that comes from the *room* list, so a
   * change here must refresh it too — otherwise the row keeps claiming "0 名成员"
   * next to a member that is plainly on screen. That is not hypothetical: it is
   * what the populated screenshot showed, while every DOM assertion passed.
   */
  onChanged: () => void
}): React.ReactElement {
  const [members, setMembers] = React.useState<readonly MemberSummary[] | null>(null)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState<Record<string, string>>({})

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      setMembers(await callRemote<MemberSummary[]>(connection, NAMESPACE, 'listMembers', { roomId }))
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [connection, roomId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const add = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await callRemote<MemberSummary>(connection, NAMESPACE, 'addMember', {
        roomId,
        config: { name },
      })
      setName('')
      await refresh()
      onChanged()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (memberId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await callRemote<boolean>(connection, NAMESPACE, 'removeMember', { roomId, memberId })
      await refresh()
      onChanged()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dgc-members">
      <form className="dgc-form" onSubmit={(event) => void add(event)}>
        <input
          className="dgc-input dgc-member-input"
          type="text"
          value={name}
          aria-label="成员名"
          placeholder="成员名"
          disabled={busy}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
        />
        <button className="dgc-button" type="submit" disabled={busy || name.trim() === ''}>
          添加成员
        </button>
      </form>

      {error !== null && <p className="dgc-error" role="alert">{error}</p>}

      {members === null && <p className="dgc-hint">（正在读取成员…）</p>}
      {members !== null && members.length === 0 && (
        <p className="dgc-hint">这个房间还没有成员。</p>
      )}
      {members !== null && members.length > 0 && (
        <ul className="dgc-member-list">
          {members.map((member) => (
            <li className="dgc-member" key={member.memberId}>
              <span className="dgc-member-name">
                {member.emoji === '' ? '' : `${member.emoji} `}{member.name}
              </span>
              <span className="dgc-member-id">{member.memberId}</span>
              <button
                className="dgc-button dgc-button-quiet"
                type="button"
                disabled={busy}
                aria-label={`移除 ${member.name}`}
                onClick={() => void remove(member.memberId)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RoomManager({ connection }: { connection: ClientConnection }): React.ReactElement {
  const [rooms, setRooms] = React.useState<readonly RoomSummary[] | null>(null)
  const [name, setName] = React.useState('')
  const [mode, setMode] = React.useState<RoomSummary['mode']>('round-robin')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [expanded, setExpanded] = React.useState<string | null>(null)
  const [running, setRunning] = React.useState<Record<string, string>>({})

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      setRooms(await callRemote<RoomSummary[]>(connection, NAMESPACE, 'listRooms'))
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [connection])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // A rejection from the host's validator arrives here as a RemoteCallError
      // and is shown verbatim. Loud rejection is the contract; folding it into a
      // generic "failed" would hide *which* field was wrong.
      await callRemote<RoomSummary>(connection, NAMESPACE, 'createRoom', { config: { name, mode } })
      setName('')
      await refresh()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const roomAction = (roomId: string, method: string): void => {
    void (async () => {
      setBusy(true)
      setError(null)
      try {
        const view = await callRemote<{ status: string; turnId: number; takeCount: number }>(
          connection, NAMESPACE, method, { roomId },
        )
        setRunning((current) => ({
          ...current,
          [roomId]: `${view.status} · 第 ${view.turnId} 轮 · ${view.takeCount} 条发言`,
        }))
      } catch (cause) {
        // Shown verbatim. Starting a room without a speaker installed is a real
        // refusal with a real explanation, and hiding it behind "failed" would
        // be the facade this project keeps refusing to build.
        setRunning((current) => ({ ...current, [roomId]: describeError(cause) }))
      } finally {
        setBusy(false)
      }
    })()
  }

  const remove = async (roomId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await callRemote<boolean>(connection, NAMESPACE, 'deleteRoom', { roomId })
      await refresh()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dgc-section">
      <div className="dgc-card">
        <h3 className="dgc-title">群聊</h3>
        <p className="dgc-hint">
          房间是<strong>持久化</strong>的：写进宿主的存储域，重启实例后仍在。
          {rooms === null ? '（正在读取…）' : `（当前 ${rooms.length} 个）`}
        </p>

        <form className="dgc-form" onSubmit={(event) => void submit(event)}>
          <input
            className="dgc-input"
            type="text"
            value={name}
            aria-label="房间名"
            placeholder="房间名"
            disabled={busy}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          />
          <select
            className="dgc-select"
            value={mode}
            aria-label="轮次模式"
            disabled={busy}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
              setMode(event.target.value as RoomSummary['mode'])}
          >
            <option value="round-robin">轮播</option>
            <option value="free">自由点名</option>
          </select>
          <button className="dgc-button" type="submit" disabled={busy || name.trim() === ''}>
            创建
          </button>
        </form>

        {error !== null && <p className="dgc-error" role="alert">{error}</p>}
      </div>

      {rooms !== null && rooms.length > 0 && (
        <ul className="dgc-rooms">
          {rooms.map((room) => (
            <li className="dgc-room" key={room.roomId}>
              <div className="dgc-room-head">
                <span className="dgc-room-name">{room.name}</span>
                <span className="dgc-badge">{room.mode === 'round-robin' ? '轮播' : '自由'}</span>
                <span className="dgc-badge">{room.status === 'stopped' ? '未开始' : room.status}</span>
                <span className="dgc-badge">{room.memberCount} 名成员</span>
                <button
                  className="dgc-button dgc-start"
                  type="button"
                  disabled={busy}
                  aria-label={`开始 ${room.name}`}
                  onClick={() => roomAction(room.roomId, 'startGroup')}
                >
                  开始
                </button>
                <button
                  className="dgc-button dgc-button-quiet"
                  type="button"
                  disabled={busy}
                  aria-label={`停止 ${room.name}`}
                  onClick={() => roomAction(room.roomId, 'stopGroup')}
                >
                  停止
                </button>
                <button
                  className="dgc-button dgc-button-quiet"
                  type="button"
                  aria-expanded={expanded === room.roomId}
                  onClick={() => setExpanded(expanded === room.roomId ? null : room.roomId)}
                >
                  成员
                </button>
                <button
                  className="dgc-button dgc-button-quiet"
                  type="button"
                  disabled={busy}
                  aria-label={`删除 ${room.name}`}
                  onClick={() => void remove(room.roomId)}
                >
                  删除
                </button>
              </div>
              {running[room.roomId] !== undefined && (
                <p className="dgc-room-state" aria-label={`${room.name} 状态`}>{running[room.roomId]}</p>
              )}
              {expanded === room.roomId && (
                <Members
                  connection={connection}
                  roomId={room.roomId}
                  onChanged={() => void refresh()}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {rooms !== null && rooms.length === 0 && (
        <div className="dgc-card">
          <p className="dgc-hint">还没有房间。上面创建一个试试。</p>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The session view
// ────────────────────────────────────────────────────────────────────────────

/**
 * The tavern-style transcript seat.
 *
 * Still a placeholder, and honestly so: it needs a room session to render, and
 * rooms do not open sessions yet. The seat is claimed regardless, so the tab's
 * registration path is exercised — the legacy project's equivalent registration
 * lost a race with the platform's async slot declaration and took the whole
 * plugin down with it, which is what `claimSlot` exists to prevent.
 */
function GroupRoomView(): React.ReactElement {
  return (
    <div className="dgc-view">
      <h3 className="dgc-title">群聊房间</h3>
      <p className="dgc-hint">
        这是一个独立注册的会话视图。平台自带的 <code>chat</code> 与 <code>trajectory</code> 视图不受影响，
        三者并排存在、按需切换。房间开始说话之后，转录本会渲染在这里。
      </p>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Mounting
// ────────────────────────────────────────────────────────────────────────────

export function apply(ctx: ClientContext): void {
  const slots = resolveSlots((n) => ctx.get(n), name)
  const connection = resolveConnection((n) => ctx.get(n), name)
  if (slots === null || connection === null) return

  const onGaveUp = (error: unknown, entry: { name: string }): void => {
    console.error(
      `[${name}] gave up claiming slot "${entry.name}" after repeated attempts. `
      + 'The slot table was never declared. The rest of the plugin stays loaded.',
      error,
    )
  }

  // Built per apply so the component closes over this session's connection,
  // rather than depending on the slot entry's props plumbing.
  const Section = (): React.ReactElement => <RoomManager connection={connection} />

  ctx.effect(() => {
    const releaseView = claimSlot({
      slots,
      entry: { name: 'conversation.view', id: name, order: 5, label: () => '群聊' },
      component: GroupRoomView,
      onGaveUp,
    })
    const releaseSection = claimSlot({
      slots,
      entry: { name: 'settings.section', id: name, order: 10, label: () => '群聊' },
      component: Section,
      onGaveUp,
    })
    return () => {
      releaseView()
      releaseSection()
    }
  })
}
