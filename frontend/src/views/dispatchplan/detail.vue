<template>
  <section class="page" data-module="dispatchplan-detail">
    <header class="page-head">
      <div>
        <h2>调度方案详情</h2>
        <p class="page-desc">查看方案完整信息与审批进度，状态只能按待编制 → 待审核 → 已批准依次流转。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" :to="{ name: 'dispatchplan' }">返回清单</RouterLink>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div v-if="!row" class="empty-block">
      <p>没有找到这条调度方案，可能已被重置或数据迁移后编号变化。</p>
      <RouterLink class="btn primary" :to="{ name: 'dispatchplan' }">回到清单</RouterLink>
    </div>

    <template v-else>
      <article v-if="row.__migrated" class="migration-banner">
        历史记录已按 v{{ row.__migrated.migratedFrom }} 存储结构升级，
        本次补齐：{{ row.__migrated.backfilledFields.join('、') || '无' }}
        <template v-if="row.__migrated.mergedFrom?.length">
          ；合并重复编号记录 id：{{ row.__migrated.mergedFrom.join('、') }}
        </template>
      </article>

      <div class="detail-head">
        <h3>{{ row['方案名称'] }}</h3>
        <span class="status-tag" :data-status="row.status">{{ row.status }}</span>
      </div>

      <dl class="detail-grid">
        <div v-for="field in fields" :key="field" class="detail-item">
          <dt>{{ field }}</dt>
          <dd>{{ row[field] || '—' }}</dd>
        </div>
      </dl>

      <div class="flow-line">
        <span
          v-for="(step, index) in flowSteps"
          :key="step"
          class="flow-step"
          :class="{ active: stepIndex >= 0 && index <= stepIndex, current: step === row.status }"
        >
          {{ step }}
        </span>
      </div>

      <div class="detail-actions">
        <button
          v-for="action in availableActions"
          :key="action"
          class="btn primary"
          type="button"
          @click="runAction(action)"
        >
          {{ action }}
        </button>
        <span v-if="!availableActions.length" class="muted-text">
          {{ row.status === '已废止' ? '方案已废止，流程结束' : '当前没有可执行动作' }}
        </span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  countByStatus,
  getEntry,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const meta = moduleMeta('dispatchplan')
const fields = meta.fields
// 审批主线只统计三步，已废止是终态支线，不进流转条。
const flowSteps = ['待编制', '待审核', '已批准']
const nextActionByStatus: Record<string, string> = {
  待编制: '提交编制',
  待审核: '批准方案',
  已批准: '废止方案',
}

const row = ref<EntryRow | undefined>()
const pendingReviewCount = ref(0)
const errorMessage = ref('')

const stepIndex = computed(() => flowSteps.indexOf(String(row.value?.status)))
const availableActions = computed(() => {
  const action = nextActionByStatus[String(row.value?.status ?? '')]
  return action ? [action] : []
})

// 与清单页、概览共用同一计数口径：这里读到的待审核数即清单和概览上的数字。
const stats = computed(() => {
  const items = listEntries(meta.key).items
  const count = (status: string) =>
    items.filter((item) => String(item.status) === status).length
  return [
    { label: '待编制方案', value: count('待编制') },
    { label: '待审核方案', value: pendingReviewCount.value },
    { label: '已批准方案', value: count('已批准') },
  ]
})

function reload() {
  errorMessage.value = ''
  const id = Number(route.params.id)
  row.value = getEntry(meta.key, id)
  pendingReviewCount.value = countByStatus(meta.key)['待审核'] ?? 0
}

function runAction(action: string) {
  if (!row.value) {
    return
  }
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.value.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

onMounted(reload)
</script>

<style scoped>
.empty-block {
  padding: 32px;
  text-align: center;
  border: 1px dashed #ccc;
  border-radius: 8px;
}
.migration-banner {
  margin-bottom: 16px;
  padding: 10px 14px;
  color: #8a5a00;
  background: #fff7e6;
  border: 1px solid #f0d29a;
  border-radius: 6px;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.detail-head h3 {
  margin: 0;
}
.status-tag {
  padding: 2px 10px;
  border-radius: 10px;
  background: #eef2f7;
}
.status-tag[data-status='待审核'] {
  color: #b26a00;
  background: #fff3df;
}
.status-tag[data-status='已批准'] {
  color: #1c7a3d;
  background: #e3f6e9;
}
.status-tag[data-status='已废止'] {
  color: #9a3535;
  background: #fbe7e7;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 24px;
  margin: 20px 0;
}
.detail-item {
  display: flex;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}
.detail-item dt {
  width: 84px;
  flex-shrink: 0;
  color: #888;
}
.detail-item dd {
  margin: 0;
}
.flow-line {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}
.flow-step {
  padding: 4px 14px;
  border-radius: 12px;
  background: #f0f0f0;
  color: #999;
}
.flow-step.active {
  background: #dcebfb;
  color: #1c5fa8;
}
.flow-step.current {
  background: #1c5fa8;
  color: #fff;
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.muted-text {
  color: #999;
}
</style>
