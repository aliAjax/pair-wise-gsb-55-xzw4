import type {
  AppState,
  Device,
  FaultScenario,
  FieldConflict,
  MergeableKind,
  ProtectionSetting,
  SyncBatch,
  SyncOp,
} from '@/types/domain'
import {
  appendAuditOnce,
  appendCommentOnce,
  appendRevision,
  now,
  objectKey,
} from '@/services/revision'
import { recomputeIssues } from '@/services/validation'

type Mergeable = Device | ProtectionSetting | FaultScenario

/** 参与三向合并的业务字段（updatedAt、createdAt 等元数据不参与裁决） */
export const MERGE_FIELDS: Record<MergeableKind, string[]> = {
  device: ['code', 'name', 'kind', 'station', 'voltage', 'parentId', 'status', 'operationModes'],
  setting: [
    'relayId',
    'protectedDeviceId',
    'stage',
    'currentA',
    'timeS',
    'direction',
    'sensitivity',
    'recloseEnabled',
    'recloseDelayS',
    'startCondition',
  ],
  scenario: [
    'name',
    'operationMode',
    'faultDeviceId',
    'faultType',
    'status',
    'steps',
    'outageDevices',
    'notes',
  ],
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const eq = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const fieldOf = (obj: Mergeable | undefined, field: string): unknown =>
  obj ? (obj as unknown as Record<string, unknown>)[field] : undefined

function liveCollection(state: AppState, kind: MergeableKind): Mergeable[] {
  if (kind === 'device') return state.devices
  if (kind === 'setting') return state.settings
  return state.scenarios
}

function remoteCollection(state: AppState, kind: MergeableKind): Mergeable[] {
  const remote = state.remote
  if (!remote) return []
  if (kind === 'device') return remote.devices
  if (kind === 'setting') return remote.settings
  return remote.scenarios
}

export interface MergeBase {
  baseline: AppState['baselines'][number] | undefined
  devices: Device[]
  settings: ProtectionSetting[]
  scenarios: FaultScenario[]
}

/** 合并基线：最近一次锁定的基线快照，是三向合并唯一的比较基准 */
export function mergeBaseOf(state: AppState): MergeBase {
  const locked = state.baselines
    .filter((item) => item.status === 'locked')
    .sort((a, b) => (b.lockedAt ?? '').localeCompare(a.lockedAt ?? ''))[0]
  return {
    baseline: locked,
    devices: clone(locked?.deviceSnapshot ?? []),
    settings: clone(locked?.snapshot ?? []),
    scenarios: clone(locked?.scenarioSnapshot ?? []),
  }
}

function baseCollection(base: MergeBase, kind: MergeableKind): Mergeable[] {
  if (kind === 'device') return base.devices
  if (kind === 'setting') return base.settings
  return base.scenarios
}

function objectLabel(state: AppState, kind: MergeableKind, obj: Mergeable | undefined): string {
  if (!obj) return '未知对象'
  if (kind === 'device') return (obj as Device).name
  if (kind === 'scenario') return (obj as FaultScenario).name
  const setting = obj as ProtectionSetting
  const relay =
    state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
  return `${relay} ${setting.stage} 段`
}

export interface FieldChange {
  field: string
  baseValue: unknown
  localValue: unknown
  remoteValue: unknown
}

export interface ObjectMergeResult {
  /** null 表示合并结果为删除该对象 */
  merged: Mergeable | null
  conflicts: FieldChange[]
}

/**
 * 字段级三向合并。裁决只依据“相对上次锁定基线哪边改过”：
 * - 两边一致（含都未改、改成同值）→ 直接采用；
 * - 仅一边改过 → 自动合并该边的值；
 * - 两边都改成不同值 → 保留两份待人工选择，占位值回退基线。
 * 绝不比较保存时间先后，保存顺序不作为裁决依据。
 */
export function threeWayObject(
  base: Mergeable | undefined,
  local: Mergeable | undefined,
  remote: Mergeable | undefined,
  fields: string[],
): ObjectMergeResult {
  if (!local && !remote) return { merged: null, conflicts: [] }

  if (!remote) {
    if (!base) return { merged: clone(local as Mergeable), conflicts: [] }
    const localChanged = fields.some((field) => !eq(fieldOf(base, field), fieldOf(local, field)))
    if (!localChanged) return { merged: null, conflicts: [] }
    return {
      merged: clone(local as Mergeable),
      conflicts: [
        {
          field: '__object__',
          baseValue: '基线中存在',
          localValue: '调度端修改保留',
          remoteValue: '站端已删除',
        },
      ],
    }
  }

  if (!local) {
    if (!base) return { merged: clone(remote), conflicts: [] }
    const remoteChanged = fields.some((field) => !eq(fieldOf(base, field), fieldOf(remote, field)))
    if (!remoteChanged) return { merged: null, conflicts: [] }
    return {
      merged: clone(remote),
      conflicts: [
        {
          field: '__object__',
          baseValue: '基线中存在',
          localValue: '调度端已删除',
          remoteValue: '站端修改保留',
        },
      ],
    }
  }

  const merged = clone(local) as unknown as Record<string, unknown>
  const conflicts: FieldChange[] = []
  fields.forEach((field) => {
    const baseValue = fieldOf(base, field)
    const localValue = fieldOf(local, field)
    const remoteValue = fieldOf(remote, field)
    if (eq(localValue, remoteValue)) {
      merged[field] = clone(localValue)
      return
    }
    if (base && eq(baseValue, localValue)) {
      merged[field] = clone(remoteValue)
      return
    }
    if (base && eq(baseValue, remoteValue)) {
      merged[field] = clone(localValue)
      return
    }
    conflicts.push({
      field,
      baseValue: base ? baseValue : '（无基线）',
      localValue,
      remoteValue,
    })
    merged[field] = base ? clone(baseValue) : clone(localValue)
  })
  return { merged: merged as unknown as Mergeable, conflicts }
}

/** 汇总双端差异，生成同步批次的待合并对象清单 */
export function planSyncOps(state: AppState): SyncOp[] {
  if (!state.remote) return []
  const ops: SyncOp[] = []
  const kinds: MergeableKind[] = ['device', 'setting', 'scenario']
  kinds.forEach((kind) => {
    const live = liveCollection(state, kind)
    const remote = remoteCollection(state, kind)
    const ids = [...new Set([...live.map((item) => item.id), ...remote.map((item) => item.id)])]
    ids.forEach((id) => {
      const localObj = live.find((item) => item.id === id)
      const remoteObj = remote.find((item) => item.id === id)
      if (eq(localObj, remoteObj)) return
      ops.push({
        id: `${kind}:${id}`,
        kind,
        objectId: id,
        label: objectLabel(state, kind, localObj ?? remoteObj),
        status: 'pending',
      })
    })
  })
  return ops
}

export interface RemoteDiff {
  kind: MergeableKind
  objectId: string
  label: string
  changedFields: string[]
}

/** 站端副本相对本端的差异，用于同步前预览 */
export function diffRemote(state: AppState): RemoteDiff[] {
  if (!state.remote) return []
  const diffs: RemoteDiff[] = []
  const kinds: MergeableKind[] = ['device', 'setting', 'scenario']
  kinds.forEach((kind) => {
    const live = liveCollection(state, kind)
    const remote = remoteCollection(state, kind)
    remote.forEach((remoteObj) => {
      const localObj = live.find((item) => item.id === remoteObj.id)
      const changedFields = MERGE_FIELDS[kind].filter(
        (field) => !eq(fieldOf(localObj, field), fieldOf(remoteObj, field)),
      )
      if (!localObj) {
        diffs.push({
          kind,
          objectId: remoteObj.id,
          label: objectLabel(state, kind, remoteObj),
          changedFields: ['（站端新增）'],
        })
      } else if (changedFields.length) {
        diffs.push({ kind, objectId: remoteObj.id, label: objectLabel(state, kind, remoteObj), changedFields })
      }
    })
    live.forEach((localObj) => {
      if (!remote.some((item) => item.id === localObj.id)) {
        diffs.push({
          kind,
          objectId: localObj.id,
          label: objectLabel(state, kind, localObj),
          changedFields: ['（站端删除）'],
        })
      }
    })
  })
  return diffs
}

function applyOneOp(state: AppState, batch: SyncBatch, op: SyncOp, base: MergeBase): boolean {
  const kind = op.kind as MergeableKind
  const live = liveCollection(state, kind)
  const remote = remoteCollection(state, kind)
  const baseList = baseCollection(base, kind)
  const localObj = live.find((item) => item.id === op.objectId)
  const remoteObj = remote.find((item) => item.id === op.objectId)
  const baseObj = baseList.find((item) => item.id === op.objectId)

  const { merged, conflicts } = threeWayObject(baseObj, localObj, remoteObj, MERGE_FIELDS[kind])

  const index = live.findIndex((item) => item.id === op.objectId)
  if (merged === null) {
    if (index >= 0) live.splice(index, 1)
  } else {
    const stamped = (
      kind === 'setting' ? { ...merged, updatedAt: now() } : merged
    ) as Mergeable
    if (index >= 0) live[index] = stamped
    else live.push(stamped)
  }

  // 冲突记录使用确定性 id，批次重试不会重复新增
  conflicts.forEach((conflict) => {
    const id = `${batch.id}:${kind}:${op.objectId}:${conflict.field}`
    if (state.conflicts.some((item) => item.id === id)) return
    const record: FieldConflict = {
      id,
      batchId: batch.id,
      kind,
      objectId: op.objectId,
      objectLabel: op.label,
      field: conflict.field,
      baseValue: conflict.baseValue,
      localValue: conflict.localValue,
      remoteValue: conflict.remoteValue,
      status: 'pending',
    }
    state.conflicts.push(record)
  })

  // 审计记录使用幂等键，批次重试不会重复新增
  appendAuditOnce(
    state,
    {
      action: '同步合并',
      target: op.label,
      operator: '系统',
      detail: conflicts.length
        ? `单边改动已自动合并，${conflicts.length} 个字段双端均改，保留两份待裁决。`
        : '相对锁定基线仅单边改动，已自动合并。',
    },
    `${batch.id}:${op.id}`,
  )

  return conflicts.length > 0
}

/** 会签意见按 id / 幂等键并入，重试与重复同步都不会重复新增 */
function mergeRemoteComments(state: AppState) {
  const remoteComments = state.remote?.comments ?? []
  remoteComments.forEach((comment) => {
    const before = state.comments.length
    appendCommentOnce(state, comment, comment.idempotencyKey ?? `remote-comment:${comment.id}`)
    if (state.comments.length > before) {
      appendAuditOnce(
        state,
        {
          action: '同步会签意见',
          target: comment.targetId,
          operator: comment.author,
          detail: comment.content,
        },
        `comment-sync:${comment.id}`,
      )
    }
  })
}

function finalizeBatchIfMerged(state: AppState, batch: SyncBatch) {
  if (batch.status !== 'merged') return
  // 双端收敛：站端副本对齐合并结果，两侧链头汇合
  state.remote = {
    devices: clone(state.devices),
    settings: clone(state.settings),
    scenarios: clone(state.scenarios),
    issues: clone(state.issues),
    comments: clone(state.comments),
    updatedAt: now(),
  }
  state.heads.station = state.heads.dispatch
  appendAuditOnce(
    state,
    {
      action: '同步批次完成',
      target: batch.id,
      operator: '系统',
      detail: `${batch.ops.length} 个对象合并完成，双端数据一致。`,
    },
    `batch-merged:${batch.id}`,
  )
}

/**
 * 应用同步批次：逐对象三向合并并落库。
 * 已合并对象直接跳过（重试只补尚未合并对象）；
 * 任一对象保存失败即中断，已完成的保留，未完成的留待重试；
 * 合并落库后立即对校核结果失效重算，锁定基线快照保持原样。
 */
export function applySyncBatch(
  state: AppState,
  batchId: string,
  options: { failFirstPending?: boolean } = {},
): SyncBatch {
  const batch = state.syncBatches.find((item) => item.id === batchId)
  if (!batch) throw new Error(`同步批次不存在：${batchId}`)
  const base = mergeBaseOf(state)
  const mergedKeys: string[] = []
  let failure = ''

  for (const op of batch.ops) {
    if (op.status === 'merged') continue
    if (failure) break
    if (options.failFirstPending) {
      options.failFirstPending = false
      op.status = 'failed'
      op.error = '站端通道中断，对象保存失败'
      failure = op.error
      break
    }
    try {
      const hasConflict = applyOneOp(state, batch, op, base)
      op.status = hasConflict ? 'conflict' : 'merged'
      op.error = undefined
      mergedKeys.push(objectKey(op.kind, op.objectId))
    } catch (error) {
      op.status = 'failed'
      op.error = error instanceof Error ? error.message : '对象保存失败'
      failure = op.error
    }
  }

  if (!failure) mergeRemoteComments(state)
  recomputeIssues(state)

  if (mergedKeys.length) {
    appendRevision(state, {
      side: 'dispatch',
      kind: 'merge',
      objectKeys: mergedKeys,
      summary: `合并站端离线改动（批次 ${batch.id}，第 ${batch.attempt} 次执行）`,
    })
  }

  batch.status = batch.ops.every((op) => op.status === 'merged')
    ? 'merged'
    : batch.ops.some((op) => op.status === 'failed')
      ? 'failed'
      : 'partial'

  if (failure) {
    appendAuditOnce(
      state,
      {
        action: '同步批次失败',
        target: batch.id,
        operator: '系统',
        detail: `${failure}；已合并 ${mergedKeys.length} 个对象并保留现场，其余待重试。`,
      },
      `batch-failed:${batch.id}:${batch.attempt}`,
    )
    throw new Error(`批次保存失败：${failure}`)
  }

  finalizeBatchIfMerged(state, batch)
  return batch
}

/**
 * 人工裁决字段冲突：明确选择调度端或站端的值，
 * 裁决结果同时写入双端副本使两侧收敛，并触发校核失效重算。
 */
export function resolveConflict(state: AppState, conflictId: string, choice: 'local' | 'remote') {
  const conflict = state.conflicts.find((item) => item.id === conflictId)
  if (!conflict || conflict.status !== 'pending') return
  const kind = conflict.kind as MergeableKind
  const live = liveCollection(state, kind)
  const remote = remoteCollection(state, kind)
  const target = live.find((item) => item.id === conflict.objectId)
  const remoteTarget = remote.find((item) => item.id === conflict.objectId)
  const value = choice === 'local' ? conflict.localValue : conflict.remoteValue

  if (conflict.field === '__object__') {
    if (choice === 'remote') {
      const index = live.findIndex((item) => item.id === conflict.objectId)
      if (index >= 0) live.splice(index, 1)
      const remoteIndex = remote.findIndex((item) => item.id === conflict.objectId)
      if (remoteIndex >= 0) remote.splice(remoteIndex, 1)
    } else if (target && !remoteTarget) {
      remote.push(clone(target))
    }
  } else {
    if (target) (target as unknown as Record<string, unknown>)[conflict.field] = clone(value)
    if (remoteTarget) {
      ;(remoteTarget as unknown as Record<string, unknown>)[conflict.field] = clone(value)
    }
    if (kind === 'setting' && target) (target as ProtectionSetting).updatedAt = now()
  }

  conflict.status = 'resolved'
  conflict.resolution = choice
  conflict.resolvedAt = now()

  appendRevision(state, {
    side: 'dispatch',
    kind: 'resolve',
    objectKeys: [objectKey(kind, conflict.objectId)],
    summary: `裁决冲突：${conflict.objectLabel} ${conflict.field} 采用${choice === 'local' ? '调度端' : '站端'}值`,
  })
  appendAuditOnce(
    state,
    {
      action: '裁决冲突',
      target: conflict.objectLabel,
      operator: '当前用户',
      detail: `字段 ${conflict.field} 采用${choice === 'local' ? '调度端' : '站端'}值，基线值与双端值均留痕。`,
    },
    `resolve:${conflict.id}`,
  )

  const batch = state.syncBatches.find((item) => item.id === conflict.batchId)
  const op = batch?.ops.find(
    (item) => item.kind === kind && item.objectId === conflict.objectId,
  )
  const stillPending = state.conflicts.some(
    (item) =>
      item.batchId === conflict.batchId &&
      item.kind === kind &&
      item.objectId === conflict.objectId &&
      item.status === 'pending',
  )
  if (op && !stillPending) op.status = 'merged'
  if (batch) {
    batch.status = batch.ops.every((item) => item.status === 'merged')
      ? 'merged'
      : batch.ops.some((item) => item.status === 'failed')
        ? 'failed'
        : 'partial'
    finalizeBatchIfMerged(state, batch)
  }

  recomputeIssues(state)
}
