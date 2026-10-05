/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 历史数据回填时挂在记录上的迁移标记：能看出一条记录从哪个版本来、补过哪些字段。 */
export type MigrationMeta = {
  /** 迁移前记录所处的存储结构版本；新版本写入的记录没有这个标记。 */
  migratedFrom: number
  /** 本次迁移补齐或修正过的字段名，没动过任何字段就是空数组。 */
  backfilledFields: string[]
  /** 去重时被合并掉的同方案编号记录 id。 */
  mergedFrom?: number[]
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 迁移标记：只在历史数据升级后的记录上出现，天然保证重复打开不会再次迁移。 */
  __migrated?: MigrationMeta
  [field: string]: string | number | boolean | string[] | MigrationMeta | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 业务字段里镜像状态的那一列（如「方案状态」），流转时一并同步。 */
  statusField?: string
  /** 概览里算「待处理」时认哪些状态；不配置时沿用旧口径（除最后一个状态外都算）。 */
  pendingStatuses?: string[]
  /**
   * 允许的状态流转：当前状态 -> 可动作到的目标状态。
   * 不配置时沿用旧行为（任何登记动作都可执行）。
   * 终态「已废止」不在这里，只有已批准方案允许废止，单独在 dispatchplan 上声明。
   */
  transitions?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** localStorage 里的版本化信封：v1 是直接平铺的 Record<string, EntryRow[]>。 */
export type StorageEnvelope = {
  schemaVersion: number
  /** 历史数据升级时记录原版本；首次播种或重置后为 null。 */
  migratedFromVersion: number | null
  migratedAt: string | null
  modules: Record<string, EntryRow[]>
}

export const CURRENT_SCHEMA_VERSION = 2
