import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

/** 模块里算「待处理」的状态集合：调度方案只认待审核，其它模块沿用除终态外的旧口径。 */
export function pendingStatusesOf(meta: ModuleMeta): string[] {
  return meta.pendingStatuses ?? meta.statuses.slice(0, -1)
}

/** 按状态统计记录数：清单、详情、概览三处共用同一口径，待审核数不会对不上。 */
export function countByStatus(key: string): Record<string, number> {
  const meta = moduleMeta(key)
  const counter: Record<string, number> = {}
  for (const status of meta.statuses) {
    counter[status] = 0
  }
  for (const row of listRows(key)) {
    const status = String(row.status)
    counter[status] = (counter[status] ?? 0) + 1
  }
  return counter
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function getEntry(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/**
 * 登记一条新记录。调度方案按「方案编号」去重：编号已存在就拒绝写入，
 * 配合历史数据迁移时的合并，保证同一方案编号在库里只有一条。
 */
export function createEntry(
  key: string,
  fields: Record<string, string>,
): ActionResult & { id?: number } {
  const meta = moduleMeta(key)
  const data: Record<string, string> = {}
  for (const field of meta.fields) {
    const value = String(fields[field] ?? '').trim()
    if (value) {
      data[field] = value
    }
  }

  const rows = listRows(key)
  const codeField = meta.fields[0]
  if (!data[codeField]) {
    return { ok: false, message: `${codeField}不能为空` }
  }
  const duplicated = rows.some(
    (row) => String(row[codeField] ?? '').trim() === data[codeField],
  )
  if (duplicated) {
    return { ok: false, message: `${codeField}「${data[codeField]}」已存在，重复提交只保留一条` }
  }

  const status = meta.statuses[0]
  const id = nextId(rows)
  const created: EntryRow = {
    id,
    status,
    pending: pendingStatusesOf(meta).includes(status),
    abnormal: false,
    ...data,
  }
  if (meta.statusField) {
    created[meta.statusField] = status
  }
  // 方案编号缺失兜底（前面已校验，这里只防其它模块字段顺序异常）。
  if (meta.key === 'dispatchplan' && !created['方案名称']) {
    created['方案名称'] = `调度方案-${id}`
  }
  saveRows(key, [...rows, created])
  return { ok: true, message: `${meta.entity}已登记，当前状态「${status}」`, id }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 调度方案：待编制 → 待审核 → 已批准依次流转，不允许跳级；废止仅已批准可执行。
  if (meta.transitions) {
    const allowed = meta.transitions[current]
    if (!allowed || !allowed.includes(target)) {
      return {
        ok: false,
        message: `${meta.entity}当前为「${current}」，不能直接流转到「${target}」，请按状态顺序操作`,
      }
    }
  }
  const pendingSet = pendingStatusesOf(meta)
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: pendingSet.includes(target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 业务字段里的状态列与流转状态同步，列表与详情看到的方案状态保持一致。
  if (meta.statusField) {
    updated[meta.statusField] = target
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    const pendingSet = pendingStatusesOf(meta)
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => pendingSet.includes(String(row.status))).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
