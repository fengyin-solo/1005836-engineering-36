import {
  canonicalEnvelope,
  canonicalRows,
  loadEnvelope,
  SCHEMA_VERSION,
  type StoreEnvelope,
} from './migrations'
import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
// 结构以信封形式存储（schemaVersion + modules + migrationLog），旧结构读入时自动迁移。
const STORAGE_KEY = 'drainage-pump:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: StoreEnvelope | null = null

function freshEnvelope(): StoreEnvelope {
  return canonicalEnvelope(clone(SEED_ROWS))
}

function writeEnvelope(envelope: StoreEnvelope): void {
  cache = envelope
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  }
}

function readStorage(): StoreEnvelope {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshEnvelope()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshEnvelope()
    writeEnvelope(seeded)
    return seeded
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const fallback = freshEnvelope()
    fallback.migrationLog = [
      {
        at: new Date().toISOString(),
        module: '*',
        from: null,
        to: SCHEMA_VERSION,
        kind: 'rollback',
        message: '存储内容无法解析，已回退为内置示例数据',
      },
    ]
    writeEnvelope(fallback)
    return fallback
  }

  // 任意历史结构都交给迁移引擎：旧版本逐级升级，缺字段补齐，重复方案编号合并。
  const { envelope, changed } = loadEnvelope(parsed, SEED_ROWS)
  if (changed) {
    writeEnvelope(envelope)
  } else {
    cache = envelope
  }
  return envelope
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/** 写入前按当前结构规范化一次，保证落库数据与迁移后结构一致。 */
function normalizeForWrite(key: string, rows: EntryRow[]): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    return rows
  }
  return canonicalRows(meta, rows)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const envelope = cache ?? readStorage()
  const next: StoreEnvelope = {
    ...envelope,
    modules: { ...envelope.modules, [key]: normalizeForWrite(key, rows) },
  }
  writeEnvelope(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = canonicalRows(MODULE_BY_KEY.get(key)!, clone(SEED_ROWS[key] ?? []))
  saveRows(key, rows)
  return rows
}

export function migrationLog(): StoreEnvelope['migrationLog'] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.migrationLog
}

export function schemaVersion(): number {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.schemaVersion
}

export function storageKey(): string {
  return STORAGE_KEY
}
