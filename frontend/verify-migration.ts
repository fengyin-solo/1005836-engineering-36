// 临时验证脚本：用内存 localStorage 模拟老数据，覆盖迁移/幂等/流转/去重/统计一致性。
import { mkdirSync, writeFileSync } from 'node:fs'

// 最小浏览器环境桩
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

function seedOldStorage() {
  // 最早一版：直接平铺模块数组；dispatchplan 只有方案编号/名称，没有适用雨型、审核字段
  const old = {
    dispatchplan: [
      {
        id: 1,
        status: '待编制',
        pending: true,
        abnormal: false,
        方案编号: 'DISP-1001',
        方案名称: '老城区小雨方案',
        // 缺：适用雨型/涉及泵站/编制人/审核人/生效日期/方案状态
      },
      {
        id: 2,
        status: '待审批', // 历史别名
        pending: true,
        abnormal: false,
        方案编号: 'DISP-1002',
        方案名称: '城南中雨方案',
        适用雨型: '中雨',
        涉及泵站: '城南二号',
        编制人: '张三',
        // 缺审核人/生效日期/方案状态
      },
      { id: 3, status: '已批准', pending: false, abnormal: false, 方案编号: 'DISP-1003', 方案名称: '暴雨联调方案' },
      // 重复编号：重复提交只留一条
      { id: 4, status: '待审核', pending: true, abnormal: false, 方案编号: 'DISP-1001', 方案名称: '', 适用雨型: '小雨' },
      // 整条坏掉、取不到的历史记录：兜底补齐
      null,
      { id: 'x', status: '乱写的状态', 方案编号: '', 方案名称: '编号坏掉的方案' },
    ],
    pumpstation: [
      { id: 1, status: '运行中', pending: true, abnormal: false, 站名: '一号泵站' },
    ],
  }
  store.set(STORAGE_KEY, JSON.stringify(old))
}

let failures = 0
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log('  ✓', msg)
  } else {
    failures++
    console.error('  ✗', msg)
  }
}

async function main() {
  const { migrateStorage } = await import('./src/data/migration.ts')
  const { CURRENT_SCHEMA_VERSION } = await import('./src/data/types.ts')
  // 存储层在首次 allRows() 时读盘迁移，必须在导入后、首次访问前播种。
  const storeModule = await import('./src/data/local-store.ts')
  const { allRows } = storeModule

  console.log('1) v1 老数据迁移')
  seedOldStorage()
  const raw1 = JSON.parse(store.get(STORAGE_KEY)!)
  const r1 = migrateStorage(raw1)
  assert(r1.migrated === true, '识别为历史版本并执行迁移')
  assert(r1.envelope.schemaVersion === CURRENT_SCHEMA_VERSION, `信封版本升级到 v${CURRENT_SCHEMA_VERSION}`)
  assert(r1.envelope.migratedFromVersion === 1, '信封记录迁移来源 v1')
  assert(typeof r1.envelope.migratedAt === 'string', '信封记录迁移时间')
  assert(r1.changed === true, '迁移结果需要落盘')

  const dp = r1.envelope.modules.dispatchplan
  const byId = Object.fromEntries(dp.map((r) => [r.id, r]))
  assert(dp.length === 5, `重复编号去重 + 坏记录兜底，共 5 条（实际 ${dp.length}）`)

  const r1row = byId[1]
  assert(r1row['适用雨型'] === '小雨', '重复记录的非空字段并回保留条（适用雨型=小雨）')
  assert(r1row['方案名称'] === '老城区小雨方案', '保留条自有字段不被空值覆盖')
  assert(r1row['审核人'] === '未审核', '缺审核人用默认值补齐')
  assert(r1row['涉及泵站'] !== undefined && r1row['生效日期'] !== undefined, '所有新增列都在')
  assert(r1row['方案状态'] === '待编制', '方案状态镜像列回填为当前状态')
  assert(r1row.__migrated?.migratedFrom === 1, '行级迁移标记存在')
  assert(r1row.__migrated?.mergedFrom?.includes(4), '标记里记录了被合并的重复记录 id=4')
  assert(!r1row.__migrated?.backfilledFields.includes('适用雨型'), '并回的字段不算补齐')

  const r2row = byId[2]
  assert(r2row['status'] === '待审核', '历史状态别名「待审批」归一为「待审核」')
  assert(r2row['方案状态'] === '待审核', '别名归一同步到方案状态列')
  assert(r2row.pending === true, '待审核计入待处理')

  // 坏记录：id 非法 -> 用最大 id+1 兜底
  const repaired = dp.find((r) => r['方案名称'] === '编号坏掉的方案')
  assert(!!repaired, '字段不完整的历史记录没有被丢弃')
  assert(String(repaired!['方案编号']).startsWith('DISP-'), '缺方案编号按 id 兜底生成')
  assert(repaired!['status'] === '待编制', '无法识别的状态回退到待编制')
  assert(repaired!.__migrated?.backfilledFields.includes('id'), '非法 id 记录在迁移标记里')

  const nullRow = dp.find((r) => r.__migrated?.backfilledFields.includes('记录无法读取'))
  assert(!!nullRow, 'null 历史记录兜底重建并留痕')

  const codes = dp.map((r) => r['方案编号'])
  assert(new Set(codes).size === codes.length, '方案编号全局唯一')

  console.log('2) 幂等：迁移结果再次迁移不产生任何变化')
  const r2 = migrateStorage(JSON.parse(JSON.stringify(r1.envelope)))
  assert(r2.migrated === false, '已是当前版本，不再执行迁移')
  assert(r2.changed === false, '当前版本数据结构完好，不需要落盘')
  assert(
    JSON.stringify(r2.envelope) === JSON.stringify(r1.envelope),
    '二次迁移与首次结果完全一致（深比较）',
  )
  const markers1 = dp.filter((r) => r.__migrated).length
  const markers2 = r2.envelope.modules.dispatchplan.filter((r) => r.__migrated).length
  assert(markers1 === markers2, `迁移标记不重复（${markers1} 条）`)

  console.log('3) 模拟重复打开（走 localStorage 全链路）')
  const first = allRows().dispatchplan
  const persistedAfterFirst = JSON.parse(store.get(STORAGE_KEY)!)
  assert(persistedAfterFirst.schemaVersion === CURRENT_SCHEMA_VERSION, '首次打开后落盘为版本化信封')
  // 重新导入会复用缓存，这里直接用迁移函数模拟全新会话读盘
  const reopen = migrateStorage(persistedAfterFirst)
  assert(reopen.changed === false, '第二次打开不再重写存储')
  assert(
    JSON.stringify(reopen.envelope.modules.dispatchplan) ===
      JSON.stringify(persistedAfterFirst.modules.dispatchplan),
    '第二次打开数据与首次落盘一致',
  )
  assert(first.length === 5, '全链路读到 5 条方案')

  console.log('4) 缺整个 dispatchplan 模块也要兜底')
  const partial = { pumpstation: [{ id: 1, status: '运行中', pending: true, abnormal: false }] }
  const r3 = migrateStorage(partial)
  assert(r3.migrated === true, '无版本号平铺数据按 v1 迁移')
  assert(Array.isArray(r3.envelope.modules.dispatchplan), '缺失模块兜底补出')

  console.log('5) 坏掉的 JSON 形态回到干净种子（local-store 层）')
  store.set(STORAGE_KEY, '{不是json')
  // 清缓存通过新进程不便，直接验证 migrateStorage 对非法输入
  const r4 = migrateStorage('garbage')
  assert(r4.envelope.schemaVersion === CURRENT_SCHEMA_VERSION && r4.changed === true, '非法输入回退当前版本')

  console.log('6) 状态流转：待编制→待审核→已批准，不允许跳级')
  const service = await import('./src/api/local-service.ts')
  const rows0 = service.listEntries('dispatchplan').items
  const draftRow = rows0.find((r) => r['方案编号'] === 'DISP-1003')
  // 已批准 -> 尝试「提交编制」（目标待审核）应拒绝
  const skip = service.runAction('dispatchplan', draftRow!.id, '提交编制')
  assert(skip.ok === false, '已批准方案不能跳回/跳到待审核')
  // 待编制直接批准 -> 拒绝跳级
  const jump = service.runAction('dispatchplan', 1, '批准方案')
  assert(jump.ok === false, '待编制不能直接批准（不允许跳级）')
  const fwd1 = service.runAction('dispatchplan', 1, '提交编制')
  assert(fwd1.ok === true, '待编制可以提交编制 -> 待审核')
  assert(service.getEntry('dispatchplan', 1)!.status === '待审核', '状态已变为待审核')
  assert(service.getEntry('dispatchplan', 1)!['方案状态'] === '待审核', '方案状态列同步为待审核')
  const again = service.runAction('dispatchplan', 1, '提交编制')
  assert(again.ok === false, '重复提交被拒绝')
  const fwd2 = service.runAction('dispatchplan', 1, '批准方案')
  assert(fwd2.ok === true, '待审核可以批准 -> 已批准')
  const rejectAbort = service.runAction('dispatchplan', 1, '提交编制')
  assert(rejectAbort.ok === false, '已批准不能再提交编制')
  const abolish = service.runAction('dispatchplan', 1, '废止方案')
  assert(abolish.ok === true, '已批准可以废止')
  const abolishFromDraft = service.runAction('dispatchplan', 2, '废止方案')
  assert(abolishFromDraft.ok === false, '待审核不能直接废止')

  console.log('7) 三处页面待审核数一致')
  const counter = service.countByStatus('dispatchplan')
  const listPending = service.listEntries('dispatchplan').items.filter((r) => r.status === '待审核').length
  const overview = service.loadOverview()
  const overviewDispatch = overview.modules.find((m) => m.name === '排水调度方案')!
  assert(counter['待审核'] === listPending, `清单待审核数=${listPending} 与统计=${counter['待审核']} 一致`)
  assert(overviewDispatch.pending === counter['待审核'], `概览待处理=${overviewDispatch.pending} 与待审核数=${counter['待审核']} 一致`)
  assert(listPending >= 1, '待审核数至少 1（DISP-1002）')

  console.log('8) 方案编号重复提交只留一条（登记入口）')
  const before = service.listEntries('dispatchplan').total
  const dup = service.createEntry('dispatchplan', {
    方案编号: 'DISP-1002',
    方案名称: '重复登记',
    适用雨型: '中雨',
  })
  assert(dup.ok === false, '重复方案编号被拒绝')
  const after = service.listEntries('dispatchplan').total
  assert(before === after, '拒绝后记录数不增加')
  const created = service.createEntry('dispatchplan', {
    方案编号: 'DISP-2001',
    方案名称: '新建方案',
    适用雨型: '特大暴雨',
    涉及泵站: '一号泵站',
    编制人: '李四',
    生效日期: '2026-10-10',
  })
  assert(created.ok === true, '新编号登记成功')
  const fresh = service.getEntry('dispatchplan', created.id!)!
  assert(fresh.status === '待编制' && fresh['方案状态'] === '待编制', '新登记方案状态为待编制')
  assert(fresh.__migrated === undefined, '新登记记录不带迁移标记')
  assert(fresh['审核人'] === undefined, '新登记不预置审核人（流转到待审核后再产生）')

  console.log('9) 列表与详情名称/雨型对得上（共享同一份存储）')
  for (const row of service.listEntries('dispatchplan').items) {
    const detail = service.getEntry('dispatchplan', row.id)
    assert(detail!['方案名称'] === row['方案名称'], `id=${row.id} 名称一致`)
    assert(detail!['适用雨型'] === row['适用雨型'], `id=${row.id} 适用雨型一致`)
  }

  console.log('10) 首次播种（空存储）不带迁移标记')
  store.clear()
  const r5 = migrateStorage(null)
  assert(r5.migrated === false && r5.envelope.migratedFromVersion === null, '空存储为全新播种')
  assert(r5.envelope.modules.dispatchplan.every((r) => !r.__migrated), '种子数据无迁移标记')

  mkdirSync('tmp', { recursive: true })
  writeFileSync('tmp/migration-result.txt', failures === 0 ? 'PASS\n' : `FAIL ${failures}\n`)
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
