/**
 * Declarations for the browser-only seed modules.
 *
 * These specifiers are real at runtime — the page's module loader resolves them
 * out of its frozen table — but they are *not* published as npm packages, so
 * there is nothing on disk for TypeScript to read. The legacy project handled
 * this by symlinking them out of a local DSH checkout, which is exactly the
 * kind of machine-specific binding that made a fresh clone unusable.
 *
 * So: declare the smallest surface we actually use, once, here. Nothing
 * speculative — every member below corresponds to a call in our client code.
 * When the surface grows, grow this file, and keep the runtime specifier list
 * in sync with tools/seed-modules.mjs.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Registration entry shared by every list/keyed/single slot. */
  export interface SlotEntry {
    /** Exact slot path, e.g. `conversation.view`. */
    readonly name: string
    /** Our cell key within a `list` slot. */
    readonly id?: string
    /** Our cell key within a `keyed` slot — the key the owner dispatches by. */
    readonly key?: string
    readonly order?: number
    /** Display text; a thunk is re-read on every projection, so it can follow locale. */
    readonly label?: string | (() => string)
    /** Locale namespace for the registration. */
    readonly locale?: string
    readonly priority?: number
  }

  export interface SlotsService {
    /**
     * Register one entry. Throws when the target slot's table is not declared
     * yet — which the platform does on its own schedule, so callers must treat
     * throwing as "try again", not as "fail the plugin". See
     * `src/client/slots.ts`.
     */
    register(entry: SlotEntry, component: unknown): () => void
  }

  /** Locale namespace handle returned by `ctx.locale.register`. */
  export interface TranslateNS {
    (key: string, params?: Record<string, unknown>): string
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'

  export interface ButtonProps {
    readonly children?: ReactNode
    readonly onClick?: () => void
    readonly disabled?: boolean
    readonly title?: string
  }
  export function Button(props: ButtonProps): ReactNode

  export interface ModalProps {
    readonly open?: boolean
    readonly onClose?: () => void
    readonly children?: ReactNode
    readonly className?: string
  }
  export function Modal(props: ModalProps): ReactNode
}

declare module '@deepseek-ai/dsh-client-store' {
  export interface SnapshotStore<T> {
    get(): T
    subscribe(listener: () => void): () => void
  }
}
