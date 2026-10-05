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
            <RouterLink
              v-if="column === '方案名称'"
              class="link"
              :to="{ name: 'dispatchplan-detail', params: { id: row.id } }"
            >
              {{ row[column] ?? '—' }}
            </RouterLink>
            <template v-else>
              <span :title="migrationHint(row)">{{ row[column] ?? '—' }}</span>
              <em
                v-if="column === '方案编号' && row.__migrated"
                class="migrated-flag"
                :title="migrationHint(row)"
              >迁</em>
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
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无排水调度方案数据，可先登记调度方案</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条排水调度方案记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记调度方案</h3>
        <label v-for="field in editableFields" :key="field" class="form-item">
          <span>{{ field }}</span>
          <input v-model="draft[field]" :placeholder="`请输入${field}`" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">提交登记</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  countByStatus,
  createEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('dispatchplan')
const columns = ["方案编号", "方案名称", "适用雨型", "涉及泵站", "编制人", "审核人", "生效日期", "方案状态"]
// 登记时可填的字段：方案状态由状态机驱动，不允许手工写死。
const editableFields = ["方案编号", "方案名称", "适用雨型", "涉及泵站", "编制人", "生效日期"]
// 动作在列表上按状态机收窄，不展示也不允许跳级操作。
const nextActionByStatus: Record<string, string> = {
  待编制: '提交编制',
  待审核: '批准方案',
  已批准: '废止方案',
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = ref<{ status: string; count: number }[]>([])

const stats = computed(() => [
  { label: '待编制方案', value: statusSummary.value.find((item) => item.status === '待编制')?.count ?? 0 },
  { label: '待审核方案', value: statusSummary.value.find((item) => item.status === '待审核')?.count ?? 0 },
  { label: '已批准方案', value: statusSummary.value.find((item) => item.status === '已批准')?.count ?? 0 },
])

const creating = ref(false)
const formError = ref('')
const draft = reactive<Record<string, string>>({})

function availableActions(row: EntryRow): string[] {
  const action = nextActionByStatus[String(row.status)]
  return action ? [action] : []
}

function migrationHint(row: EntryRow): string {
  if (!row.__migrated) {
    return ''
  }
  const fields = row.__migrated.backfilledFields.join('、') || '无'
  return `历史数据（v${row.__migrated.migratedFrom} 迁移），补齐：${fields}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  for (const field of editableFields) {
    draft[field] = ''
  }
  formError.value = ''
  creating.value = true
}

function closeCreate() {
  creating.value = false
}

function submitCreate() {
  formError.value = ''
  const result = createEntry(meta.key, { ...draft })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  creating.value = false
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  // 批准后可以继续废止，直接留在本页刷新即可；审批动作后不跳页。
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 统计口径基于全量数据，筛选不影响卡片与概览的待审核数。
    const counter = countByStatus(meta.key)
    statusSummary.value = meta.statuses.map((status) => ({ status, count: counter[status] ?? 0 }))
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '排水调度方案列表读取失败'
  }
}

// 详情页流转状态后返回列表时也要拿到最新统计。
const removeAfterEach = router.afterEach((to) => {
  if (to.name === 'dispatchplan') {
    reload()
  }
})
onBeforeUnmount(removeAfterEach)

onMounted(reload)
</script>

<style scoped>
.migrated-flag {
  margin-left: 4px;
  padding: 0 4px;
  font-size: 12px;
  font-style: normal;
  color: #b26a00;
  border: 1px solid #e0b27a;
  border-radius: 3px;
}
.muted-text {
  color: #999;
}
.modal-mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  z-index: 20;
}
.modal-card {
  width: 420px;
  max-width: calc(100vw - 32px);
  padding: 20px 24px;
  background: #fff;
  border-radius: 8px;
}
.modal-card h3 {
  margin: 0 0 12px;
}
.form-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.form-item span {
  width: 72px;
  flex-shrink: 0;
}
.form-item input {
  flex: 1;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
