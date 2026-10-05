<template>
  <section class="page" data-module="dispatchplan">
    <header class="page-head">
      <div>
        <h2>排水调度方案管理</h2>
        <p class="page-desc">维护调度方案，围绕方案编号、方案名称、适用雨型、涉及泵站做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记调度方案</button>
        <button class="btn" type="button" @click="exportRows">导出排水调度方案清单</button>
      </div>
    </header>

    <p v-if="migratedCount > 0" class="status-legend">
      <span class="legend-item">
        检测到 {{ migratedCount }} 条历史方案已按当前存储结构（v{{ version }}）迁移补齐，详情页可见迁移标记。
      </span>
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <RouterLink v-if="column === '方案名称'" class="link" :to="`/dispatchplan/${row.id}`">
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>
              {{ row[column] ?? '—' }}
              <span
                v-if="column === '方案编号' && markersOf(row).migrated"
                class="migrate-badge"
                title="该记录由旧版存储迁移而来"
              >旧版迁移</span>
            </template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无排水调度方案数据，可先登记调度方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水调度方案记录 · 待审核数与概览、详情口径一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="showForm" class="modal-mask" @click.self="closeCreate">
      <form class="modal-panel" @submit.prevent="submitForm">
        <h3>登记调度方案</h3>
        <p class="page-desc">方案编号重复提交时只更新原方案，始终只保留一条记录。</p>
        <label v-for="field in formFields" :key="field.prop" class="filter-item form-line">
          <span>{{ field.label }}</span>
          <select v-if="field.prop === '适用雨型'" v-model="form[field.prop]">
            <option v-for="rain in rainTypes" :key="rain" :value="rain">{{ rain }}</option>
          </select>
          <input
            v-else
            v-model="form[field.prop]"
            :type="field.prop === '生效日期' ? 'date' : 'text'"
            :placeholder="`请输入${field.label}`"
          />
        </label>
        <p v-if="formMessage" :class="formOk ? 'form-ok' : 'error-text'">{{ formMessage }}</p>
        <div class="page-actions">
          <button class="btn primary" type="submit">提交</button>
          <button class="btn ghost" type="button" @click="closeCreate">关闭</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  metricStats,
  moduleMeta,
  runAction as applyAction,
  submitPlan,
  type PlanDraft,
} from '@/api/local-service'
import { schemaVersion } from '@/data/local-store'
import { migrationMarkers } from '@/data/migrations'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dispatchplan')
const columns = ['方案编号', '方案名称', '适用雨型', '涉及泵站', '编制人', '审核人', '生效日期', '方案状态']
const actions = ['提交编制', '批准方案', '废止方案']
const rainTypes = ['小雨', '中雨', '大雨', '暴雨', '特大暴雨']

const formFields: { prop: keyof PlanDraft; label: string }[] = [
  { prop: '方案编号', label: '方案编号' },
  { prop: '方案名称', label: '方案名称' },
  { prop: '适用雨型', label: '适用雨型' },
  { prop: '涉及泵站', label: '涉及泵站' },
  { prop: '编制人', label: '编制人' },
  { prop: '生效日期', label: '生效日期' },
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['方案编号', '方案名称', '适用雨型']

const version = ref(schemaVersion())
const stats = computed(() => metricStats(meta.key))
const statusSummary = computed(() =>
  meta.statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const migratedCount = computed(
  () => rows.value.filter((row) => migrationMarkers(row).migrated).length,
)

function markersOf(row: EntryRow) {
  return migrationMarkers(row)
}

// 只显示当前状态下合法的动作，避免跳级提交。
function availableActions(row: EntryRow): string[] {
  return actions.filter((action) => {
    const allowed = meta.actionAllowed?.[action]
    return !allowed || allowed.includes(String(row.status))
  })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

const emptyForm = (): PlanDraft => ({
  方案编号: '',
  方案名称: '',
  适用雨型: '中雨',
  涉及泵站: '',
  编制人: '',
  生效日期: '',
})

const showForm = ref(false)
const form = reactive<PlanDraft>(emptyForm())
const formMessage = ref('')
const formOk = ref(false)

function openCreate() {
  Object.assign(form, emptyForm())
  formMessage.value = ''
  formOk.value = false
  showForm.value = true
}

function closeCreate() {
  showForm.value = false
}

function submitForm() {
  formMessage.value = ''
  const result = submitPlan({ ...form })
  formOk.value = result.ok
  formMessage.value = result.message
  if (!result.ok) {
    return
  }
  reload()
  // 编号重复时是更新原方案，保留弹窗让用户看到「未重复新增」的提示；新登记才关闭。
  if (!result.message.includes('已存在')) {
    closeCreate()
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排水调度方案列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.migrate-badge {
  margin-left: 6px;
  padding: 0 6px;
  font-size: 11px;
  color: #8a5a00;
  background: #fdf1dc;
  border: 1px solid #f0d9a8;
  border-radius: 4px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-panel {
  width: 460px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
}
.form-line {
  margin: 8px 0;
  width: 100%;
}
.form-line input,
.form-line select {
  width: 100%;
  box-sizing: border-box;
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.form-ok {
  color: #067647;
  font-size: 12px;
}
</style>
