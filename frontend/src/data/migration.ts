import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import { CURRENT_SCHEMA_VERSION } from './types'
import type { EntryRow, MigrationMeta, ModuleMeta, StorageEnvelope } from './types'

// 存储结构迁移：localStorage 里最早一版直接平铺各模块数组，后来加了适用雨型、审核字段，
// 老数据一读就缺列。这里按版本逐段升级：缺字段补默认值、取不到的记录兜底重建、
// 调度方案按方案编号去重，并在信封与行上分别留下迁移标记。
// 已迁移到当前版本的数据不再做语义修改，所以重复打开是幂等的，不会重复迁移。

const MIGRATED_AT = new Date('2026-10-05T00:00:00+08:00').toISOString()

// 调度方案历史状态叫法不一，统一收敛到当前的状态机。
const DISPATCH_STATUS_ALIASES: Record<string, string> = {
  草稿: '待编制',
  未提交: '待编制',
  编制中: '待编制',
  待审批: '待审核',
  待批准: '待审核',
  审核中: '待审核',
  审批通过: '已批准',
  已通过: '已批准',
  批准: '已批准',
  作废: '已废止',
  已作废: '已废止',
  废止: '已废止',
}

// 调度方案各列缺省时的回填值：旧数据只有编号/名称时，页面也不能显示成空白。
const DISPATCH_FIELD_DEFAULTS: Record<string, string> = {
  适用雨型: '未指定雨型',
  涉及泵站: '未指定泵站',
  编制人: '未登记',
  审核人: '未审核',
  生效日期: '未生效',
}

const DISPATCH_MODULE_KEY = 'dispatchplan'
const MIGRATION_FLAG = '__migrated'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function pendingStatuses(meta: ModuleMeta): string[] {
  return meta.pendingStatuses ?? meta.statuses.slice(0, -1)
}

/** 旧状态值归一：认得出的别名映射到现状态机，认不出就回到「待编制」并由调用方记补字段。 */
function normalizeStatus(meta: ModuleMeta, raw: unknown): { status: string; repaired: boolean } {
  const value = String(raw ?? '').trim()
  if (value && meta.statuses.includes(value)) {
    return { status: value, repaired: false }
  }
  if (meta.key === DISPATCH_MODULE_KEY && value && DISPATCH_STATUS_ALIASES[value]) {
    return { status: DISPATCH_STATUS_ALIASES[value], repaired: true }
  }
  return { status: meta.statuses[0], repaired: true }
}

function fieldDefault(meta: ModuleMeta, field: string): string {
  if (meta.key === DISPATCH_MODULE_KEY && DISPATCH_FIELD_DEFAULTS[field] !== undefined) {
    return DISPATCH_FIELD_DEFAULTS[field]
  }
  return ''
}

/**
 * 把一条记录按当前模块字段补齐成 EntryRow。
 * migratedFrom 非 null（历史升级）时写迁移标记；为 null（当前版本）时静默兜底，不打标记。
 */
function normalizeRow(
  meta: ModuleMeta,
  raw: unknown,
  fallbackId: number,
  migratedFrom: number | null,
  mergedFrom: number[] = [],
): EntryRow {
  const backfilled: string[] = []
  const source = isRecord(raw) ? raw : {}
  if (!isRecord(raw)) {
    // 整条记录取不到（null/数组/标量），兜底重建并留下痕迹。
    backfilled.push('记录无法读取')
  }

  let id = Number(source.id)
  if (!Number.isInteger(id) || id <= 0) {
    id = fallbackId
    backfilled.push('id')
  }

  const { status, repaired: statusRepaired } = normalizeStatus(meta, source.status)
  if (statusRepaired) {
    backfilled.push('status')
  }

  const row: EntryRow = { id, status, pending: false, abnormal: false }

  for (const field of meta.fields) {
    const original = source[field]
    let value: unknown = original
    if (field === meta.statusField) {
      // 状态镜像列：缺失或写成了非状态值时，跟随归一后的状态。
      if (isBlank(original) || !meta.statuses.includes(String(original).trim())) {
        value = status
        backfilled.push(field)
      }
    } else if (isBlank(original)) {
      value = fieldDefault(meta, field)
      // 方案编号是业务主键，缺了按 id 生成一个，保证去重和详情页都能对上。
      if (meta.key === DISPATCH_MODULE_KEY && field === '方案编号') {
        value = `DISP-${String(id).padStart(4, '0')}`
      }
      backfilled.push(field)
    }
    row[field] = String(value).trim()
  }

  row.status = status
  // pending/abnormal 统一按当前状态机与标记口径重算，不采信旧版本的脏值。
  row.pending = pendingStatuses(meta).includes(status)
  row.abnormal = typeof source.abnormal === 'boolean' ? source.abnormal : false
  if (typeof source.abnormal !== 'boolean') {
    backfilled.push('abnormal')
  }
  backfilled.push('pending')

  if (migratedFrom !== null) {
    if (mergedFrom.length > 0) {
      backfilled.push('方案编号重复合并')
    }
    const fields = [...new Set(backfilled)]
    const marker: MigrationMeta = { migratedFrom, backfilledFields: fields }
    if (mergedFrom.length > 0) {
      marker.mergedFrom = mergedFrom
    }
    row[MIGRATION_FLAG] = marker
  }
  return row
}

type MergedRaw = { raw: unknown; mergedFrom: number[] }

/**
 * 调度方案在补字段之前，先按「原始方案编号」合并重复提交：
 * 同编号只保留 id 最小的一条做底，后到记录的非空字段并回保留条，被合并的 id 记入标记。
 * 缺编号、id 非法或整条坏掉的记录各自独立保留，交给字段补齐阶段兜底。
 */
function mergeDispatchRaw(rawRows: unknown[]): MergedRaw[] {
  type Group = { code: string; keeper: Record<string, unknown>; mergedIds: number[]; order: number }
  const groups: Group[] = []
  const byCode = new Map<string, Group>()
  const passthrough: { order: number; raw: unknown }[] = []

  rawRows.forEach((raw, index) => {
    if (!isRecord(raw)) {
      passthrough.push({ order: index, raw })
      return
    }
    const id = Number(raw.id)
    const code = String(raw['方案编号'] ?? '').trim()
    if (!Number.isInteger(id) || id <= 0 || !code) {
      passthrough.push({ order: index, raw })
      return
    }
    const existing = byCode.get(code)
    if (!existing) {
      const group: Group = { code, keeper: { ...raw }, mergedIds: [], order: index }
      byCode.set(code, group)
      groups.push(group)
      return
    }
    let base: Record<string, unknown>
    let extraId: number
    if (id < Number(existing.keeper.id)) {
      // 新到的 id 更小，改由它做底。
      base = { ...raw }
      extraId = Number(existing.keeper.id)
    } else {
      base = existing.keeper
      extraId = id
    }
    const donor = base === existing.keeper ? raw : existing.keeper
    for (const [field, value] of Object.entries(donor)) {
      if (field === 'id' || field === MIGRATION_FLAG) {
        continue
      }
      if (isBlank(base[field]) && !isBlank(value)) {
        base[field] = value
      }
    }
    existing.keeper = base
    existing.mergedIds.push(extraId)
  })

  const items: { order: number; item: MergedRaw }[] = groups.map((group) => ({
    order: group.order,
    item: { raw: group.keeper, mergedFrom: group.mergedIds.slice().sort((a, b) => a - b) },
  }))
  for (const { order, raw } of passthrough) {
    items.push({ order, item: { raw, mergedFrom: [] } })
  }
  return items.sort((a, b) => a.order - b.order).map((entry) => entry.item)
}

function seedModules(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

/**
 * 归一单个模块：数组读不出来就回退到空清单；
 * 调度方案先按方案编号合并原始重复记录，再逐条补字段。
 */
function normalizeModule(
  key: string,
  rawRows: unknown,
  migratedFrom: number | null,
): EntryRow[] {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta || !Array.isArray(rawRows)) {
    // 模块缺失或整段坏掉：未登记模块返回空；已登记模块兜底一条占位记录，页面读得到、不空白。
    if (migratedFrom !== null && meta) {
      const initial = meta.statuses[0]
      return [
        {
          id: 1,
          status: initial,
          pending: pendingStatuses(meta).includes(initial),
          abnormal: false,
          [MIGRATION_FLAG]: { migratedFrom, backfilledFields: ['模块数据缺失，已按空清单重建'] },
        },
      ]
    }
    return []
  }

  const sourceItems: MergedRaw[] =
    meta.key === DISPATCH_MODULE_KEY
      ? mergeDispatchRaw(rawRows as unknown[])
      : (rawRows as unknown[]).map((raw) => ({ raw, mergedFrom: [] }))

  let maxId = 0
  for (const item of rawRows as unknown[]) {
    const id = isRecord(item) ? Number(item.id) : NaN
    if (Number.isInteger(id) && id > maxId) {
      maxId = id
    }
  }

  return sourceItems.map(({ raw, mergedFrom }) => {
    if (!isRecord(raw) || !Number.isInteger(Number(raw.id)) || Number(raw.id) <= 0) {
      maxId += 1
    }
    return normalizeRow(meta, raw, maxId, migratedFrom, mergedFrom)
  })
}

/**
 * 当前版本（v2）数据的兜底修复：只修结构问题，不补业务默认值。
 * 合法行逐字段原样采信，保证用户操作后再打开结果稳定、不重复落盘；
 * 历史升级行（带迁移标记）更是一动都不能动。
 */
function repairCurrentRow(meta: ModuleMeta, raw: unknown, fallbackId: number): EntryRow {
  if (isRecord(raw) && hasMigrationFlag(raw)) {
    return raw as unknown as EntryRow
  }
  if (!isRecord(raw)) {
    // 整条坏掉：按默认值重建一条结构完整的占位行。
    return normalizeRow(meta, raw, fallbackId, null)
  }

  let id = Number(raw.id)
  if (!Number.isInteger(id) || id <= 0) {
    id = fallbackId
  }
  const { status, repaired: statusRepaired } = normalizeStatus(meta, raw.status)

  const row: EntryRow = {
    id,
    status,
    pending: typeof raw.pending === 'boolean' ? raw.pending : pendingStatuses(meta).includes(status),
    abnormal: typeof raw.abnormal === 'boolean' ? raw.abnormal : false,
  }
  for (const field of meta.fields) {
    if (field === meta.statusField) {
      const value = raw[field]
      // status 本身被修复过、镜像列缺失或写成非状态值时，镜像列跟随归一后的状态。
      if (statusRepaired || isBlank(value) || !meta.statuses.includes(String(value).trim())) {
        row[field] = status
      } else {
        row[field] = String(value).trim()
      }
    } else if (raw[field] !== undefined) {
      // 已有的业务列原样保留，缺失列就缺着（页面以「—」兜底显示），不塞默认值。
      row[field] = String(raw[field]).trim()
    }
  }
  return row
}

function hasMigrationFlag(record: Record<string, unknown>): boolean {
  return isRecord(record[MIGRATION_FLAG])
}

function repairCurrentModule(key: string, rawRows: unknown): { rows: EntryRow[]; changed: boolean } {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta || !Array.isArray(rawRows)) {
    return { rows: [], changed: true }
  }
  let maxId = 0
  for (const item of rawRows as unknown[]) {
    const id = isRecord(item) ? Number(item.id) : NaN
    if (Number.isInteger(id) && id > maxId) {
      maxId = id
    }
  }
  let changed = false
  const rows = (rawRows as unknown[]).map((raw) => {
    const before = isRecord(raw) ? JSON.stringify(raw) : ''
    if (!isRecord(raw) || !Number.isInteger(Number(raw.id)) || Number(raw.id) <= 0) {
      maxId += 1
    }
    const repaired = repairCurrentRow(meta, raw, maxId)
    if (isRecord(raw) && JSON.stringify(repaired) !== before) {
      changed = true
    } else if (!isRecord(raw)) {
      changed = true
    }
    return repaired
  })
  return { rows, changed }
}

function freshEnvelope(): StorageEnvelope {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    migratedFromVersion: null,
    migratedAt: null,
    modules: seedModules(),
  }
}

export type MigrationResult = {
  envelope: StorageEnvelope
  /** 是否与落盘内容不同，需要重新写回 localStorage。 */
  changed: boolean
  /** 本次读入是否发生过历史结构升级（当前版本数据的静默修复不算）。 */
  migrated: boolean
  fromVersion: number | null
}

/**
 * 迁移入口（纯函数）：
 * - 认不出结构 / 解析失败 → 回到当前版本示例数据；
 * - 平铺数组的旧版数据 → 逐模块、逐记录补齐并去重，信封记录迁移来源与时间；
 * - 已经是当前版本 → 已迁移行原样采信，其余只做稳定的兜底修复，因此重复打开不会重复迁移。
 */
export function migrateStorage(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    return { envelope: freshEnvelope(), changed: true, migrated: false, fromVersion: null }
  }

  // 已经是版本化信封。
  if (typeof raw.schemaVersion === 'number') {
    if (raw.schemaVersion >= CURRENT_SCHEMA_VERSION) {
      const stored = isRecord(raw.modules) ? raw.modules : {}
      const modules = seedModules()
      let changed = false
      const keys = [...new Set([...Object.keys(modules), ...Object.keys(stored)])]
      for (const key of keys) {
        if (!MODULE_BY_KEY.has(key)) {
          // 未登记模块不在迁移范围内，数组原样保留，其它形态不采信。
          if (Array.isArray(stored[key])) {
            modules[key] = (stored[key] as EntryRow[]).slice()
          }
          continue
        }
        const { rows, changed: moduleChanged } = repairCurrentModule(
          key,
          Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : [],
        )
        modules[key] = rows
        if (moduleChanged) {
          changed = true
        }
      }
      const envelope: StorageEnvelope = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        migratedFromVersion:
          typeof raw.migratedFromVersion === 'number' ? raw.migratedFromVersion : null,
        migratedAt: typeof raw.migratedAt === 'string' ? raw.migratedAt : null,
        modules,
      }
      return {
        envelope,
        changed,
        migrated: false,
        fromVersion: envelope.migratedFromVersion,
      }
    }
    return runUpgrade(isRecord(raw.modules) ? raw.modules : {}, raw.schemaVersion)
  }

  // 没有版本号但形态是「模块键 -> 数组」，按最早的 v1 处理。
  const looksLikeFlatModules = Object.values(raw).some((value) => Array.isArray(value))
  if (!looksLikeFlatModules) {
    return { envelope: freshEnvelope(), changed: true, migrated: false, fromVersion: null }
  }
  return runUpgrade(raw, 1)
}

function runUpgrade(stored: Record<string, unknown>, fromVersion: number): MigrationResult {
  const modules = seedModules()
  // 未登记模块的数据原样带过去，不丢用户历史。
  for (const [key, value] of Object.entries(stored)) {
    if (!MODULE_BY_KEY.has(key) && Array.isArray(value)) {
      modules[key] = value.slice() as EntryRow[]
    }
  }
  for (const key of Object.keys(SEED_ROWS)) {
    modules[key] = normalizeModule(
      key,
      Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : [],
      fromVersion,
    )
  }
  return {
    envelope: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migratedFromVersion: fromVersion,
      migratedAt: MIGRATED_AT,
      modules,
    },
    changed: true,
    migrated: true,
    fromVersion,
  }
}
