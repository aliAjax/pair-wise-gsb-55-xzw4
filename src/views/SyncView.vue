<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import {
  fieldLabel,
  formatFieldValue,
  objectLabel,
  outcomeLabels,
  sideLabels,
} from '@/services/merge'
import type { MergeBatch, MergeConflict, MergeSide } from '@/types/domain'

const store = useAppStore()
const { data, pendingConflicts, legacyPending, currentSide } = storeToRefs(store)
const mergingId = ref('')
const completing = ref(false)

const side = computed({
  get: () => currentSide.value,
  set: (value: MergeSide) => {
    void store.setSide(value)
  },
})

const peerSide = computed<MergeSide>(() => (currentSide.value === 'dispatch' ? 'station' : 'dispatch'))

const pendingBatches = computed(() =>
  data.value.mergeBatches.filter((batch) => batch.status !== 'merged'),
)

const resolvedConflicts = computed(() =>
  data.value.conflicts.filter((conflict) => conflict.status === 'resolved'),
)

const mergeComments = computed(() =>
  data.value.comments.filter((comment) => comment.targetType === 'merge'),
)

const mergeBaseVersion = computed(() => {
  const baseline = data.value.baselines.find((item) => item.id === data.value.mergeBase.baselineId)
  return baseline ? `${baseline.version}（已锁定）` : '初始快照（未锁定基线）'
})

const chainRows = computed(() => data.value.revisionChain.slice(0, 60))

const batchStatusText = (batch: MergeBatch) =>
  ({ pending: '待合并', merged: '已合并', failed: '保存失败' })[batch.status]

const batchStatusType = (batch: MergeBatch) =>
  batch.status === 'merged' ? 'success' : batch.status === 'failed' ? 'danger' : 'warning'

const mergedCount = (batch: MergeBatch) => batch.entries.filter((entry) => entry.merged).length

const valueForSide = (conflict: MergeConflict, sideValue: MergeSide) =>
  sideValue === conflict.localSide ? conflict.localValue : conflict.peerValue

function labelOf(kind: MergeConflict['objectKind'], objectId: string) {
  return objectLabel(data.value, kind, objectId)
}

async function generateBatch() {
  const batch = await store.createPeerBatch()
  ElMessage.success(`已接收${sideLabels[batch.side]}离线批次，共 ${batch.entries.length} 条修订`)
}

async function merge(batch: MergeBatch) {
  mergingId.value = batch.id
  try {
    await store.mergeBatch(batch.id)
    ElMessage.success('批次合并完成，结果已写入修订链')
  } catch (error) {
    ElMessage.error(
      error instanceof Error
        ? `${error.message}；批次已保留，重试仅补未合并对象`
        : '合并保存失败，批次已保留',
    )
  } finally {
    mergingId.value = ''
  }
}

async function resolve(conflict: MergeConflict, chosen: MergeSide) {
  await store.resolveConflict(conflict.id, chosen)
  ElMessage.success(`已采用${sideLabels[chosen]}值并写入修订链`)
}

async function completeLegacy() {
  completing.value = true
  try {
    await store.completeLegacyChain()
    ElMessage.success('修订链已补齐，历史待核解除')
  } finally {
    completing.value = false
  }
}

function armFailure() {
  store.armFailureSimulation()
  ElMessage.warning('已武装故障注入：下一次保存将失败，用于验证批次保留与重试')
}
</script>

<template>
  <div>
    <PageHeader
      title="双端同步与修订链"
      description="调度端与站端离线维护共用一条修订链，按字段三方合并：单边改动自动合并，双边改动两份保留待选择，不以保存先后裁决。"
    >
      <template #actions>
        <el-radio-group v-model="side">
          <el-radio-button value="dispatch">调度端维护</el-radio-button>
          <el-radio-button value="station">站端维护</el-radio-button>
        </el-radio-group>
        <el-button
          type="warning"
          plain
          :disabled="store.failureArmed"
          @click="armFailure"
        >
          {{ store.failureArmed ? '故障已武装' : '模拟下次保存失败' }}
        </el-button>
        <el-button type="primary" :loading="store.saving" @click="generateBatch">
          接收{{ sideLabels[peerSide] }}离线批次
        </el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="legacyPending"
      type="error"
      show-icon
      :closable="false"
      class="legacy-alert"
    >
      <template #title>
        历史数据缺少修订链，已标记“历史待核”；补齐前不能锁定新基线。
      </template>
      <template #default>
        <div class="legacy-actions">
          <span>为现有设备、定值、场景、校核结果与基线补齐创世修订后即可恢复正常流转。</span>
          <el-button type="danger" size="small" :loading="completing" @click="completeLegacy">
            补齐修订链
          </el-button>
        </div>
      </template>
    </el-alert>

    <section class="metric-grid">
      <div class="metric warning">
        <span>待合并批次</span>
        <strong>{{ pendingBatches.length }}</strong>
        <small>含保存失败待重试的批次</small>
      </div>
      <div class="metric danger">
        <span>待裁决冲突</span>
        <strong>{{ pendingConflicts.length }}</strong>
        <small>双边改动同一字段，两份值保留待选择</small>
      </div>
      <div class="metric info">
        <span>修订链记录</span>
        <strong>{{ data.revisionChain.length }}</strong>
        <small>设备、定值、校核、场景、基线共用</small>
      </div>
      <div class="metric">
        <span>三方合并基准</span>
        <strong class="baseline-version">{{ mergeBaseVersion }}</strong>
        <small>上次锁定基线快照</small>
      </div>
    </section>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title">
          <h3>合并批次</h3>
          <span class="muted">失败批次保留未完成进度，重试仅补未合并对象</span>
        </div>
        <el-table :data="data.mergeBatches" max-height="360">
          <el-table-column prop="title" label="批次" min-width="210" />
          <el-table-column label="来源端" width="90">
            <template #default="{ row }">
              <el-tag effect="plain">{{ sideLabels[row.side as MergeSide] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="进度" width="80">
            <template #default="{ row }">{{ mergedCount(row) }}/{{ row.entries.length }}</template>
          </el-table-column>
          <el-table-column label="状态" width="95">
            <template #default="{ row }">
              <el-tag :type="batchStatusType(row)" effect="plain">{{ batchStatusText(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="尝试" width="60">
            <template #default="{ row }">{{ row.attempts }}</template>
          </el-table-column>
          <el-table-column label="操作" width="110" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status !== 'merged'"
                link
                type="primary"
                :loading="mergingId === row.id"
                @click="merge(row)"
              >
                {{ row.status === 'failed' ? '重试合并' : '开始合并' }}
              </el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!data.mergeBatches.length" description="暂无对端批次，点击右上角接收离线批次" :image-size="70" />
        <el-alert
          v-if="data.mergeBatches.some((batch) => batch.status === 'failed')"
          title="存在保存失败的批次：已合并条目不会重复执行，审计与会签记录不会重复新增。"
          type="warning"
          :closable="false"
          show-icon
          style="margin-top: 10px"
        />

        <div class="panel-title" style="margin-top: 18px">
          <h3>合并会签记录</h3>
        </div>
        <div v-for="comment in mergeComments" :key="comment.id" class="comment-item">
          <div class="comment-meta">
            <strong>{{ comment.author }}</strong>
            <span>{{ new Date(comment.createdAt).toLocaleString('zh-CN') }}</span>
          </div>
          <div>{{ comment.content }}</div>
        </div>
        <el-empty v-if="!mergeComments.length" description="批次合并后自动生成会签记录" :image-size="60" />
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>待裁决冲突</h3>
          <el-tag type="danger" effect="plain">{{ pendingConflicts.length }} 条</el-tag>
        </div>
        <div v-if="pendingConflicts.length">
          <div v-for="conflict in pendingConflicts" :key="conflict.id" class="conflict-item">
            <div class="conflict-head">
              <strong>{{ labelOf(conflict.objectKind, conflict.objectId) }}</strong>
              <el-tag size="small" effect="plain">
                {{ fieldLabel(conflict.objectKind, conflict.field) }}
              </el-tag>
            </div>
            <div class="conflict-base">
              基线值：{{ formatFieldValue(conflict.objectKind, conflict.field, conflict.baseValue) }}
            </div>
            <div class="conflict-options">
              <div class="conflict-option">
                <span class="option-side">调度端</span>
                <span class="option-value">
                  {{ formatFieldValue(conflict.objectKind, conflict.field, valueForSide(conflict, 'dispatch')) }}
                </span>
                <el-button size="small" type="primary" plain @click="resolve(conflict, 'dispatch')">
                  采用
                </el-button>
              </div>
              <div class="conflict-option">
                <span class="option-side">站端</span>
                <span class="option-value">
                  {{ formatFieldValue(conflict.objectKind, conflict.field, valueForSide(conflict, 'station')) }}
                </span>
                <el-button size="small" type="primary" plain @click="resolve(conflict, 'station')">
                  采用
                </el-button>
              </div>
            </div>
          </div>
        </div>
        <el-empty v-else description="无待裁决冲突" :image-size="70" />

        <template v-if="resolvedConflicts.length">
          <div class="panel-title" style="margin-top: 16px">
            <h3>已裁决</h3>
          </div>
          <div v-for="conflict in resolvedConflicts.slice(0, 5)" :key="conflict.id" class="resolved-item">
            <span>{{ labelOf(conflict.objectKind, conflict.objectId) }} · {{ fieldLabel(conflict.objectKind, conflict.field) }}</span>
            <el-tag size="small" type="success" effect="plain">
              采用{{ conflict.resolvedSide ? sideLabels[conflict.resolvedSide] : '—' }}值
              {{ formatFieldValue(conflict.objectKind, conflict.field, conflict.resolvedValue ?? null) }}
            </el-tag>
          </div>
        </template>
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>共享修订链</h3>
        <span class="muted">设备、保护定值、校核结果、故障场景与基线会签共用，最近 {{ chainRows.length }} 条</span>
      </div>
      <el-table :data="chainRows" max-height="420">
        <el-table-column label="时间" width="165">
          <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="维护端" width="90">
          <template #default="{ row }">
            <el-tag :type="row.side === 'dispatch' ? 'primary' : 'success'" effect="plain">
              {{ sideLabels[row.side as MergeSide] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="对象" min-width="180">
          <template #default="{ row }">{{ labelOf(row.objectKind, row.objectId) }}</template>
        </el-table-column>
        <el-table-column label="字段" width="130">
          <template #default="{ row }">{{ fieldLabel(row.objectKind, row.field) }}</template>
        </el-table-column>
        <el-table-column label="基线值" width="110">
          <template #default="{ row }">
            <span class="diff-before">{{ formatFieldValue(row.objectKind, row.field, row.baseValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="修订值" width="110">
          <template #default="{ row }">
            <span class="diff-after">{{ formatFieldValue(row.objectKind, row.field, row.value) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="110">
          <template #default="{ row }">
            <el-tag
              :type="row.outcome === 'conflict' ? 'danger' : row.outcome === 'auto' ? 'success' : 'info'"
              effect="plain"
            >
              {{ outcomeLabels[row.outcome as keyof typeof outcomeLabels] }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!chainRows.length" description="修订链为空，历史数据补齐或产生新修订后在此展示" :image-size="70" />
    </section>
  </div>
</template>

<style scoped>
.legacy-alert {
  margin-bottom: 16px;
}

.legacy-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.baseline-version {
  font-size: 20px !important;
}

.conflict-item {
  padding: 12px;
  margin-bottom: 10px;
  background: #fdf6f4;
  border: 1px solid #f0d9d2;
  border-radius: 6px;
}

.conflict-head {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.conflict-base {
  margin: 8px 0;
  color: #8a6d5f;
  font-size: 12px;
}

.conflict-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.conflict-option {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid #ecd9d2;
  border-radius: 5px;
}

.option-side {
  flex: 0 0 auto;
  color: #708292;
  font-size: 12px;
}

.option-value {
  flex: 1;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resolved-item {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #e7ecf0;
}
</style>
