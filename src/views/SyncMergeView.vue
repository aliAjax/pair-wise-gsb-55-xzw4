<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useAppStore } from '@/stores/app'
import { diffRemote, mergeBaseOf } from '@/services/merge'
import { kindLabels } from '@/services/revision'
import type { ChainObjectKind, FieldConflict, RevisionRecord, SyncBatch } from '@/types/domain'

const store = useAppStore()
const { data } = storeToRefs(store)
const simulateFailure = ref(false)
const merging = ref(false)
const retrying = ref('')

const mergeBase = computed(() => mergeBaseOf(data.value))
const remoteDiffs = computed(() => diffRemote(data.value))
const revisions = computed(() => [...data.value.revisionLog].reverse())
const pendingConflicts = computed(() =>
  data.value.conflicts.filter((item) => item.status === 'pending'),
)
const resolvedConflicts = computed(() =>
  data.value.conflicts.filter((item) => item.status === 'resolved'),
)
const legacyGroups = computed(() => {
  const groups = new Map<ChainObjectKind, string[]>()
  data.value.legacyKeys.forEach((key) => {
    const kind = key.split(':')[0] as ChainObjectKind
    groups.set(kind, [...(groups.get(kind) ?? []), key])
  })
  return [...groups.entries()].map(([kind, keys]) => ({ kind, keys }))
})

const sideText = (side: RevisionRecord['side']) => (side === 'dispatch' ? '调度端' : '站端')
const revKindText = (kind: RevisionRecord['kind']) =>
  ({
    edit: '变更',
    merge: '合并',
    resolve: '裁决',
    migrate: '迁移',
    baseline: '基线',
  })[kind]
const revKindType = (kind: RevisionRecord['kind']) =>
  kind === 'merge' ? 'success' : kind === 'resolve' ? 'warning' : kind === 'baseline' ? 'danger' : 'info'

const batchStatusText = (status: SyncBatch['status']) =>
  ({ open: '待执行', partial: '部分完成', merged: '已合并', failed: '保存失败' })[status]
const batchStatusType = (status: SyncBatch['status']) =>
  status === 'merged' ? 'success' : status === 'failed' ? 'danger' : 'warning'
const opStatusText = (status: SyncBatch['ops'][number]['status']) =>
  ({ pending: '待合并', merged: '已合并', conflict: '待裁决', failed: '失败' })[status]
const opStatusType = (status: SyncBatch['ops'][number]['status']) =>
  status === 'merged' ? 'success' : status === 'failed' ? 'danger' : status === 'conflict' ? 'warning' : 'info'

const fieldLabels: Record<string, string> = {
  __object__: '对象存废',
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
  status: '运行状态',
  steps: '动作序列',
  notes: '备注',
  name: '名称',
  operationMode: '运行方式',
  faultDeviceId: '故障设备',
  faultType: '故障类型',
  outageDevices: '停电范围',
  code: '设备编号',
  station: '所属站所',
  voltage: '电压等级',
  parentId: '上级设备',
  operationModes: '运行方式',
  kind: '设备类型',
  relayId: '保护装置',
  protectedDeviceId: '保护对象',
  stage: '段位',
}

const fmtValue = (value: unknown) => {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

async function simulate() {
  await store.simulateOfflineEdits()
  ElMessage.success('已模拟双端离线改动，可执行同步合并')
}

async function merge() {
  merging.value = true
  try {
    await store.runSyncMerge(simulateFailure.value)
    ElMessage.success('同步合并完成，双端数据一致')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '同步合并失败')
  } finally {
    merging.value = false
  }
}

async function retry(batch: SyncBatch) {
  retrying.value = batch.id
  try {
    await store.retryBatch(batch.id)
    ElMessage.success('批次重试完成，未合并对象已补齐')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '批次重试失败')
  } finally {
    retrying.value = ''
  }
}

async function choose(conflict: FieldConflict, choice: 'local' | 'remote') {
  await store.resolveConflict(conflict.id, choice)
  ElMessage.success(`已采用${choice === 'local' ? '调度端' : '站端'}值`)
}

async function backfill(kind?: ChainObjectKind) {
  await store.backfillLegacy(kind)
  ElMessage.success('历史数据修订链已补齐')
}
</script>

<template>
  <div>
    <PageHeader
      title="同步合并"
      description="调度端与站端共用一条修订链；相对上次锁定基线三向合并，双端同改字段保留两份待裁决，保存先后不作裁决依据。"
    >
      <template #actions>
        <el-checkbox v-model="simulateFailure" style="margin-right: 14px">
          模拟保存失败
        </el-checkbox>
        <el-button @click="simulate">模拟双端离线改动</el-button>
        <el-button type="primary" :loading="merging" @click="merge">执行同步合并</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="store.legacyPending"
      :title="`存在 ${data.legacyKeys.length} 项历史待核数据，补齐修订链前不能锁定新基线。`"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 14px"
    />

    <div class="three-column sync-grid">
      <section class="panel">
        <div class="panel-title">
          <h3>共用修订链</h3>
          <el-tag effect="plain">{{ revisions.length }} 条记录</el-tag>
        </div>
        <el-descriptions :column="1" border size="small" style="margin-bottom: 12px">
          <el-descriptions-item label="合并基线">
            {{ mergeBase.baseline?.version ?? '无锁定基线' }}
            <span v-if="mergeBase.baseline?.revisionId" class="mono muted">
              （{{ mergeBase.baseline.revisionId }}）
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="调度端链头">
            <span class="mono">{{ data.heads.dispatch ?? '—' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="站端链头">
            <span class="mono">{{ data.heads.station ?? '尚未同步' }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <el-timeline class="revision-timeline">
          <el-timeline-item
            v-for="record in revisions"
            :key="record.id"
            :timestamp="new Date(record.createdAt).toLocaleString('zh-CN')"
            :type="record.side === 'station' ? 'warning' : 'primary'"
          >
            <div>
              <el-tag size="small" :type="revKindType(record.kind)" effect="plain">
                {{ revKindText(record.kind) }}
              </el-tag>
              <el-tag size="small" effect="plain" style="margin-left: 6px">
                {{ sideText(record.side) }}
              </el-tag>
              <span class="mono muted" style="margin-left: 6px">{{ record.id }}</span>
            </div>
            <p class="revision-summary">{{ record.summary }}</p>
            <small class="muted">涉及 {{ record.objectKeys.length }} 个对象</small>
          </el-timeline-item>
        </el-timeline>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>同步批次</h3>
          <span class="muted">失败保留现场，重试只补未合并对象</span>
        </div>
        <el-table :data="data.syncBatches" max-height="300">
          <el-table-column label="批次" min-width="180">
            <template #default="{ row }">
              <span class="mono">{{ row.id }}</span>
              <div class="muted">第 {{ row.attempt }} 次执行 · {{ row.ops.length }} 个对象</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="batchStatusType(row.status)" effect="plain">
                {{ batchStatusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'failed' || row.status === 'partial'"
                link
                type="primary"
                :loading="retrying === row.id"
                @click="retry(row)"
              >
                重试补合并
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!data.syncBatches.length" description="尚未执行同步合并" :image-size="70" />

        <template v-if="data.syncBatches.length">
          <div class="panel-title" style="margin-top: 16px">
            <h3>最近批次对象</h3>
          </div>
          <el-table :data="data.syncBatches[0].ops" max-height="240" size="small">
            <el-table-column prop="label" label="对象" min-width="170" />
            <el-table-column label="类别" width="95">
              <template #default="{ row }">{{ kindLabels[row.kind as ChainObjectKind] }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="opStatusType(row.status)" effect="plain">
                  {{ opStatusText(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="说明" min-width="160">
              <template #default="{ row }">
                <span class="muted">{{ row.error ?? '—' }}</span>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>站端离线副本</h3>
          <el-tag v-if="data.remote" effect="plain">
            {{ new Date(data.remote.updatedAt).toLocaleString('zh-CN') }}
          </el-tag>
        </div>
        <template v-if="data.remote">
          <el-table :data="remoteDiffs" max-height="300">
            <el-table-column prop="label" label="对象" min-width="160" />
            <el-table-column label="类别" width="95">
              <template #default="{ row }">{{ kindLabels[row.kind as ChainObjectKind] }}</template>
            </el-table-column>
            <el-table-column label="站端改动字段" min-width="170">
              <template #default="{ row }">
                {{ row.changedFields.map((field: string) => fieldLabels[field] ?? field).join('、') }}
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="!remoteDiffs.length" description="双端数据一致" :image-size="70" />
        </template>
        <el-empty v-else description="点击“模拟双端离线改动”生成站端离线副本" :image-size="70" />

        <div class="panel-title" style="margin-top: 16px">
          <h3>历史待核</h3>
          <el-button
            v-if="store.legacyPending"
            link
            type="primary"
            @click="backfill()"
          >
            全部补齐
          </el-button>
        </div>
        <template v-if="legacyGroups.length">
          <div v-for="group in legacyGroups" :key="group.kind" class="legacy-group">
            <div>
              <el-tag type="warning" effect="plain">{{ kindLabels[group.kind] }}</el-tag>
              <span class="muted" style="margin-left: 8px">{{ group.keys.length }} 项待核</span>
            </div>
            <el-button size="small" @click="backfill(group.kind)">补齐修订链</el-button>
          </div>
          <p class="muted">旧数据缺少修订链，补齐前不能锁定新基线。</p>
        </template>
        <el-alert
          v-else
          title="历史数据均已登记修订链，可以锁定新基线。"
          type="success"
          :closable="false"
          show-icon
        />
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <h3>字段冲突裁决</h3>
        <el-tag :type="pendingConflicts.length ? 'danger' : 'success'" effect="plain">
          {{ pendingConflicts.length }} 项待裁决
        </el-tag>
      </div>
      <el-table :data="[...pendingConflicts, ...resolvedConflicts]" max-height="360">
        <el-table-column prop="objectLabel" label="对象" min-width="160" />
        <el-table-column label="字段" width="110">
          <template #default="{ row }">{{ fieldLabels[row.field] ?? row.field }}</template>
        </el-table-column>
        <el-table-column label="基线值" min-width="130">
          <template #default="{ row }">
            <span class="diff-before">{{ fmtValue(row.baseValue) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="调度端值" min-width="130">
          <template #default="{ row }">
            <span :class="{ 'diff-after': row.resolution === 'local' }">
              {{ fmtValue(row.localValue) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="站端值" min-width="130">
          <template #default="{ row }">
            <span :class="{ 'diff-after': row.resolution === 'remote' }">
              {{ fmtValue(row.remoteValue) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="裁决" width="190" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'pending'">
              <el-button size="small" @click="choose(row, 'local')">选调度端</el-button>
              <el-button size="small" type="primary" plain @click="choose(row, 'remote')">
                选站端
              </el-button>
            </template>
            <el-tag v-else type="success" effect="plain">
              已采用{{ row.resolution === 'local' ? '调度端' : '站端' }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
      <el-empty
        v-if="!pendingConflicts.length && !resolvedConflicts.length"
        description="暂无冲突：同一字段相对锁定基线两边都改过时会在此保留两份待选择"
      />
    </section>
  </div>
</template>

<style scoped>
.sync-grid {
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.2fr) minmax(0, 1fr);
}

.revision-timeline {
  max-height: 420px;
  padding-left: 2px;
  overflow: auto;
}

.revision-summary {
  margin: 6px 0 2px;
  color: #33414e;
}

.legacy-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid #e7ecf0;
}
</style>
