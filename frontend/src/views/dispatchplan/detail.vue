<template>
  <section class="page" data-module="dispatchplan-detail">
    <header class="page-head">
      <div>
        <h2>调度方案详情</h2>
        <p class="page-desc">
          <RouterLink class="link" to="/dispatchplan">返回排水调度方案清单</RouterLink>
          ，详情与清单读取同一份迁移后数据。
        </p>
      </div>
    </header>

    <template v-if="entry">
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">当前待审核方案总数</span>
          <strong class="stat-value">{{ pendingTotal }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">本方案当前状态</span>
          <strong class="stat-value">{{ entry.status }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">存储结构版本</span>
          <strong class="stat-value">v{{ version }}</strong>
        </article>
      </div>

      <div v-if="markers.migrated || markers.repaired || markers.merged > 0" class="migrate-note">
        <p v-if="markers.migrated">迁移标记：该方案由旧版存储结构（v1）迁移而来，缺失字段已按默认值补齐。</p>
        <p v-if="markers.repaired">兜底标记：该历史记录部分内容取不到，已按默认值兜底补齐后展示。</p>
        <p v-if="markers.merged > 0">去重标记：迁移时合并了 {{ markers.merged }} 条方案编号重复的记录，只保留当前这一条。</p>
      </div>

      <table class="data-table detail-table">
        <tbody>
          <tr v-for="field in detailFields" :key="field">
            <th>{{ field }}</th>
            <td>{{ entry[field] ?? '—' }}</td>
          </tr>
          <tr>
            <th>当前状态（审批流）</th>
            <td>{{ entry.status }}</td>
          </tr>
        </tbody>
      </table>

      <p class="page-desc" style="margin: 12px 0 6px">
        状态只能按「待编制 → 待审核 → 已批准」逐一流转，不允许跳级：
      </p>
      <div class="page-actions">
        <button
          v-for="action in availableActions"
          :key="action"
          class="btn primary"
          type="button"
          @click="runAction(action)"
        >
          {{ action }}
        </button>
        <span v-if="!availableActions.length" class="page-desc">当前状态没有可执行的流转动作。</span>
        <span v-if="actionMessage" :class="actionOk ? 'form-ok' : 'error-text'">{{ actionMessage }}</span>
      </div>

      <h3 style="margin-top: 20px">清单对照（方案名称 / 适用雨型）</h3>
      <table class="data-table">
        <thead>
          <tr><th>方案编号</th><th>方案名称</th><th>适用雨型</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in all" :key="String(row.id)">
            <td>{{ row['方案编号'] }}</td>
            <td>{{ row['方案名称'] }}</td>
            <td>{{ row['适用雨型'] }}</td>
            <td>{{ row.status }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <div v-else class="empty-state">
      <p>没有找到该调度方案，可能已被重置或编号无效。</p>
      <RouterLink class="link" to="/dispatchplan">返回清单</RouterLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  getEntry,
  listEntries,
  moduleMeta,
  pendingCount,
  runAction as applyAction,
} from '@/api/local-service'
import { schemaVersion } from '@/data/local-store'
import { migrationMarkers } from '@/data/migrations'
import type { EntryRow } from '@/data/types'

const route = useRoute()
const meta = moduleMeta('dispatchplan')
const detailFields = ['方案编号', '方案名称', '适用雨型', '涉及泵站', '编制人', '审核人', '生效日期', '方案状态']
const actionOrder = ['提交编制', '批准方案', '废止方案']

const entry = ref<EntryRow | null>(null)
const all = ref<EntryRow[]>([])
const version = ref(schemaVersion())
const actionMessage = ref('')
const actionOk = ref(false)

const markers = computed(() => (entry.value ? migrationMarkers(entry.value) : { migrated: false, repaired: false, merged: 0 }))
const pendingTotal = computed(() => pendingCount(meta.key))
const availableActions = computed(() => {
  if (!entry.value) {
    return [] as string[]
  }
  const status = String(entry.value.status)
  return actionOrder.filter((action) => meta.actionAllowed?.[action]?.includes(status))
})

function load() {
  const id = Number(route.params.id)
  entry.value = getEntry(meta.key, id)
  all.value = listEntries(meta.key).items
}

function runAction(action: string) {
  actionMessage.value = ''
  if (!entry.value) {
    return
  }
  const result = applyAction(meta.key, Number(entry.value.id), action)
  actionOk.value = result.ok
  actionMessage.value = result.message
  if (result.ok) {
    load()
  }
}

onMounted(load)
</script>

<style scoped>
.detail-table th {
  width: 180px;
  text-align: left;
  color: var(--muted);
}
.migrate-note {
  margin: 10px 0;
  padding: 10px 12px;
  background: #fdf1dc;
  border: 1px solid #f0d9a8;
  border-radius: 8px;
  font-size: 12px;
  color: #8a5a00;
}
.migrate-note p {
  margin: 2px 0;
}
.form-ok {
  color: #067647;
  font-size: 12px;
}
</style>
