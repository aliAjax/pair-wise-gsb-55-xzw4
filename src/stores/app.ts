import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  FieldValue,
  MergeBatch,
  MergeBatchEntry,
  MergeObjectKind,
  MergeSide,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  RevisionOutcome,
  RevisionRecord,
  ScenarioStep,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import {
  baseCollectionOf,
  buildPeerBatch,
  collectionOf,
  fieldLabel,
  formatFieldValue,
  objectLabel,
  outcomeLabels,
  readField,
  sideLabels,
  trackedFields,
  valuesEqual,
  writeField,
} from '@/services/merge'
import { armNextSaveFailure, persistState } from '@/api/client'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')
  const failureArmed = ref(false)

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const conflicts = computed(() => data.value.conflicts)
  const pendingConflicts = computed(() =>
    data.value.conflicts.filter((conflict) => conflict.status === 'pending'),
  )
  const mergeBatches = computed(() => data.value.mergeBatches)
  const revisionChain = computed(() => data.value.revisionChain)
  const legacyPending = computed(() => data.value.legacyPending)
  const currentSide = computed(() => data.value.currentSide)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = message
    } catch (error) {
      failureArmed.value = false
      throw error
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    // 带 dedupeKey 的审计记录幂等：批次重试不会重复新增
    if (entry.dedupeKey && data.value.audit.some((item) => item.dedupeKey === entry.dedupeKey)) {
      return
    }
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  function addCommentLocal(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    if (
      comment.dedupeKey &&
      data.value.comments.some((item) => item.dedupeKey === comment.dedupeKey)
    ) {
      return
    }
    data.value.comments.unshift({
      ...comment,
      id: createId('comment'),
      createdAt: now(),
    })
  }

  function pushRevision(input: {
    objectKind: MergeObjectKind
    objectId: string
    field: string
    baseValue: FieldValue
    value: FieldValue
    outcome: RevisionOutcome
    side?: MergeSide
    batchId?: string | null
  }) {
    data.value.revisionChain.unshift({
      id: createId('rev'),
      batchId: input.batchId ?? null,
      side: input.side ?? data.value.currentSide,
      objectKind: input.objectKind,
      objectId: input.objectId,
      field: input.field,
      baseValue: input.baseValue,
      value: input.value,
      outcome: input.outcome,
      createdAt: now(),
    })
  }

  function recordChanges(kind: 'device' | 'setting' | 'scenario', before: object, after: object) {
    const objectId = readField(after, 'id')
    trackedFields[kind].forEach((field) => {
      const previous = readField(before, field)
      const next = readField(after, field)
      if (!valuesEqual(previous, next)) {
        pushRevision({ objectKind: kind, objectId: String(objectId), field, baseValue: previous, value: next, outcome: 'local' })
      }
    })
  }

  /** 设备变更的影响面：自身、下级子孙设备及其相关定值与保护装置 */
  function expandDeviceImpact(deviceId: string): string[] {
    const deviceIds = new Set([deviceId])
    let grew = true
    while (grew) {
      grew = false
      data.value.devices.forEach((device) => {
        if (device.parentId && deviceIds.has(device.parentId) && !deviceIds.has(device.id)) {
          deviceIds.add(device.id)
          grew = true
        }
      })
    }
    const impacted = new Set(deviceIds)
    data.value.settings.forEach((setting) => {
      if (deviceIds.has(setting.relayId) || deviceIds.has(setting.protectedDeviceId)) {
        impacted.add(setting.id)
        impacted.add(setting.relayId)
        impacted.add(setting.protectedDeviceId)
      }
    })
    return [...impacted]
  }

  /**
   * 依赖驱动的校核失效重算：只重算依赖被变更对象的校核结果，
   * 未受影响的校核结果（含处理状态）保持不动；已锁定基线快照不参与重算。
   */
  function recomputeIssues(changedIds: string[] | 'all', reason: string) {
    const relevant = (issue: ValidationIssue) =>
      changedIds === 'all' || (issue.dependsOn ?? []).some((id) => changedIds.includes(id))
    const existing = data.value.issues
    const affected = existing.filter(relevant)
    const freshRelevant = validateSettings(data.value.settings, data.value.devices).filter(relevant)
    if (!affected.length && !freshRelevant.length) return
    const affectedIds = new Set(affected.map((issue) => issue.id))
    const kept = existing.filter((issue) => !affectedIds.has(issue.id))
    const recomputed = freshRelevant.map((issue) => {
      const previous = existing.find((item) => item.id === issue.id)
      return {
        ...issue,
        status: previous?.status ?? 'open',
        createdAt: previous?.createdAt ?? issue.createdAt,
        recomputedAt: now(),
      }
    })
    data.value.issues = [...kept, ...recomputed]
    pushRevision({
      objectKind: 'issue',
      objectId: 'auto-recompute',
      field: 'recompute',
      baseValue: affected.length,
      value: recomputed.length,
      outcome: 'auto',
    })
    appendAudit({
      action: '校核失效重算',
      target: reason,
      operator: '系统',
      detail: `${affected.length} 条依赖校核失效，重算后保留 ${recomputed.length} 条。`,
    })
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    const item = { ...device, id: createId('device') }
    data.value.devices.push(item)
    pushRevision({
      objectKind: 'device',
      objectId: item.id,
      field: '__created__',
      baseValue: null,
      value: item.code,
      outcome: 'local',
    })
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
    })
    recomputeIssues('all', `新增设备 ${item.name}`)
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    const next = { ...device, operationModes: [...device.operationModes] }
    recordChanges('device', data.value.devices[index], next)
    data.value.devices[index] = next
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}。`,
    })
    recomputeIssues(expandDeviceImpact(device.id), `设备 ${device.name} 变更`)
    await commit(`已更新 ${device.name}`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const next = { ...setting, updatedAt: now() }
    if (index >= 0) {
      recordChanges('setting', data.value.settings[index], next)
      data.value.settings[index] = next
    } else {
      data.value.settings.push(next)
      pushRevision({
        objectKind: 'setting',
        objectId: next.id,
        field: '__created__',
        baseValue: null,
        value: next.stage,
        outcome: 'local',
      })
    }
    appendAudit({
      action: index >= 0 ? '修改定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s。`,
    })
    recomputeIssues([next.id, next.relayId, next.protectedDeviceId], `定值 ${next.id} 变更`)
    await commit('定值已保存')
  }

  async function runValidation() {
    const fresh = validateSettings(data.value.settings, data.value.devices)
    const previous = new Map(data.value.issues.map((issue) => [issue.id, issue]))
    data.value.issues = fresh.map((issue) => ({
      ...issue,
      status: previous.get(issue.id)?.status ?? 'open',
      createdAt: previous.get(issue.id)?.createdAt ?? issue.createdAt,
    }))
    pushRevision({
      objectKind: 'issue',
      objectId: 'all',
      field: 'issues',
      baseValue: previous.size,
      value: fresh.length,
      outcome: 'local',
    })
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index < 0) return
    const previous = data.value.issues[index]
    if (previous.status !== issue.status) {
      pushRevision({
        objectKind: 'issue',
        objectId: issue.id,
        field: 'status',
        baseValue: previous.status,
        value: issue.status,
        outcome: 'local',
      })
    }
    data.value.issues[index] = issue
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    addCommentLocal(comment)
    appendAudit({
      action: '提交会签意见',
      target: comment.targetId,
      operator: comment.author,
      detail: comment.content,
    })
    await commit('意见已提交')
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    const previous = scenario.status
    scenario.status = status
    pushRevision({
      objectKind: 'scenario',
      objectId: scenario.id,
      field: 'status',
      baseValue: previous,
      value: status,
      outcome: 'local',
    })
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新')
  }

  async function updateScenarioStep(
    scenarioId: string,
    sequence: number,
    status: ScenarioStep['status'],
  ) {
    const scenario = data.value.scenarios.find((item) => item.id === scenarioId)
    const step = scenario?.steps.find((item) => item.sequence === sequence)
    if (!scenario || !step || step.status === status) return
    const previous = step.status
    step.status = status
    pushRevision({
      objectKind: 'scenario',
      objectId: scenario.id,
      field: `step${sequence}.status`,
      baseValue: previous,
      value: status,
      outcome: 'local',
    })
    appendAudit({
      action: '调整场景动作',
      target: scenario.name,
      operator: '当前用户',
      detail: `动作 ${sequence} 执行状态由 ${previous} 调整为 ${status}。`,
    })
    recomputeIssues([step.relayId], `场景「${scenario.name}」动作调整`)
    await commit('场景动作已更新')
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: now(),
    }
    data.value.scenarios.unshift(item)
    pushRevision({
      objectKind: 'scenario',
      objectId: item.id,
      field: '__created__',
      baseValue: null,
      value: item.name,
      outcome: 'local',
    })
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      snapshot: JSON.parse(JSON.stringify(data.value.settings)) as ProtectionSetting[],
      deviceSnapshot: JSON.parse(JSON.stringify(data.value.devices)) as Device[],
      scenarioSnapshot: JSON.parse(JSON.stringify(data.value.scenarios)) as AppState['scenarios'],
      checksum: checksum(data.value.settings),
    }
    data.value.baselines.unshift(baseline)
    pushRevision({
      objectKind: 'baseline',
      objectId: baseline.id,
      field: '__created__',
      baseValue: null,
      value: baseline.version,
      outcome: 'local',
    })
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: note,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    if (data.value.legacyPending) {
      throw new Error('历史数据缺少修订链（历史待核），补齐前不能锁定新基线')
    }
    const pending = pendingConflicts.value.length
    if (pending > 0) {
      throw new Error(`存在 ${pending} 条待裁决合并冲突，不能锁定新基线`)
    }
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    baseline.status = 'locked'
    baseline.lockedAt = now()
    data.value.activeBaselineId = baseline.id
    // 锁定基线成为新的三方合并基准，快照内容此后保持冻结
    data.value.mergeBase = {
      baselineId: baseline.id,
      devices: JSON.parse(
        JSON.stringify(baseline.deviceSnapshot ?? data.value.devices),
      ) as Device[],
      settings: JSON.parse(JSON.stringify(baseline.snapshot)) as ProtectionSetting[],
      scenarios: JSON.parse(
        JSON.stringify(baseline.scenarioSnapshot ?? data.value.scenarios),
      ) as AppState['scenarios'],
    }
    pushRevision({
      objectKind: 'baseline',
      objectId: baseline.id,
      field: 'locked',
      baseValue: 'reviewing',
      value: 'locked',
      outcome: 'local',
    })
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}，合并基准已推进到该版本。`,
    })
    await commit('基线已锁定')
  }

  /** 为缺少修订链的历史数据补齐创世修订，解除历史待核 */
  async function completeLegacyChain() {
    if (!data.value.legacyPending) return
    data.value.devices.forEach((device) =>
      pushRevision({
        objectKind: 'device',
        objectId: device.id,
        field: '__genesis__',
        baseValue: null,
        value: device.code,
        outcome: 'genesis',
      }),
    )
    data.value.settings.forEach((setting) =>
      pushRevision({
        objectKind: 'setting',
        objectId: setting.id,
        field: '__genesis__',
        baseValue: null,
        value: setting.stage,
        outcome: 'genesis',
      }),
    )
    data.value.scenarios.forEach((scenario) =>
      pushRevision({
        objectKind: 'scenario',
        objectId: scenario.id,
        field: '__genesis__',
        baseValue: null,
        value: scenario.name,
        outcome: 'genesis',
      }),
    )
    data.value.baselines.forEach((baseline) =>
      pushRevision({
        objectKind: 'baseline',
        objectId: baseline.id,
        field: '__genesis__',
        baseValue: null,
        value: baseline.version,
        outcome: 'genesis',
      }),
    )
    pushRevision({
      objectKind: 'issue',
      objectId: 'legacy',
      field: 'issues',
      baseValue: null,
      value: data.value.issues.length,
      outcome: 'genesis',
    })
    data.value.legacyPending = false
    appendAudit({
      action: '补齐修订链',
      target: '历史数据',
      operator: '当前用户',
      detail: `补齐 ${data.value.revisionChain.length} 条创世修订，历史待核解除，可恢复基线锁定。`,
    })
    await commit('修订链已补齐，历史待核解除')
  }

  async function setSide(side: MergeSide) {
    if (data.value.currentSide === side) return
    data.value.currentSide = side
    appendAudit({
      action: '切换维护端',
      target: sideLabels[side],
      operator: '当前用户',
      detail: `当前离线维护端切换为${sideLabels[side]}。`,
    })
    await commit('已切换维护端')
  }

  /** 接收对端离线批次：条目进入待合并队列，不改动工作状态 */
  async function createPeerBatch() {
    const peerSide: MergeSide = data.value.currentSide === 'dispatch' ? 'station' : 'dispatch'
    const batch = buildPeerBatch(data.value, peerSide, createId)
    data.value.mergeBatches.unshift(batch)
    appendAudit({
      action: '接收对端批次',
      target: batch.title,
      operator: '系统',
      detail: `${batch.entries.length} 条对端修订待合并。`,
    })
    await commit('对端离线批次已接收')
    return batch
  }

  function chainRecordFromEntry(entry: MergeBatchEntry): RevisionRecord {
    return {
      id: entry.id,
      batchId: entry.batchId,
      side: entry.side,
      objectKind: entry.objectKind,
      objectId: entry.objectId,
      field: entry.field,
      baseValue: entry.baseValue,
      value: entry.value,
      outcome: entry.outcome,
      createdAt: entry.createdAt,
    }
  }

  function upsertConflict(
    batch: MergeBatch,
    entry: MergeBatchEntry,
    baseValue: FieldValue,
    currentValue: FieldValue,
  ) {
    const existing = data.value.conflicts.find(
      (item) =>
        item.status === 'pending' &&
        item.objectKind === entry.objectKind &&
        item.objectId === entry.objectId &&
        item.field === entry.field,
    )
    if (existing) {
      existing.peerValue = entry.value
      existing.entryId = entry.id
      return
    }
    data.value.conflicts.unshift({
      id: createId('conflict'),
      entryId: entry.id,
      objectKind: entry.objectKind,
      objectId: entry.objectId,
      field: entry.field,
      baseValue,
      localValue: currentValue,
      peerValue: entry.value,
      localSide: data.value.currentSide,
      peerSide: batch.side,
      status: 'pending',
    })
  }

  /**
   * 逐条合并批次条目（幂等：已合并条目直接跳过，重试只补尚未合并对象）。
   * 裁决只依据“相对上次锁定基线哪边改了”，不看保存先后：
   *  - 仅对端改动 → 自动合并落值
   *  - 双边改动一致 → 自动收敛
   *  - 双边改动不一致 → 生成冲突，两份值都保留待选择
   */
  function applyBatchEntries(batch: MergeBatch) {
    const result = { auto: 0, conflict: 0, convergent: 0, skipped: 0 }
    const changedIds: string[] = []
    batch.entries.forEach((entry) => {
      if (entry.merged) return
      const collection = collectionOf(data.value, entry.objectKind)
      const baseCollection = baseCollectionOf(data.value, entry.objectKind)
      const target = collection?.find((item) => item.id === entry.objectId)
      if (!target) {
        entry.outcome = 'skipped'
        entry.merged = true
        data.value.revisionChain.unshift(chainRecordFromEntry(entry))
        result.skipped += 1
        return
      }
      const baseTarget = baseCollection?.find((item) => item.id === entry.objectId)
      const currentValue = readField(target, entry.field)
      const baseValue = baseTarget ? readField(baseTarget, entry.field) : entry.baseValue
      if (valuesEqual(entry.value, baseValue) || valuesEqual(currentValue, entry.value)) {
        entry.outcome = 'convergent'
        result.convergent += 1
      } else if (valuesEqual(currentValue, baseValue)) {
        writeField(target, entry.field, entry.value)
        entry.outcome = 'auto'
        result.auto += 1
        changedIds.push(entry.objectId)
      } else {
        entry.outcome = 'conflict'
        result.conflict += 1
        upsertConflict(batch, entry, baseValue, currentValue)
      }
      entry.merged = true
      data.value.revisionChain.unshift(chainRecordFromEntry(entry))
      appendAudit({
        dedupeKey: `merge-entry:${entry.id}`,
        action: '合并对端修订',
        target: objectLabel(data.value, entry.objectKind, entry.objectId),
        operator: '系统',
        detail: `${fieldLabel(entry.objectKind, entry.field)}：${outcomeLabels[entry.outcome]}。`,
      })
    })
    const impacted = [
      ...new Set(
        changedIds.flatMap((id) =>
          data.value.devices.some((device) => device.id === id) ? expandDeviceImpact(id) : [id],
        ),
      ),
    ]
    if (impacted.length) recomputeIssues(impacted, `批次「${batch.title}」合并`)
    return result
  }

  async function mergeBatch(batchId: string) {
    const batch = data.value.mergeBatches.find((item) => item.id === batchId)
    if (!batch || batch.status === 'merged') return
    batch.attempts += 1
    batch.error = undefined
    const result = applyBatchEntries(batch)
    addCommentLocal({
      dedupeKey: `merge-summary:${batch.id}`,
      targetType: 'merge',
      targetId: batch.id,
      author: '系统',
      content: `批次合并：自动合并 ${result.auto} 条，双方一致 ${result.convergent} 条，冲突待裁决 ${result.conflict} 条，对象缺失 ${result.skipped} 条。`,
      status: 'open',
    })
    batch.status = 'merged'
    batch.mergedAt = now()
    try {
      await commit('对端批次合并完成')
    } catch (error) {
      // 保存失败：批次保留为失败态，已完成条目不回滚，重试仅补未合并对象
      batch.status = 'failed'
      batch.error = error instanceof Error ? error.message : '保存失败'
      appendAudit({
        dedupeKey: `merge-fail:${batch.id}:${batch.attempts}`,
        action: '批次合并失败',
        target: batch.title,
        operator: '系统',
        detail: `第 ${batch.attempts} 次保存失败，已完成 ${batch.entries.filter((entry) => entry.merged).length}/${batch.entries.length} 条，重试仅补未合并对象。`,
      })
      throw error
    }
  }

  /** 人工裁决冲突：明确选择采用哪一端的两份保留值之一 */
  async function resolveConflict(conflictId: string, side: MergeSide) {
    const conflict = data.value.conflicts.find((item) => item.id === conflictId)
    if (!conflict || conflict.status === 'resolved') return
    const value = side === conflict.localSide ? conflict.localValue : conflict.peerValue
    const collection = collectionOf(data.value, conflict.objectKind)
    const target = collection?.find((item) => item.id === conflict.objectId)
    if (target) writeField(target, conflict.field, value)
    conflict.status = 'resolved'
    conflict.resolvedValue = value
    conflict.resolvedSide = side
    conflict.resolvedAt = now()
    pushRevision({
      objectKind: conflict.objectKind,
      objectId: conflict.objectId,
      field: conflict.field,
      baseValue: conflict.baseValue,
      value,
      outcome: 'resolved',
    })
    appendAudit({
      dedupeKey: `conflict-resolve:${conflict.id}`,
      action: '裁决合并冲突',
      target: objectLabel(data.value, conflict.objectKind, conflict.objectId),
      operator: '当前用户',
      detail: `字段「${fieldLabel(conflict.objectKind, conflict.field)}」采用${sideLabels[side]}值 ${formatFieldValue(conflict.objectKind, conflict.field, value)}。`,
    })
    const impacted =
      conflict.objectKind === 'device'
        ? expandDeviceImpact(conflict.objectId)
        : [conflict.objectId]
    recomputeIssues(impacted, `冲突裁决 ${objectLabel(data.value, conflict.objectKind, conflict.objectId)}`)
    await commit('冲突已裁决')
  }

  function armFailureSimulation() {
    armNextSaveFailure()
    failureArmed.value = true
  }

  async function recordExport(format: string, count: number) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `导出 ${count} 条保护定值。`,
    })
    await commit('导出记录已写入审计')
  }

  async function reset() {
    data.value = createInitialState()
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    failureArmed,
    devices,
    settings,
    issues,
    scenarios,
    conflicts,
    pendingConflicts,
    mergeBatches,
    revisionChain,
    legacyPending,
    currentSide,
    activeBaseline,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    updateScenarioStep,
    addScenario,
    createBaseline,
    approveBaseline,
    completeLegacyChain,
    setSide,
    createPeerBatch,
    mergeBatch,
    resolveConflict,
    armFailureSimulation,
    recordExport,
    reset,
  }
})
