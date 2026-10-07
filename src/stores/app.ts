import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  ChainObjectKind,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  SyncBatch,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { recomputeIssues, scenarioFingerprint } from '@/services/validation'
import {
  appendAuditOnce,
  appendCommentOnce,
  appendRevision,
  createId,
  now,
  touchObjects,
} from '@/services/revision'
import {
  planSyncOps,
  resolveConflict as resolveConflictInState,
} from '@/services/merge'
import { applySyncBatchRequest, fetchState, persistState } from '@/api/client'

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

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )
  const pendingConflicts = computed(() =>
    data.value.conflicts.filter((conflict) => conflict.status === 'pending'),
  )
  const legacyPending = computed(() => data.value.legacyKeys.length > 0)

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(clone(data.value))
      data.value = saved
      lastMessage.value = message
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>, idempotencyKey?: string) {
    appendAuditOnce(data.value, entry, idempotencyKey)
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    const item = { ...device, id: createId('device') }
    data.value.devices.push(item)
    touchObjects(data.value, 'device', [item.id], `新增设备 ${item.name}`)
    recomputeIssues(data.value)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
    })
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    data.value.devices[index] = { ...device, operationModes: [...device.operationModes] }
    touchObjects(data.value, 'device', [device.id], `更新设备 ${device.name}`)
    recomputeIssues(data.value)
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}。`,
    })
    await commit(`已更新 ${device.name}`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const next = { ...setting, updatedAt: now() }
    if (index >= 0) data.value.settings[index] = next
    else data.value.settings.push(next)
    touchObjects(
      data.value,
      'setting',
      [next.id],
      `${index >= 0 ? '修改' : '新增'}定值 ${setting.relayId} ${setting.stage} 段`,
    )
    recomputeIssues(data.value)
    appendAudit({
      action: index >= 0 ? '修改定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail: `电流 ${setting.currentA}A，时限 ${setting.timeS}s。`,
    })
    await commit('定值已保存')
  }

  async function runValidation() {
    recomputeIssues(data.value)
    appendAudit({
      action: '批量校验',
      target: '全部保护定值',
      operator: '当前用户',
      detail: `生成 ${data.value.issues.filter((issue) => !issue.stale).length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) data.value.issues[index] = issue
    touchObjects(data.value, 'issue', [issue.id], `校核结果状态更新为 ${issue.status}`)
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    const id = createId('comment')
    appendCommentOnce(data.value, { ...comment, id })
    touchObjects(data.value, 'comment', [id], `提交会签意见（${comment.targetId}）`)
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
    scenario.status = status
    if (status === 'approved') {
      // 批准时登记校核指纹：此后场景动作或涉及定值变化，批准结论即失效
      scenario.reviewFingerprint = scenarioFingerprint(scenario, data.value.settings)
    }
    touchObjects(data.value, 'scenario', [id], `场景状态流转为 ${status}`)
    recomputeIssues(data.value)
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新')
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
    touchObjects(data.value, 'scenario', [item.id], `新增故障场景 ${item.name}`)
    recomputeIssues(data.value)
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
      snapshot: clone(data.value.settings),
      deviceSnapshot: clone(data.value.devices),
      scenarioSnapshot: clone(data.value.scenarios),
      revisionId: data.value.heads.dispatch ?? undefined,
      checksum: checksum(data.value.settings),
    }
    data.value.baselines.unshift(baseline)
    touchObjects(data.value, 'baseline', [baseline.id], `创建基线 ${baseline.version} 上会签`)
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
    if (data.value.legacyKeys.length) {
      throw new Error(
        `存在 ${data.value.legacyKeys.length} 项历史待核数据，补齐修订链前不能锁定新基线`,
      )
    }
    if (pendingConflicts.value.length) {
      throw new Error('存在待裁决的双端冲突，裁决完成前不能锁定新基线')
    }
    if (
      data.value.issues.some(
        (issue) => !issue.stale && issue.level === 'high' && issue.status !== 'closed',
      )
    ) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    baseline.status = 'locked'
    baseline.lockedAt = now()
    baseline.revisionId = data.value.heads.dispatch ?? undefined
    data.value.activeBaselineId = baseline.id
    appendRevision(data.value, {
      side: 'dispatch',
      kind: 'baseline',
      objectKeys: [`baseline:${baseline.id}`],
      summary: `锁定基线 ${baseline.version}，作为后续三向合并的比较基准`,
    })
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}。`,
    })
    await commit('基线已锁定')
  }

  /**
   * 演示入口：模拟电网恢复前调度端与站端各自离线维护。
   * 站端改动写入离线副本并登记站端修订，本端改动走正常修订链，
   * 其中 201 线路 I 段电流定值两边都会改，用于产生双端冲突。
   */
  async function simulateOfflineEdits() {
    const nonce = data.value.syncBatches.length
    if (!data.value.remote) {
      data.value.remote = {
        devices: clone(data.value.devices),
        settings: clone(data.value.settings),
        scenarios: clone(data.value.scenarios),
        issues: clone(data.value.issues),
        comments: clone(data.value.comments),
        updatedAt: now(),
      }
    }
    const remote = data.value.remote
    const stationKeys: string[] = []

    const remoteTime = remote.settings.find((item) => item.id === 'set-l101-2')
    if (remoteTime) {
      remoteTime.timeS = Number((0.65 + nonce * 0.05).toFixed(2))
      remoteTime.updatedAt = now()
      stationKeys.push('setting:set-l101-2')
    }
    const remoteCurrent = remote.settings.find((item) => item.id === 'set-l201-1')
    if (remoteCurrent) {
      remoteCurrent.currentA = Number((6.4 + nonce * 0.1).toFixed(1))
      remoteCurrent.updatedAt = now()
      stationKeys.push('setting:set-l201-1')
    }
    const remoteLine = remote.devices.find((item) => item.id === 'line-202')
    if (remoteLine) {
      remoteLine.status = 'running'
      stationKeys.push('device:line-202')
    }
    const remoteScenario = remote.scenarios.find((item) => item.id === 'sc-202-mode-b')
    if (remoteScenario) {
      remoteScenario.notes = `站端离线复核：运行方式切换后灵敏度满足要求（第 ${nonce + 1} 轮）。`
      const step = remoteScenario.steps[0]
      if (step) step.delayMs = 480 + nonce * 10
      stationKeys.push('scenario:sc-202-mode-b')
    }
    const remoteCommentId = `comment-remote-${nonce}`
    if (!remote.comments.some((item) => item.id === remoteCommentId)) {
      remote.comments.unshift({
        id: remoteCommentId,
        targetType: 'baseline',
        targetId: data.value.activeBaselineId ?? data.value.baselines[0]?.id ?? '',
        author: '站端 王工',
        content: '站端离线复核通过，建议按合并结果归档。',
        createdAt: now(),
        status: 'open',
        idempotencyKey: `remote-comment-${nonce}`,
      })
    }
    remote.updatedAt = now()
    appendRevision(data.value, {
      side: 'station',
      kind: 'edit',
      objectKeys: stationKeys,
      summary: '站端离线维护：调整定值、设备状态与场景动作',
    })

    const localSetting = data.value.settings.find((item) => item.id === 'set-l201-1')
    if (localSetting) {
      localSetting.currentA = Number((6.6 + nonce * 0.1).toFixed(1))
      localSetting.updatedAt = now()
    }
    const localBreaker = data.value.devices.find((item) => item.id === 'breaker-101')
    if (localBreaker) localBreaker.status = 'maintenance'
    touchObjects(data.value, 'setting', ['set-l201-1'], '调度端离线调整 201 线路 I 段电流定值')
    touchObjects(data.value, 'device', ['breaker-101'], '调度端将 101 断路器转检修')
    recomputeIssues(data.value)
    appendAudit({
      action: '模拟离线改动',
      target: '调度端 / 站端',
      operator: '系统',
      detail: '双端各自离线维护完成，恢复通讯后可执行同步合并。',
    })
    await commit('已模拟双端离线改动')
  }

  /** 执行同步合并；保存失败时批次现场已保留在库中，重新拉取后可重试 */
  async function runSyncMerge(simulateFailure: boolean) {
    if (!data.value.remote) throw new Error('暂无站端离线副本，请先模拟双端离线改动')
    const ops = planSyncOps(data.value)
    if (!ops.length) throw new Error('双端数据一致，无需合并')
    const batch: SyncBatch = {
      id: createId('batch'),
      side: 'station',
      createdAt: now(),
      attempt: 1,
      status: 'open',
      ops,
    }
    data.value.syncBatches.unshift(batch)
    saving.value = true
    try {
      const saved = await applySyncBatchRequest(clone(data.value), batch.id, simulateFailure)
      data.value = saved
      lastMessage.value = '同步合并完成'
      return saved.syncBatches.find((item) => item.id === batch.id)
    } catch (error) {
      data.value = await fetchState()
      lastMessage.value = '部分对象保存失败，未完成批次已保留，可重试补合并'
      throw error
    } finally {
      saving.value = false
    }
  }

  /** 重试未完成批次：只补尚未合并的对象，审计与会签记录按幂等键去重 */
  async function retryBatch(batchId: string) {
    const batch = data.value.syncBatches.find((item) => item.id === batchId)
    if (!batch) return
    batch.attempt += 1
    saving.value = true
    try {
      const saved = await applySyncBatchRequest(clone(data.value), batchId, false)
      data.value = saved
      lastMessage.value = '批次重试完成'
    } catch (error) {
      data.value = await fetchState()
      lastMessage.value = '重试仍未完成，批次现场已保留'
      throw error
    } finally {
      saving.value = false
    }
  }

  async function resolveConflict(conflictId: string, choice: 'local' | 'remote') {
    resolveConflictInState(data.value, conflictId, choice)
    await commit('冲突裁决已生效')
  }

  /** 历史待核数据补齐修订链；全部补齐前不能锁定新基线 */
  async function backfillLegacy(kind?: ChainObjectKind) {
    const keys = kind
      ? data.value.legacyKeys.filter((key) => key.startsWith(`${kind}:`))
      : [...data.value.legacyKeys]
    if (!keys.length) return
    appendRevision(data.value, {
      side: 'dispatch',
      kind: 'migrate',
      objectKeys: keys,
      summary: `历史待核数据补齐修订链（${keys.length} 项）`,
    })
    data.value.legacyKeys = data.value.legacyKeys.filter((key) => !keys.includes(key))
    appendAudit({
      action: '补齐修订链',
      target: `${keys.length} 个历史对象`,
      operator: '当前用户',
      detail: keys.join('、'),
    })
    await commit('历史数据修订链已补齐')
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
    devices,
    settings,
    issues,
    scenarios,
    activeBaseline,
    pendingConflicts,
    legacyPending,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createBaseline,
    approveBaseline,
    simulateOfflineEdits,
    runSyncMerge,
    retryBatch,
    resolveConflict,
    backfillLegacy,
    recordExport,
    reset,
  }
})
