# 城市排水防涝泵站运行与内涝处置管理平台

面向排水泵站台账、泵组运行、排水管网与检查井养护、水位雨量监测、内涝点处置、闸门调度与抢险队出动的一体化城市排水防涝运行管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 泵站台账 | `pumpstation` | 排水泵站 | 站名、所属片区、设计流量 |
| 泵组运行 | `pumprun` | 泵组运行记录 | 运行编号、所属泵站、泵组编号 |
| 排水管网 | `drainpipe` | 排水管段 | 管段编号、起点井号、终点井号 |
| 检查井维护 | `manhole` | 检查井 | 井编号、所属管段、井盖状况 |
| 管网清淤 | `dredge` | 清淤记录 | 清淤编号、清淤管段、淤积厚度 |
| 水位监测 | `waterlevel` | 水位监测记录 | 监测编号、监测点位、水位读数 |
| 雨量监测 | `rainfall` | 雨量监测记录 | 监测编号、雨量站名、时段雨量 |
| 内涝点处置 | `waterlog` | 内涝点记录 | 内涝编号、内涝点位、积水深度 |
| 闸门调度 | `floodgate` | 闸门调度记录 | 调度编号、闸门名称、所属河渠 |
| 泵组检修 | `pumpmaint` | 泵组检修记录 | 检修编号、泵组编号、检修类别 |
| 拍门检修 | `sluice` | 拍门检修记录 | 检修编号、所属泵站、拍门编号 |
| 格栅清污 | `screen` | 清污记录 | 清污编号、所属泵站、格栅类型 |
| 排口巡查 | `outfallpatrol` | 排口巡查记录 | 巡查编号、排口名称、所在河段 |
| 防涝预警发布 | `floodwarn` | 预警单 | 预警编号、预警级别、影响区域 |
| 抢险队调度 | `rescueteam` | 抢险任务 | 任务编号、任务类型、目标点位 |
| 排水设备台账 | `drainequipment` | 排水设备 | 设备编号、设备名称、设备型号 |
| 管道内窥检测 | `cctvinspect` | 内窥检测记录 | 检测编号、检测管段、缺陷等级 |
| 排水调度方案 | `dispatchplan` | 调度方案 | 方案编号、方案名称、适用雨型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `drainage-pump:entries` 这一项，或调用 `resetModule(模块)`。

## 存储结构版本化与迁移

浏览器里的数据以「信封」结构保存（`frontend/src/data/migrations.ts`）：

```jsonc
{ "schemaVersion": 2, "modules": { "dispatchplan": [ /* 行 */ ] }, "migrationLog": [ /* 迁移留痕 */ ] }
```

- 最早一版是没有版本号的纯模块表，读取时按 v1 → 当前版本逐级迁移：后加的「适用雨型、
  审核人」等字段按默认值补齐，取不到的坏记录兜底修复，方案编号重复的历史记录合并为一条。
- 迁移是**幂等**的：升级后的信封带上 `schemaVersion`，行上有 `__migratedFrom` 等标记，
  重复打开不会重复迁移、不重复记日志。
- 排水调度方案的状态机为「待编制 → 待审核 → 已批准」，另有「已废止」终态；
  每个动作的前置状态登记在 `modules.ts` 的 `actionAllowed`，跳级操作会被拒绝。
- 待审核数以「状态 = 待审核」为唯一口径（`pendingStatus`），清单统计卡、详情页、
  运营概览三处读数一致。
- 方案编号是业务主键：重复提交只更新原方案、只保留一条（见 `submitPlan`）。
