/**
 * The durable domain declaration.
 *
 * Everything here is the platform call; the shapes themselves live in
 * `schema.ts`, on the platform-free side of the boundary.
 *
 * `per-record` layout: records are small, independent, and individually
 * disposable, and scoping version checks per record means one stale document
 * cannot poison its siblings.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { bindingRecordSchema, bookRecordSchema } from './schema.ts'
import type { BindingRecord, BookRecord } from './schema.ts'

export const TAVERN_SEAT_DOMAIN = defineDomain({
  name: 'tavern_seat',
  version: 0,
  layout: 'per-record',
  tables: {
    bindings: domainTable<string, BindingRecord>(bindingRecordSchema),
    books: domainTable<string, BookRecord>(bookRecordSchema),
  },
})
