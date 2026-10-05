import { migrateStorage } from './migration'
import { SEED_ROWS } from './seed'
import { CURRENT_SCHEMA_VERSION } from './types'
import type { EntryRow, StorageEnvelope } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 结构按 schemaVersion 版本化；读入旧版本数据时先迁移再对外提供，详见 data/migration.ts。
const STORAGE_KEY = 'drainage-pump:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function freshEnvelope(): StorageEnvelope {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    migratedFromVersion: null,
    migratedAt: null,
    modules: clone(SEED_ROWS),
  }
}

function persist(envelope: StorageEnvelope): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  }
}

function readStorage(): StorageEnvelope {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshEnvelope()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshEnvelope()
    persist(seeded)
    return seeded
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 存的内容坏到无法解析：兜底回到示例数据，保证页面能打开。
    const seeded = freshEnvelope()
    persist(seeded)
    return seeded
  }
  // 旧版平铺数据 / 缺字段数据在这里统一升级；changed 时落盘，重复打开因版本已是最新而不再迁移。
  const result = migrateStorage(parsed)
  if (result.changed) {
    persist(result.envelope)
  }
  return result.envelope
}

let cache: StorageEnvelope | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache.modules
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (cache === null) {
    cache = readStorage()
  }
  const next: StorageEnvelope = {
    ...cache,
    modules: { ...cache.modules, [key]: rows },
  }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function currentSchemaVersion(): number {
  return CURRENT_SCHEMA_VERSION
}
