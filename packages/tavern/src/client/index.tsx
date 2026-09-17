/**
 * The browser half of dsh-tavern.
 *
 * This half claims a **whole page**, which is the one design decision here that
 * differs deliberately from the legacy project.
 *
 * The legacy tavern put everything into `settings.section`, so the tavern lived
 * inside a platform dialog. That dialog is `overflow: hidden` at a fixed width,
 * which is why an entire review round went into adding `max-width: 100%` to nine
 * class names and then another round into the one that was missed. It also left
 * no room to be a tavern: character cards, a transcript and a book editor all
 * competing for a settings pane.
 *
 * The platform has a seat for exactly this. `main` is keyed by sidebar entry id
 * and its catalog says plainly: "The reserved `conversation` key hosts the
 * Conversation; other keys receive no Session binding." So a plugin may claim
 * its own key and get a full central panel; `sidebar.panellist` is the
 * "global panel icons" list that puts the entry point next to the others.
 *
 * Both are additive. No shipped seat is replaced, and nothing here can collide
 * with another plugin, because the key is ours.
 */

import type { LorebookEntry, LorebookSettings, RoomSummary } from '@dsh-tavern/contracts'
import { callRemote, describeError, resolveConnection } from '@dsh-tavern/contracts/client-rpc'
import type { ClientConnection } from '@dsh-tavern/contracts/client-rpc'
import { claimSlot, resolveSlots } from '@dsh-tavern/contracts/client-slots'
import * as React from 'react'
import './styles.module.css'

export const name = 'tavern'

/** Declared, not merely read — see the note in the group-chat client half. */
export const inject = ['slots', 'connection']

/** The key the shell dispatches `main` by; must match the panellist entry id. */
const PANEL_KEY = name

/** Wire namespaces this half calls. */
const TAVERN = 'tavern'
const GROUP_CHAT = 'groupChat'

interface ClientContext {
  get(name: string): unknown
  effect(callback: () => (() => void) | void): unknown
}

/** One book, as the tavern service reports it. */
interface BookSummary {
  readonly bookId: string
  readonly name: string
  readonly enabled: boolean
  readonly entryCount: number
  readonly revision: number
  readonly createdAt: number
}

/** The tester's result. */
interface ScanPreview {
  readonly text: string
  readonly activated: readonly { readonly entryId: string; readonly content: string; readonly round: number }[]
  readonly trace: readonly {
    readonly entryId: string
    readonly reason: string
    readonly round: number
    readonly matchedKeys: readonly string[]
  }[]
  readonly budgetBytes: number
  readonly activatedBytes: number
  readonly budgetExcluded: number
  readonly outputLimited: boolean
  readonly rounds: number
}

/** One binding row. Ownership is part of the row, never implicit. */
interface BindingView {
  readonly owner: string
  readonly targetId: string
  readonly bookIds: readonly string[]
  readonly updatedAt: number
}

// ────────────────────────────────────────────────────────────────────────────
// World books
// ────────────────────────────────────────────────────────────────────────────

function WorldBooks({ connection }: { connection: ClientConnection }): React.ReactElement {
  const [books, setBooks] = React.useState<readonly BookSummary[] | null>(null)
  const [bindings, setBindings] = React.useState<readonly BindingView[]>([])
  const [rooms, setRooms] = React.useState<readonly RoomSummary[] | null>(null)
  const [name, setName] = React.useState('')
  const [target, setTarget] = React.useState('')
  const [selected, setSelected] = React.useState('')
  const [editing, setEditing] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const [nextBooks, nextBindings] = await Promise.all([
        callRemote<BookSummary[]>(connection, TAVERN, 'listBooks'),
        callRemote<BindingView[]>(connection, TAVERN, 'listBindings'),
      ])
      setBooks(nextBooks)
      setBindings(nextBindings)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [connection])

  // Room ids, if group chat happens to be installed. Its absence is not an
  // error: the tavern must work without it, so a failure here just means the
  // picker offers text instead of a list.
  React.useEffect(() => {
    void (async () => {
      try {
        setRooms(await callRemote<RoomSummary[]>(connection, GROUP_CHAT, 'listRooms'))
      } catch {
        setRooms(null)
      }
    })()
  }, [connection])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const guarded = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const create = (event: React.FormEvent): void => {
    event.preventDefault()
    void guarded(async () => {
      await callRemote<BookSummary>(connection, TAVERN, 'createBook', { config: { name } })
      setName('')
      await refresh()
    })
  }

  const remove = (bookId: string): void => {
    void guarded(async () => {
      await callRemote<boolean>(connection, TAVERN, 'deleteBook', { bookId })
      await refresh()
    })
  }

  const bind = (event: React.FormEvent): void => {
    event.preventDefault()
    void guarded(async () => {
      await callRemote<void>(connection, TAVERN, 'setUserBinding', {
        targetId: target,
        bookIds: [...(bindings.find((row) => row.owner === 'user' && row.targetId === target)?.bookIds ?? []), selected],
      })
      setTarget('')
      await refresh()
    })
  }

  const unbind = (row: BindingView, bookId: string): void => {
    void guarded(async () => {
      // Targeted removal, not a whole-row write. The whole-row form is what
      // silently deleted another writer's bindings in the legacy project, and
      // the row here may be owned by someone other than the user.
      await callRemote<void>(connection, TAVERN, 'removeBinding', { targetId: row.targetId, bookId })
      await refresh()
    })
  }

  return (
    <section className="dtv-section">
      <div className="dtv-card">
        <h3 className="dtv-card-title">世界书</h3>
        <p className="dtv-hint">
          {books === null ? '正在读取…' : `共 ${books.length} 本。条目在注入时按关键词命中，未命中的不消耗预算。`}
        </p>

        <form className="dtv-form" onSubmit={create}>
          <input
            className="dtv-input dtv-book-name"
            type="text"
            value={name}
            aria-label="书名"
            placeholder="书名"
            disabled={busy}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
          />
          <button className="dtv-button" type="submit" disabled={busy || name.trim() === ''}>
            新建世界书
          </button>
        </form>

        {error !== null && <p className="dtv-error" role="alert">{error}</p>}

        {books !== null && books.length === 0 && (
          <p className="dtv-hint">还没有世界书。上面新建一本试试。</p>
        )}
        {books !== null && books.length > 0 && (
          <ul className="dtv-list">
            {books.map((book) => (
              <li className="dtv-row dtv-book" key={book.bookId}>
                <span className="dtv-row-name">{book.name}</span>
                <span className="dtv-badge">{book.entryCount} 条</span>
                <span className="dtv-badge">{book.enabled ? '启用' : '停用'}</span>
                <span className="dtv-row-id">{book.bookId}</span>
                <button
                  className="dtv-button dtv-button-quiet"
                  type="button"
                  aria-expanded={editing === book.bookId}
                  aria-label={`编辑 ${book.name}`}
                  onClick={() => setEditing(editing === book.bookId ? null : book.bookId)}
                >
                  编辑
                </button>
                <button
                  className="dtv-button dtv-button-quiet"
                  type="button"
                  disabled={busy}
                  aria-label={`删除 ${book.name}`}
                  onClick={() => remove(book.bookId)}
                >
                  删除
                </button>
                {editing === book.bookId && (
                  <BookEditor
                    connection={connection}
                    book={book}
                    onChanged={() => void refresh()}
                    onClose={() => setEditing(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="dtv-card">
        <h3 className="dtv-card-title">绑定</h3>
        <p className="dtv-hint">
          把一本书绑到一个目标上，它才会参与那个目标的提示词组装。
          {rooms === null
            ? '（群聊未安装，请直接填目标 id）'
            : rooms.length === 0
              // The hint and the control must agree. They did not: the hint
              // promised a room picker while the form showed a text box,
              // because one checked `rooms === null` and the other
              // `rooms.length > 0`. The screenshot caught it.
              ? '（还没有房间，可直接填目标 id）'
              : '（可从群聊房间中选择）'}
        </p>

        <form className="dtv-form" onSubmit={bind}>
          {rooms !== null && rooms.length > 0 ? (
            <select
              className="dtv-input dtv-target"
              value={target}
              aria-label="绑定目标"
              disabled={busy}
              onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setTarget(event.target.value)}
            >
              <option value="">选择房间…</option>
              {rooms.map((room) => (
                <option key={room.roomId} value={room.roomId}>{room.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="dtv-input dtv-target"
              type="text"
              value={target}
              aria-label="绑定目标"
              placeholder="目标 id"
              disabled={busy}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTarget(event.target.value)}
            />
          )}
          <select
            className="dtv-input dtv-book-select"
            value={selected}
            aria-label="选择世界书"
            disabled={busy}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setSelected(event.target.value)}
          >
            <option value="">选择世界书…</option>
            {(books ?? []).map((book) => (
              <option key={book.bookId} value={book.bookId}>{book.name}</option>
            ))}
          </select>
          <button
            className="dtv-button"
            type="submit"
            disabled={busy || target.trim() === '' || selected === ''}
          >
            绑定
          </button>
        </form>

        {bindings.length === 0 && <p className="dtv-hint">还没有任何绑定。</p>}
        {bindings.length > 0 && (
          <ul className="dtv-list">
            {bindings.map((row) => (
              <li className="dtv-row dtv-binding" key={`${row.owner}:${row.targetId}`}>
                <span className="dtv-badge">{row.owner}</span>
                <span className="dtv-row-id">{row.targetId}</span>
                {row.bookIds.length === 0 && <span className="dtv-hint">（空）</span>}
                {row.bookIds.map((bookId) => {
                  const book = (books ?? []).find((candidate) => candidate.bookId === bookId)
                  return (
                    <button
                      className="dtv-button dtv-button-quiet"
                      key={bookId}
                      type="button"
                      disabled={busy}
                      aria-label={`解绑 ${book?.name ?? bookId}`}
                      onClick={() => unbind(row, bookId)}
                    >
                      {book?.name ?? bookId} ✕
                    </button>
                  )
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}


// ────────────────────────────────────────────────────────────────────────────
// Entry editor
// ────────────────────────────────────────────────────────────────────────────

function newEntryId(): string {
  return `entry-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** The defaults a new entry starts from. The host re-validates all of them. */
function blankEntry(): LorebookEntry {
  return {
    entryId: `entry-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    keys: [],
    secondaryKeys: [],
    content: '',
    comment: '',
    constant: false,
    selective: false,
    selectiveLogic: 0,
    order: 100,
    position: 'before',
    probability: 100,
    useProbability: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    disable: false,
    ignoreBudget: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    excludeRecursion: false,
    preventRecursion: false,
  }
}

function Flag({ label, checked, disabled, onToggle, aria }: {
  label: string
  checked: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
  aria: string
}): React.ReactElement {
  return (
    <label className="dtv-flag">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={aria}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => onToggle(event.target.checked)}
      />
      {label}
    </label>
  )
}

/** A three-state flag: inherited, on, off. `null` means inherit. */
function Tri({ label, value, disabled, onChange, aria }: {
  label: string
  value: boolean | null
  disabled: boolean
  onChange: (next: boolean | null) => void
  aria: string
}): React.ReactElement {
  return (
    <label className="dtv-flag">
      {label}
      <select
        className="dtv-input dtv-tri"
        value={value === null ? 'inherit' : value ? 'yes' : 'no'}
        disabled={disabled}
        aria-label={aria}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = event.target.value
          onChange(next === 'inherit' ? null : next === 'yes')
        }}
      >
        <option value="inherit">继承</option>
        <option value="yes">是</option>
        <option value="no">否</option>
      </select>
    </label>
  )
}

function Num({ label, value, disabled, onChange, aria, placeholder }: {
  label: string
  value: number | null
  disabled: boolean
  onChange: (next: number | null) => void
  aria: string
  placeholder?: string
}): React.ReactElement {
  return (
    <label className="dtv-flag">
      {label}
      <input
        className="dtv-input dtv-num"
        type="number"
        value={value === null ? '' : value}
        placeholder={placeholder ?? ''}
        disabled={disabled}
        aria-label={aria}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          const raw = event.target.value
          onChange(raw === '' ? null : Number(raw))
        }}
      />
    </label>
  )
}

/**
 * Edit one book's entries, and test them.
 *
 * Edits are local until saved, which is what makes `baseRevision` meaningful:
 * the save carries the revision it was based on, so a concurrent editor is
 * refused rather than silently overwritten. A live-updating form would make that
 * check decorative.
 *
 * Every field of an entry has an input. The set is long and not pretty, but the
 * alternative — showing five fields and letting the rest be defaults — makes
 * whole halves of the engine unreachable: secondary keys, inclusion groups and
 * probability cannot even be expressed, so they cannot be tested.
 */
function BookEditor({ connection, book, onChanged, onClose }: {
  connection: ClientConnection
  book: BookSummary
  onChanged: () => void
  onClose: () => void
}): React.ReactElement {
  const [entries, setEntries] = React.useState<readonly LorebookEntry[] | null>(null)
  const [settings, setSettings] = React.useState<LorebookSettings | null>(null)
  const [revision, setRevision] = React.useState(book.revision)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        const full = await callRemote<{
          entries: readonly LorebookEntry[]
          settings: LorebookSettings
          revision: number
        } | null>(connection, TAVERN, 'readBook', { bookId: book.bookId })
        if (full === null) {
          setError('这本书已经不存在了')
          return
        }
        setEntries(full.entries)
        setSettings(full.settings)
        setRevision(full.revision)
      } catch (cause) {
        setError(describeError(cause))
      }
    })()
  }, [connection, book.bookId])

  const patch = (entryId: string, change: Partial<LorebookEntry>): void => {
    setEntries((current) => (current ?? []).map((entry) => (
      entry.entryId === entryId ? { ...entry, ...change } : entry
    )))
  }

  const save = (): void => {
    if (busy || entries === null) return
    setBusy(true)
    setError(null)
    setNote(null)
    void (async () => {
      try {
        const saved = await callRemote<{ revision: number }>(connection, TAVERN, 'updateBook', {
          bookId: book.bookId,
          patch: {
            entries,
            ...(settings === null ? {} : { settings }),
            baseRevision: revision,
          },
        })
        setRevision(saved.revision)
        setNote(`已保存（修订 ${saved.revision}）`)
        onChanged()
      } catch (cause) {
        setError(describeError(cause))
      } finally {
        setBusy(false)
      }
    })()
  }

  const list = (value: string): string[] =>
    value.split(',').map((part) => part.trim()).filter((part) => part !== '')

  return (
    <div className="dtv-editor">
      {settings !== null && (
        <div className="dtv-entry">
          <div className="dtv-entry-head">
            <span className="dtv-badge">书设置</span>
            <span className="dtv-hint">影响这本书的每一次扫描，不只是某一条。</span>
          </div>
          <div className="dtv-entry-flags">
            <Num label="扫描深度" value={settings.scanDepth} disabled={busy} aria="书 扫描深度"
              onChange={(next) => setSettings({ ...settings, scanDepth: next ?? 2 })} />
            <Num label="预算 %" value={settings.budgetPercent} disabled={busy} aria="书 预算百分比"
              onChange={(next) => setSettings({ ...settings, budgetPercent: next ?? 25 })} />
            <Num label="预算上限" value={settings.budgetCap} disabled={busy} aria="书 预算上限"
              onChange={(next) => setSettings({ ...settings, budgetCap: next ?? 0 })} />
            <Flag label="区分大小写" checked={settings.caseSensitive} disabled={busy} aria="书 区分大小写"
              onToggle={(next) => setSettings({ ...settings, caseSensitive: next })} />
            <Flag label="整词匹配" checked={settings.matchWholeWords} disabled={busy} aria="书 整词匹配"
              onToggle={(next) => setSettings({ ...settings, matchWholeWords: next })} />
            <Flag label="允许正则" checked={settings.allowRegex} disabled={busy} aria="书 允许正则"
              onToggle={(next) => setSettings({ ...settings, allowRegex: next })} />
            <Flag label="递归" checked={settings.recursive} disabled={busy} aria="书 递归"
              onToggle={(next) => setSettings({ ...settings, recursive: next })} />
            <Num label="递归轮数" value={settings.maxRecursionSteps} disabled={busy} aria="书 递归轮数"
              onChange={(next) => setSettings({ ...settings, maxRecursionSteps: next ?? 0 })} />
          </div>
        </div>
      )}

      {entries === null && <p className="dtv-hint">正在读取条目…</p>}
      {entries !== null && entries.length === 0 && <p className="dtv-hint">这本书还没有条目。</p>}

      {entries !== null && entries.map((entry, index) => {
        const n = index + 1
        return (
          <div className="dtv-entry" key={entry.entryId}>
            <div className="dtv-entry-head">
              <span className="dtv-badge">#{n}</span>
              <span className="dtv-row-id">{entry.entryId}</span>
              <button
                className="dtv-button dtv-button-quiet"
                type="button"
                disabled={busy}
                aria-label={`删除条目 ${n}`}
                onClick={() => setEntries((current) => (current ?? []).filter((e) => e.entryId !== entry.entryId))}
              >
                删除条目
              </button>
            </div>

            <input
              className="dtv-input dtv-entry-keys"
              type="text"
              value={entry.keys.join(', ')}
              aria-label={`条目 ${n} 关键词`}
              placeholder="关键词，用逗号分隔"
              disabled={busy}
              onChange={(event) => patch(entry.entryId, { keys: list(event.target.value) })}
            />
            <textarea
              className="dtv-input dtv-entry-content"
              value={entry.content}
              aria-label={`条目 ${n} 内容`}
              placeholder="命中后注入的内容"
              rows={3}
              disabled={busy}
              onChange={(event) => patch(entry.entryId, { content: event.target.value })}
            />

            <div className="dtv-entry-flags">
              <Flag label="常驻" checked={entry.constant} disabled={busy} aria={`条目 ${n} 常驻`}
                onToggle={(next) => patch(entry.entryId, { constant: next })} />
              <Flag label="停用" checked={entry.disable} disabled={busy} aria={`条目 ${n} 停用`}
                onToggle={(next) => patch(entry.entryId, { disable: next })} />
              <Flag label="忽略预算" checked={entry.ignoreBudget} disabled={busy} aria={`条目 ${n} 忽略预算`}
                onToggle={(next) => patch(entry.entryId, { ignoreBudget: next })} />
              <Flag label="排除递归" checked={entry.excludeRecursion} disabled={busy} aria={`条目 ${n} 排除递归`}
                onToggle={(next) => patch(entry.entryId, { excludeRecursion: next })} />
              <Flag label="阻止递归" checked={entry.preventRecursion} disabled={busy} aria={`条目 ${n} 阻止递归`}
                onToggle={(next) => patch(entry.entryId, { preventRecursion: next })} />
              <Num label="顺序" value={entry.order} disabled={busy} aria={`条目 ${n} 顺序`}
                onChange={(next) => patch(entry.entryId, { order: next ?? 0 })} />
              <label className="dtv-flag">
                位置
                <select className="dtv-input dtv-tri" value={entry.position} disabled={busy}
                  aria-label={`条目 ${n} 位置`}
                  onChange={(event) => patch(entry.entryId, { position: event.target.value as 'before' | 'after' })}>
                  <option value="before">历史之前</option>
                  <option value="after">历史之后</option>
                </select>
              </label>
            </div>

            <div className="dtv-entry-flags">
              <Flag label="启用概率" checked={entry.useProbability} disabled={busy} aria={`条目 ${n} 启用概率`}
                onToggle={(next) => patch(entry.entryId, { useProbability: next })} />
              <Num label="概率 %" value={entry.probability} disabled={busy} aria={`条目 ${n} 概率`}
                onChange={(next) => patch(entry.entryId, { probability: next ?? 100 })} />
              <Flag label="次级关键词" checked={entry.selective} disabled={busy} aria={`条目 ${n} 次级关键词`}
                onToggle={(next) => patch(entry.entryId, { selective: next })} />
              <label className="dtv-flag">
                次级逻辑
                <select className="dtv-input dtv-tri" value={String(entry.selectiveLogic)} disabled={busy}
                  aria-label={`条目 ${n} 次级逻辑`}
                  onChange={(event) => patch(entry.entryId, {
                    selectiveLogic: Number(event.target.value) as LorebookEntry['selectiveLogic'],
                  })}>
                  <option value="0">任一命中</option>
                  <option value="1">非全命中</option>
                  <option value="2">全不命中</option>
                  <option value="3">全部命中</option>
                </select>
              </label>
              <input
                className="dtv-input"
                type="text"
                value={entry.secondaryKeys.join(', ')}
                aria-label={`条目 ${n} 次关键词`}
                placeholder="次级关键词，用逗号分隔"
                disabled={busy}
                onChange={(event) => patch(entry.entryId, { secondaryKeys: list(event.target.value) })}
              />
            </div>

            <div className="dtv-entry-flags">
              <label className="dtv-flag">
                组
                <input className="dtv-input dtv-num" type="text" value={entry.group} disabled={busy}
                  aria-label={`条目 ${n} 组`} placeholder="（无）"
                  onChange={(event) => patch(entry.entryId, { group: event.target.value })} />
              </label>
              <Num label="组权重" value={entry.groupWeight} disabled={busy} aria={`条目 ${n} 组权重`}
                onChange={(next) => patch(entry.entryId, { groupWeight: next ?? 100 })} />
              <Flag label="组内优先" checked={entry.groupOverride} disabled={busy} aria={`条目 ${n} 组内优先`}
                onToggle={(next) => patch(entry.entryId, { groupOverride: next })} />
              <Num label="扫描深度" value={entry.scanDepth} disabled={busy} placeholder="继承"
                aria={`条目 ${n} 扫描深度`}
                onChange={(next) => patch(entry.entryId, { scanDepth: next })} />
              <Tri label="区分大小写" value={entry.caseSensitive} disabled={busy} aria={`条目 ${n} 区分大小写`}
                onChange={(next) => patch(entry.entryId, { caseSensitive: next })} />
              <Tri label="整词匹配" value={entry.matchWholeWords} disabled={busy} aria={`条目 ${n} 整词匹配`}
                onChange={(next) => patch(entry.entryId, { matchWholeWords: next })} />
              <input
                className="dtv-input"
                type="text"
                value={entry.comment}
                aria-label={`条目 ${n} 备注`}
                placeholder="备注"
                disabled={busy}
                onChange={(event) => patch(entry.entryId, { comment: event.target.value })}
              />
            </div>
          </div>
        )
      })}

      {entries !== null && (
        <div className="dtv-form">
          <button className="dtv-button" type="button" disabled={busy}
            onClick={() => setEntries((current) => [...(current ?? []), blankEntry()])}>
            添加条目
          </button>
          <button className="dtv-button dtv-save" type="button" disabled={busy} onClick={save}>保存</button>
          <button className="dtv-button dtv-button-quiet" type="button" disabled={busy} onClick={onClose}>收起</button>
        </div>
      )}

      {note !== null && <p className="dtv-hint">{note}</p>}
      {error !== null && <p className="dtv-error" role="alert">{error}</p>}

      <ScanTester connection={connection} bookId={book.bookId} />
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Injection tester
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ask the engine why.
 *
 * The trace is the whole feature: "did it inject" is answered by the text, but
 * "why did *this entry* not fire" needs the per-entry reason, and that is the
 * question an author actually has.
 */
function ScanTester({ connection, bookId }: {
  connection: ClientConnection
  bookId: string
}): React.ReactElement {
  const [sample, setSample] = React.useState('我拔出了那把剑。')
  const [result, setResult] = React.useState<ScanPreview | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        // Newest first: the engine's depth window counts back from the most
        // recent message, so the order here is part of the contract.
        const messages = sample.split('\n').map((line) => line.trim()).filter((line) => line !== '').reverse()
        setResult(await callRemote<ScanPreview>(
          connection, TAVERN, 'previewScan', { bookIds: [bookId], messages, contextTokens: 64000 },
        ))
      } catch (cause) {
        setError(describeError(cause))
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <div className="dtv-tester">
      <h4 className="dtv-card-title">测试注入</h4>
      <p className="dtv-hint">每行一条消息。越靠下越新——扫描从最新的往回数。</p>
      <textarea
        className="dtv-input dtv-sample"
        value={sample}
        aria-label="测试消息"
        rows={3}
        disabled={busy}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setSample(event.target.value)}
      />
      <div className="dtv-form">
        <button className="dtv-button dtv-run-scan" type="button" disabled={busy} onClick={run}>
          测试
        </button>
      </div>

      {error !== null && <p className="dtv-error" role="alert">{error}</p>}

      {result !== null && (
        <div className="dtv-result">
          <p className="dtv-hint">
            命中 {result.activated.length} 条 · 共 {result.trace.length} 条被检查 ·
            预算 {result.activatedBytes}/{result.budgetBytes} 字节
            {result.outputLimited ? ' · 输出达上限' : ''}
          </p>
          <p className="dtv-hint">
            这里是书里的<strong>原文</strong>。真正注入时会先做提示词净化——书里的
            <code>{'{{name}}'}</code> 若不在可用变量里，会变成可见的字面量而不是让请求失败。
          </p>
          <pre className="dtv-pre" aria-label="注入结果">{result.text === '' ? '（没有内容被注入）' : result.text}</pre>
          <ul className="dtv-list">
            {result.trace.map((record) => (
              <li className="dtv-row dtv-trace" key={`${record.entryId}:${record.round}`}>
                <span className="dtv-row-id">{record.entryId}</span>
                <span className={`dtv-badge ${record.reason === 'activated' || record.reason === 'constant' ? 'dtv-badge-ok' : ''}`}>
                  {record.reason}
                </span>
                {record.matchedKeys.length > 0 && (
                  <span className="dtv-row-id">命中 {record.matchedKeys.join(', ')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The panel
// ────────────────────────────────────────────────────────────────────────────

function TavernPanel({ connection }: { connection: ClientConnection }): React.ReactElement {
  return (
    <div className="dtv-page">
      <header className="dtv-header">
        <h2 className="dtv-title">酒馆</h2>
        <p className="dtv-subtitle">独立整页，不寄生在设置对话框里。</p>
      </header>
      <WorldBooks connection={connection} />
    </div>
  )
}

/** The sidebar icon that selects the tavern page. */
function TavernPanelIcon(): React.ReactElement {
  return <span className="dtv-icon" aria-hidden="true">🍶</span>
}

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

  const Panel = (): React.ReactElement => <TavernPanel connection={connection} />

  ctx.effect(() => {
    // The icon must be registered with the same id the panel is keyed by;
    // that string is the whole contract between the two seats.
    const releaseIcon = claimSlot({
      slots,
      entry: { name: 'sidebar.panellist', id: PANEL_KEY, order: 30, label: () => '酒馆' },
      component: TavernPanelIcon,
      onGaveUp,
    })
    const releasePanel = claimSlot({
      slots,
      entry: { name: 'main', key: PANEL_KEY },
      component: Panel,
      onGaveUp,
    })
    return () => {
      releaseIcon()
      releasePanel()
    }
  })
}
