import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { isStatusPending } from '@/data/migrations'
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

/** 详情读取：迁移后清单与详情共用同一份存储，名称、适用雨型等字段天然对得上。 */
export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === Number(id)) ?? null
}

/** 各状态计数：清单状态图例、详情与统计卡统一从这里取数。 */
export function statusCounts(key: string): Record<string, number> {
  const meta = moduleMeta(key)
  const counts: Record<string, number> = Object.fromEntries(
    meta.statuses.map((status) => [status, 0]),
  )
  for (const row of listRows(key)) {
    const status = String(row.status)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

/** 待处理/待审核数的唯一口径：配置了 pendingStatus 的模块按状态统计，其余沿用 pending 标记。 */
export function pendingCount(key: string): number {
  const meta = moduleMeta(key)
  return listRows(key).filter((row) => isStatusPending(meta, String(row.status))).length
}

/** 模块统计卡：指标名里包含某个状态名时按该状态计数，保证与清单、概览读到的数字一致。 */
export function metricStats(key: string): { label: string; value: number }[] {
  const meta = moduleMeta(key)
  const counts = statusCounts(key)
  return meta.metrics.map((label) => {
    const hit = meta.statuses.find((status) => label.includes(status))
    return { label, value: hit ? counts[hit] ?? 0 : 0 }
  })
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
  // 状态机：只允许从登记的前置状态发起，杜绝跳级（如待编制直接批准）。
  const allowed = meta.actionAllowed?.[action]
  if (allowed && !allowed.includes(current)) {
    return {
      ok: false,
      message: `「${action}」只能从${allowed.join('、')}状态发起，当前是「${current}」，不能跳级流转`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isStatusPending(meta, target, rows[index].pending as boolean | undefined),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 调度方案登记表单允许填写的字段（审核字段由审批流写入，登记时不开放）。
export type PlanDraft = {
  方案编号: string
  方案名称: string
  适用雨型: string
  涉及泵站: string
  编制人: string
  生效日期: string
}

/**
 * 登记/更新调度方案。
 * 方案编号是业务主键：编号重复的提交只更新原方案、只保留一条，不会新增第二行。
 */
export function submitPlan(draft: PlanDraft): ActionResult & { id?: number } {
  const code = draft['方案编号'].trim()
  const name = draft['方案名称'].trim()
  if (!code) {
    return { ok: false, message: '方案编号不能为空' }
  }
  if (!name) {
    return { ok: false, message: '方案名称不能为空' }
  }

  const rows = listRows('dispatchplan')
  const existing = rows.find((row) => String(row['方案编号']).trim() === code)
  const editable: (keyof PlanDraft)[] = ['方案名称', '适用雨型', '涉及泵站', '编制人', '生效日期']

  if (existing) {
    const index = rows.indexOf(existing)
    const merged: EntryRow = { ...existing }
    for (const field of editable) {
      const value = draft[field].trim()
      if (value) {
        merged[field] = value
      }
    }
    // 可编辑字段更新，但状态与审核字段保持原样，不回退审批流。
    const next = [...rows]
    next[index] = merged
    saveRows('dispatchplan', next)
    return {
      ok: true,
      id: Number(merged.id),
      message: `方案编号 ${code} 已存在，已更新原方案记录（不重复新增），当前状态「${merged.status}」`,
    }
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const created: EntryRow = {
    id,
    status: '待编制',
    pending: false,
    abnormal: false,
    方案编号: code,
    方案名称: name,
    适用雨型: draft['适用雨型'].trim() || '未指定雨型',
    涉及泵站: draft['涉及泵站'].trim() || '—',
    编制人: draft['编制人'].trim() || '未填报',
    审核人: '未分配',
    生效日期: draft['生效日期'].trim() || '—',
    方案状态: '待编制',
  }
  saveRows('dispatchplan', [...rows, created])
  return { ok: true, id, message: `调度方案 ${code} 已登记，进入「待编制」状态` }
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
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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
    return {
      name: meta.name,
      created: entries.length,
      // 与清单、详情同一口径：调度方案只统计「待审核」。
      pending: entries.filter((row) => isStatusPending(meta, String(row.status))).length,
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
