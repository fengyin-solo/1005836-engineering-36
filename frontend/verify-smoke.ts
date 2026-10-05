// 端到端冒烟：模拟真实用户浏览器（localStorage 里是最早一版平铺数据）首次打开应用。
import { writeFileSync } from 'node:fs'

const store = new Map<string, string>()
globalThis.window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
} as unknown as Window & typeof globalThis

const STORAGE_KEY = 'drainage-pump:entries'
let failures = 0
const assert = (cond: boolean, msg: string) => {
  console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`)
  if (!cond) failures++
}

async function main() {
  // 用户机器上现存的是「最早一版」结构：没有适用雨型、审核人，甚至有重复编号和坏行。
  const legacy = {
    dispatchplan: [
      { id: 1, status: '待编制', pending: true, abnormal: false, 方案编号: 'FA-01', 方案名称: '旧版小雨方案' },
      { id: 2, status: '待审核', pending: true, abnormal: false, 方案编号: 'FA-02', 方案名称: '旧版中雨方案', 适用雨型: '中雨' },
      { id: 3, status: '待编制', pending: true, abnormal: false, 方案编号: 'FA-01', 方案名称: '重复提交', 适用雨型: '小雨' },
    ],
  }
  store.set(STORAGE_KEY, JSON.stringify(legacy))

  // 应用启动后页面第一次读数据
  const service = await import('./src/api/local-service.ts')

  console.log('首次打开：列表页数据')
  const list = service.listEntries('dispatchplan')
  assert(list.total === 2, `重复编号合并后 2 条（实际 ${list.total}）`)
  const fa01 = list.items.find((r) => r['方案编号'] === 'FA-01')!
  assert(fa01['方案名称'] === '旧版小雨方案', '保留最早一条的名称')
  assert(fa01['适用雨型'] === '小雨', '适用雨型从重复记录并回，页面不再空白')
  assert(fa01['审核人'] === '未审核', '审核字段用默认值补齐')
  assert(!!fa01.__migrated, '留有迁移标记')

  console.log('清单 / 详情 / 概览读数一致')
  const detail = service.getEntry('dispatchplan', fa01.id)!
  assert(detail['方案名称'] === fa01['方案名称'], '详情页名称与列表一致')
  assert(detail['适用雨型'] === fa01['适用雨型'], '详情页适用雨型与列表一致')
  const overviewPending = service.loadOverview().modules.find((m) => m.name === '排水调度方案')!.pending
  const counterPending = service.countByStatus('dispatchplan')['待审核']
  assert(overviewPending === counterPending && counterPending === 1, `待审核三处一致 = ${counterPending}`)

  console.log('状态机：FA-01 待编制必须先提交才能批准')
  assert(service.runAction('dispatchplan', fa01.id, '批准方案').ok === false, '跳级批准被拒绝')
  assert(service.runAction('dispatchplan', fa01.id, '提交编制').ok === true, '提交编制成功')
  assert(service.runAction('dispatchplan', fa01.id, '批准方案').ok === true, '随后批准成功')

  console.log('重复登记被拦截')
  const dup = service.createEntry('dispatchplan', { 方案编号: 'FA-02', 方案名称: '再提一次' })
  assert(dup.ok === false, '同编号二次登记被拒')
  const created = service.createEntry('dispatchplan', { 方案编号: 'FA-03', 方案名称: '新方案', 适用雨型: '雷阵雨' })
  assert(created.ok === true, '新编号登记成功')

  console.log('刷新/重开：落盘内容已版本化且再次读取零改动')
  const persisted = JSON.parse(store.get(STORAGE_KEY)!)
  assert(persisted.schemaVersion === 2, '落盘为 v2 信封')
  const { migrateStorage } = await import('./src/data/migration.ts')
  const secondOpen = migrateStorage(persisted)
  assert(secondOpen.migrated === false && secondOpen.changed === false, '重开不重复迁移、不重写')

  console.log('重置模块：回到干净的当前版本种子')
  service.resetModule('dispatchplan')
  const reset = service.listEntries('dispatchplan')
  assert(reset.items.every((r) => !r.__migrated), '重置后无迁移标记')
  assert(reset.items.every((r) => ['待编制', '待审核', '已批准'].includes(String(r.status))), '种子状态合法')
  const resetCounter = service.countByStatus('dispatchplan')
  assert(resetCounter['待审核'] === 1, '种子待审核 1 条')

  writeFileSync('tmp/smoke-result.txt', failures === 0 ? 'PASS\n' : `FAIL ${failures}\n`)
  console.log(failures === 0 ? '\n冒烟通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
