import { MODULE_BY_KEY } from './modules'
import type { EntryRow, ModuleMeta } from './types'

// 存储结构版本：老数据读入时按版本逐级迁移，迁移结果落库后重复打开不再处理。
export const SCHEMA_VERSION = 2

// 行内迁移标记（不会出现在任何页面字段列里，只用于详情页提示与幂等判断）
export const MARKER_MIGRATED_FROM = '__migratedFrom'
export const MARKER_REPAIRED = '__repaired'
export const MARKER_MERGED = '__mergedDuplicates'
export const MARKER_MIGRATED_AT = '__migratedAt'

export type MigrationRecord = {
  at: string
  module: string
  from: number | null
  to: number
  kind: 'upgrade' | 'repair' | 'merge' | 'rollback'
  rows?: number
  fields?: string[]
  message: string
}

export type StoreEnvelope = {
  schemaVersion: number
  modules: Record<string, EntryRow[]>
  migrationLog: MigrationRecord[]
}

// 新结构里各业务字段缺失时的默认值：旧数据「适用雨型、审核人」等后加字段读进来按这里补齐。
const FIELD_DEFAULTS: Record<string, Record<string, string>> = {
  dispatchplan: {
    方案名称: '未命名调度方案',
    适用雨型: '未指定雨型',
    涉及泵站: '—',
    编制人: '未填报',
    审核人: '未分配',
    生效日期: '—',
  },
}

const GENERIC_FIELD_DEFAULT = '—'

// 方案状态字段是行状态的镜像，迁移与写入时始终与 status 对齐。
const STATUS_MIRROR_FIELD: Record<string, string> = {
  dispatchplan: '方案状态',
}

function fieldDefault(meta: ModuleMeta, field: string): string {
  return FIELD_DEFAULTS[meta.key]?.[field] ?? GENERIC_FIELD_DEFAULT
}

function isValidStatus(meta: ModuleMeta, value: unknown): value is string {
  return typeof value === 'string' && value !== '' && meta.statuses.includes(value)
}

/** 统一口径：处于 pendingStatus（调度方案为「待审核」）才算待处理。 */
export function isStatusPending(meta: ModuleMeta, status: string, legacy?: boolean): boolean {
  if (meta.pendingStatus) {
    return status === meta.pendingStatus
  }
  return legacy ?? status !== meta.statuses[meta.statuses.length - 1]
}

type NormalizeResult = {
  row: EntryRow
  repaired: boolean
  filledFields: string[]
  invalidStatus: boolean
}

/**
 * 把任意历史值归一成当前结构的一行。
 * 取不到（null/非对象/关键字段缺失）的历史记录在这里兜底补齐，而不是让页面读到空白。
 */
function normalizeRow(
  meta: ModuleMeta,
  raw: unknown,
  nextId: number,
  stamp: string,
): NormalizeResult {
  const source = raw && typeof raw === 'object' ? (raw as EntryRow) : null
  const repaired = source === null
  const filledFields: string[] = []

  const rawId = Number(source?.id)
  const validId = Number.isInteger(rawId) && rawId > 0
  if (!validId) {
    filledFields.push('id')
  }
  const id = validId ? rawId : nextId

  const invalidStatus = !isValidStatus(meta, source?.status)
  if (invalidStatus) {
    filledFields.push('status')
  }
  const status = isValidStatus(meta, source?.status)
    ? String(source.status)
    : meta.statuses[0]

  const row: EntryRow = { id, status, pending: false, abnormal: false }

  for (const field of meta.fields) {
    if (STATUS_MIRROR_FIELD[meta.key] === field) {
      row[field] = status
      if (source && source[field] !== status) {
        filledFields.push(field)
      }
      continue
    }
    const incoming = source?.[field]
    if (incoming === undefined || incoming === null || incoming === '') {
      row[field] = fieldDefault(meta, field)
      filledFields.push(field)
    } else {
      row[field] = incoming as string | number
    }
  }

  // 方案编号是去重主键：历史记录里取不到也补一个可识别的唯一编号。
  if (meta.key === 'dispatchplan') {
    const code = String(row['方案编号'] ?? '').trim()
    if (!code || code === GENERIC_FIELD_DEFAULT) {
      row['方案编号'] = `DISP-补${String(id).padStart(4, '0')}`
      if (!filledFields.includes('方案编号')) {
        filledFields.push('方案编号')
      }
    } else {
      row['方案编号'] = code
    }
  }

  if (source && typeof source.abnormal === 'boolean') {
    row.abnormal = source.abnormal
  } else {
    row.abnormal = false
    filledFields.push('abnormal')
  }

  if (source && typeof source.pending === 'boolean') {
    row.pending = isStatusPending(meta, status, source.pending)
  } else {
    row.pending = isStatusPending(meta, status)
    filledFields.push('pending')
  }

  // 行上已有的迁移标记原样保留：v2→v2 的防御性读取不能把历史标记冲掉。
  for (const marker of [MARKER_MIGRATED_FROM, MARKER_REPAIRED, MARKER_MERGED, MARKER_MIGRATED_AT]) {
    const carried = source?.[marker]
    if (carried !== undefined && carried !== null) {
      row[marker] = carried as string | number | boolean
    }
  }

  if (repaired) {
    row[MARKER_REPAIRED] = true
    row[MARKER_MIGRATED_AT] = stamp
  }

  return { row, repaired, filledFields: [...new Set(filledFields)], invalidStatus }
}

function isEntryRowArray(value: unknown): value is EntryRow[] {
  return Array.isArray(value)
}

/** 规范化一个模块的整表：只做补齐，不打版本标记（新播种数据与日常写入共用）。 */
export function canonicalRows(meta: ModuleMeta, raws: unknown[]): EntryRow[] {
  let seq = 0
  const usedIds = new Set<number>()
  const out: EntryRow[] = []
  for (const raw of raws) {
    seq += 1
    let candidate = normalizeRow(meta, raw, seq, '')
    while (usedIds.has(Number(candidate.row.id))) {
      seq += 1
      candidate = normalizeRow(meta, { ...(raw as EntryRow), id: seq }, seq, '')
    }
    usedIds.add(Number(candidate.row.id))
    seq = Math.max(seq, Number(candidate.row.id))
    out.push(candidate.row)
  }
  return mergeDuplicatePlans(meta, out).rows
}

type MergeResult = { rows: EntryRow[]; dropped: number }

// 方案编号重复只留一条：保留最早一条，重复记录上的非默认值回填给保留行。
function mergeDuplicatePlans(meta: ModuleMeta, rows: EntryRow[], stamp?: string): MergeResult {
  if (meta.key !== 'dispatchplan') {
    return { rows, dropped: 0 }
  }
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const code = String(row['方案编号']).trim()
    const list = groups.get(code) ?? []
    list.push(row)
    groups.set(code, list)
  }
  if ([...groups.values()].every((list) => list.length === 1)) {
    return { rows, dropped: 0 }
  }

  const defaults = FIELD_DEFAULTS[meta.key] ?? {}
  const kept: EntryRow[] = []
  let dropped = 0
  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => Number(a.id) - Number(b.id))
    const survivor = ordered[0] as EntryRow
    if (ordered.length > 1) {
      for (const dup of ordered.slice(1)) {
        for (const field of meta.fields) {
          const current = String(survivor[field] ?? '')
          const candidate = String(dup[field] ?? '')
          if (candidate && current === (defaults[field] ?? GENERIC_FIELD_DEFAULT)) {
            survivor[field] = candidate
          }
        }
        dropped += 1
      }
      survivor[MARKER_MERGED] = Number(survivor[MARKER_MERGED] ?? 0) + ordered.length - 1
      if (stamp) {
        survivor[MARKER_MIGRATED_AT] = stamp
      }
    }
    kept.push(survivor)
  }
  return { rows: kept.sort((a, b) => Number(a.id) - Number(b.id)), dropped }
}

export function canonicalEnvelope(
  seed: Record<string, EntryRow[]>,
  modules?: Record<string, unknown[]>,
): StoreEnvelope {
  const merged: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(seed)) {
    const meta = MODULE_BY_KEY.get(key)
    const raws = modules?.[key] ?? seed[key]
    merged[key] = meta ? canonicalRows(meta, raws) : (raws as EntryRow[])
  }
  return { schemaVersion: SCHEMA_VERSION, modules: merged, migrationLog: [] }
}

function isEnvelope(value: unknown): value is StoreEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoreEnvelope).schemaVersion === 'number' &&
    typeof (value as StoreEnvelope).modules === 'object'
  )
}

type Loaded = { envelope: StoreEnvelope; changed: boolean }

/**
 * 读入浏览器里的任意历史存储，升级到当前结构。
 * - 老结构（无版本的纯模块表）按 v1 处理，逐级迁移；
 * - 迁移补齐的字段、合并的重复编号都落库并留痕；
 * - 已经是当前版本的记录原样返回，重复打开不重复迁移。
 */
export function loadEnvelope(parsed: unknown, seed: Record<string, EntryRow[]>): Loaded {
  const stamp = new Date().toISOString()
  const log: MigrationRecord[] = []
  let changed = false

  let fromVersion: number
  let storedModules: Record<string, unknown[]>

  if (parsed === null || parsed === undefined) {
    return { envelope: canonicalEnvelope(seed), changed: false }
  }

  if (isEnvelope(parsed)) {
    fromVersion = parsed.schemaVersion
    storedModules = parsed.modules as Record<string, unknown[]>
    log.push(...(Array.isArray(parsed.migrationLog) ? parsed.migrationLog : []))
  } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    // 最早一版：localStorage 里直接存 { 模块key: 行数组 }，没有版本信封。
    fromVersion = 1
    storedModules = parsed as Record<string, unknown[]>
  } else {
    const fallback = canonicalEnvelope(seed)
    fallback.migrationLog = [
      {
        at: stamp,
        module: '*',
        from: null,
        to: SCHEMA_VERSION,
        kind: 'rollback',
        message: '存储结构无法识别，已回退为内置示例数据',
      },
    ]
    return { envelope: fallback, changed: true }
  }

  // 新上线的模块老存储里没有，按内置数据补齐（与历史 { ...fallback, ...parsed } 行为一致）。
  const moduleKeys = [...new Set([...Object.keys(seed), ...Object.keys(storedModules)])]
  const upgraded: Record<string, EntryRow[]> = {}

  for (const key of moduleKeys) {
    const meta = MODULE_BY_KEY.get(key)
    const raws = isEntryRowArray(storedModules[key])
      ? storedModules[key]
      : (seed[key] ?? [])

    if (!meta) {
      upgraded[key] = raws as EntryRow[]
      continue
    }

    const isUpgradeStep = fromVersion < SCHEMA_VERSION
    let seq = 0
    const usedIds = new Set<number>()
    const rows: EntryRow[] = []
    let touched = 0
    let repaired = 0
    const fieldSet = new Set<string>()

    for (const raw of raws) {
      seq += 1
      let result = normalizeRow(meta, raw, seq, stamp)
      while (usedIds.has(Number(result.row.id))) {
        seq += 1
        const source = raw && typeof raw === 'object' ? (raw as EntryRow) : {}
        result = normalizeRow(meta, { ...source, id: seq }, seq, stamp)
      }
      usedIds.add(Number(result.row.id))
      seq = Math.max(seq, Number(result.row.id))

      // 版本升级：参与迁移的行全部打上来源版本标记；防御性补齐（v2→v2）只标记真正动过的行。
      if (isUpgradeStep) {
        result.row[MARKER_MIGRATED_FROM] = fromVersion
        result.row[MARKER_MIGRATED_AT] = stamp
        touched += 1
        result.filledFields.forEach((f) => fieldSet.add(f))
      } else if (result.filledFields.length > 0) {
        result.row[MARKER_REPAIRED] = true
        result.row[MARKER_MIGRATED_AT] = stamp
        touched += 1
        result.filledFields.forEach((f) => fieldSet.add(f))
      }
      if (result.repaired) {
        repaired += 1
      }
      rows.push(result.row)
    }

    const mergeStamp = isUpgradeStep || touched > 0 ? stamp : undefined
    const { rows: mergedRows, dropped } = mergeDuplicatePlans(meta, rows, mergeStamp)
    upgraded[key] = mergedRows

    if (fieldSet.size > 0 || repaired > 0) {
      log.push({
        at: stamp,
        module: key,
        from: fromVersion < SCHEMA_VERSION ? fromVersion : null,
        to: SCHEMA_VERSION,
        kind: 'upgrade',
        rows: touched,
        fields: [...fieldSet],
        message:
          fromVersion < SCHEMA_VERSION
            ? `结构 v${fromVersion} → v${SCHEMA_VERSION}：补齐缺失字段`
            : '读取时防御性补齐缺失字段',
      })
      changed = true
    }
    if (repaired > 0) {
      log.push({
        at: stamp,
        module: key,
        from: fromVersion < SCHEMA_VERSION ? fromVersion : null,
        to: SCHEMA_VERSION,
        kind: 'repair',
        rows: repaired,
        message: `${repaired} 条取不到的历史记录已按默认值兜底补齐`,
      })
      changed = true
    }
    if (dropped > 0) {
      log.push({
        at: stamp,
        module: key,
        from: fromVersion < SCHEMA_VERSION ? fromVersion : null,
        to: SCHEMA_VERSION,
        kind: 'merge',
        rows: dropped,
        fields: ['方案编号'],
        message: `合并 ${dropped} 条方案编号重复的历史记录，每个编号只保留一条`,
      })
      changed = true
    }
    if (isUpgradeStep && fieldSet.size === 0 && repaired === 0 && dropped === 0) {
      // 字段齐全的模块同样记录一次结构升级，便于在详情/调试时核对版本。
      log.push({
        at: stamp,
        module: key,
        from: fromVersion,
        to: SCHEMA_VERSION,
        kind: 'upgrade',
        rows: raws.length,
        message: `结构 v${fromVersion} → v${SCHEMA_VERSION} 迁移完成`,
      })
    }
    if (isUpgradeStep) {
      changed = true
    }
  }

  if (fromVersion !== SCHEMA_VERSION) {
    changed = true
  }

  return {
    envelope: { schemaVersion: SCHEMA_VERSION, modules: upgraded, migrationLog: log },
    changed,
  }
}

export function migrationMarkers(row: EntryRow): { migrated: boolean; repaired: boolean; merged: number } {
  return {
    migrated: row[MARKER_MIGRATED_FROM] !== undefined,
    repaired: Boolean(row[MARKER_REPAIRED]),
    merged: Number(row[MARKER_MERGED] ?? 0),
  }
}
