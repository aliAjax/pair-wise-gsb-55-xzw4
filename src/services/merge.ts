import type {
  AppState,
  Device,
  FaultScenario,
  FieldValue,
  MergeBatch,
  MergeBatchEntry,
  MergeObjectKind,
  MergeSide,
  ProtectionSetting,
  RevisionOutcome,
} from '@/types/domain'

export const sideLabels: Record<MergeSide, string> = {
  dispatch: '调度端',
  station: '站端',
}

export const outcomeLabels: Record<RevisionOutcome, string> = {
  pending: '待合并',
  local: '本端修订',
  auto: '自动合并',
  convergent: '双方一致',
  conflict: '冲突待裁决',
  resolved: '裁决落值',
  genesis: '历史补齐',
  skipped: '对象缺失',
}

export const objectKindLabels: Record<MergeObjectKind, string> = {
  device: '设备',
  setting: '保护定值',
  scenario: '故障场景',
  issue: '校核结果',
  baseline: '基线会签',
}

/** 参与三方合并与修订链跟踪的标量字段（数组类字段不进入字段级裁决） */
export const trackedFields: Record<'device' | 'setting' | 'scenario', string[]> = {
  device: ['code', 'name', 'kind', 'station', 'voltage', 'parentId', 'status'],
  setting: [
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
  scenario: ['name', 'operationMode', 'faultDeviceId', 'faultType', 'status', 'notes'],
}

const fieldLabelMaps: Record<'device' | 'setting' | 'scenario', Record<string, string>> = {
  device: {
    code: '设备编号',
    name: '设备名称',
    kind: '设备类型',
    station: '所属站所',
    voltage: '电压等级',
    parentId: '上级设备',
    status: '运行状态',
  },
  setting: {
    protectedDeviceId: '保护对象',
    stage: '段位',
    currentA: '电流定值',
    timeS: '动作时限',
    direction: '方向',
    sensitivity: '灵敏度',
    recloseEnabled: '重合闸投入',
    recloseDelayS: '重合延迟',
    startCondition: '启动条件',
  },
  scenario: {
    name: '场景名称',
    operationMode: '运行方式',
    faultDeviceId: '故障设备',
    faultType: '故障类型',
    status: '场景状态',
    notes: '审校备注',
  },
}

const specialFieldLabels: Record<string, string> = {
  __created__: '新建对象',
  __genesis__: '历史补齐',
  locked: '锁定基线',
  issues: '校核结果集',
  recompute: '失效重算',
}

export function fieldLabel(kind: MergeObjectKind, field: string): string {
  const stepMatch = /^step(\d+)\.status$/.exec(field)
  if (stepMatch) return `动作 ${stepMatch[1]} 执行状态`
  if (specialFieldLabels[field]) return specialFieldLabels[field]
  if (kind === 'device' || kind === 'setting' || kind === 'scenario') {
    return fieldLabelMaps[kind][field] ?? field
  }
  return specialFieldLabels[field] ?? field
}

const deviceStatusLabels: Record<string, string> = {
  running: '运行',
  maintenance: '检修',
  stopped: '停用',
}

const reviewStatusLabels: Record<string, string> = {
  draft: '草稿',
  reviewing: '会签中',
  approved: '已批准',
  locked: '已锁定',
  returned: '已退回',
}

const issueStatusLabels: Record<string, string> = {
  open: '待处理',
  replying: '回复中',
  closed: '已关闭',
}

const stepStatusLabels: Record<string, string> = {
  executed: '已执行',
  pending: '待确认',
  skipped: '跳过',
}

const directionLabels: Record<string, string> = {
  forward: '正向',
  reverse: '反向',
  'non-directional': '无方向',
}

export function formatFieldValue(kind: MergeObjectKind, field: string, value: FieldValue): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? '投入' : '退出'
  const text = String(value)
  if (field === 'direction') return directionLabels[text] ?? text
  if (/^step\d+\.status$/.test(field)) return stepStatusLabels[text] ?? text
  if (field === 'status') {
    if (kind === 'device') return deviceStatusLabels[text] ?? text
    if (kind === 'issue') return issueStatusLabels[text] ?? text
    return reviewStatusLabels[text] ?? text
  }
  return text
}

export function valuesEqual(a: FieldValue | undefined, b: FieldValue | undefined): boolean {
  return (a ?? null) === (b ?? null)
}

type MergeableCollection = Device[] | ProtectionSetting[] | FaultScenario[]

export function collectionOf(state: AppState, kind: MergeObjectKind): MergeableCollection | undefined {
  if (kind === 'device') return state.devices
  if (kind === 'setting') return state.settings
  if (kind === 'scenario') return state.scenarios
  return undefined
}

export function baseCollectionOf(state: AppState, kind: MergeObjectKind): MergeableCollection | undefined {
  if (kind === 'device') return state.mergeBase.devices
  if (kind === 'setting') return state.mergeBase.settings
  if (kind === 'scenario') return state.mergeBase.scenarios
  return undefined
}

export function readField(target: object, field: string): FieldValue {
  const value = (target as Record<string, FieldValue | undefined>)[field]
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return null
}

export function writeField(target: object, field: string, value: FieldValue): void {
  ;(target as Record<string, FieldValue>)[field] = value
}

export interface TrackedChange {
  objectKind: MergeObjectKind
  objectId: string
  field: string
  baseValue: FieldValue
  value: FieldValue
}

/** 计算当前工作状态相对合并基线（上次锁定基线）的全部字段级改动 */
export function localChanges(state: AppState): TrackedChange[] {
  const changes: TrackedChange[] = []
  const kinds: Array<'device' | 'setting' | 'scenario'> = ['device', 'setting', 'scenario']
  kinds.forEach((kind) => {
    const current = collectionOf(state, kind) ?? []
    const base = baseCollectionOf(state, kind) ?? []
    current.forEach((item) => {
      const baseItem = (base as Array<{ id: string }>).find((candidate) => candidate.id === item.id)
      if (!baseItem) return
      trackedFields[kind].forEach((field) => {
        const before = readField(baseItem, field)
        const after = readField(item, field)
        if (!valuesEqual(before, after)) {
          changes.push({ objectKind: kind, objectId: item.id, field, baseValue: before, value: after })
        }
      })
    })
  })
  return changes
}

export function objectLabel(state: AppState, kind: MergeObjectKind, objectId: string): string {
  if (kind === 'device') {
    return state.devices.find((device) => device.id === objectId)?.name ?? objectId
  }
  if (kind === 'setting') {
    const setting = state.settings.find((item) => item.id === objectId)
    if (!setting) return objectId
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    return `${relay} ${setting.stage} 段`
  }
  if (kind === 'scenario') {
    return state.scenarios.find((scenario) => scenario.id === objectId)?.name ?? objectId
  }
  if (kind === 'issue') {
    return state.issues.find((issue) => issue.id === objectId)?.pairLabel ?? objectId
  }
  return state.baselines.find((baseline) => baseline.id === objectId)?.version ?? objectId
}

/** 为对端生成一个与基线值和本端值都不同的修订值 */
function alternativeValue(field: string, baseValue: FieldValue, avoid: FieldValue): FieldValue {
  if (typeof baseValue === 'number') {
    const delta = field === 'timeS' ? 0.15 : field === 'sensitivity' ? -0.07 : field === 'recloseDelayS' ? 0.3 : 0.4
    const first = Number((baseValue + delta).toFixed(2))
    if (first !== avoid) return first
    return Number((baseValue + delta * 2).toFixed(2))
  }
  if (typeof baseValue === 'boolean') return !baseValue
  if (typeof baseValue === 'string') {
    if (field === 'status') {
      const candidates = ['running', 'maintenance', 'stopped']
      return candidates.find((item) => item !== baseValue && item !== avoid) ?? baseValue
    }
    if (field === 'faultType') {
      const candidates = ['单相接地', '相间短路', '母线短路', '设备拒动']
      return candidates.find((item) => item !== baseValue && item !== avoid) ?? baseValue
    }
    const appended = `${baseValue}（对端修订）`
    return appended === avoid ? `${baseValue}（对端复核）` : appended
  }
  return null
}

/**
 * 生成对端离线批次：以合并基线（上次锁定基线）为基准，
 * 覆盖三类典型条目——双边同字段改动（冲突）、双边一致改动（自动收敛）、单边改动（自动合并）。
 */
export function buildPeerBatch(
  state: AppState,
  peerSide: MergeSide,
  createId: (prefix: string) => string,
): MergeBatch {
  const batchId = createId('batch')
  const createdAt = new Date().toISOString()
  const entries: MergeBatchEntry[] = []
  let sequence = 0
  const push = (
    objectKind: MergeObjectKind,
    objectId: string,
    field: string,
    baseValue: FieldValue,
    value: FieldValue,
  ) => {
    sequence += 1
    entries.push({
      id: `${batchId}-e${sequence}`,
      batchId,
      side: peerSide,
      objectKind,
      objectId,
      field,
      baseValue,
      value,
      outcome: 'pending',
      merged: false,
      createdAt,
    })
  }

  const locals = localChanges(state)

  // 1. 双边改动同一字段且取值不同 → 合并时形成冲突，两份值都保留待选择
  locals.slice(0, 2).forEach((change) => {
    const peerValue = alternativeValue(change.field, change.baseValue, change.value)
    if (!valuesEqual(peerValue, change.value)) {
      push(change.objectKind, change.objectId, change.field, change.baseValue, peerValue)
    }
  })

  // 2. 双边对同一字段做出相同改动 → 合并时自动收敛，不产生冲突
  const convergentSource = locals[2] ?? locals[0]
  if (convergentSource) {
    push(
      convergentSource.objectKind,
      convergentSource.objectId,
      convergentSource.field,
      convergentSource.baseValue,
      convergentSource.value,
    )
  }

  // 3. 本端未触碰的对象 → 对端单边改动，合并时自动落值
  const untouchedSettings = state.settings.filter(
    (setting) => !locals.some((item) => item.objectKind === 'setting' && item.objectId === setting.id),
  )
  untouchedSettings.slice(0, 2).forEach((setting, index) => {
    const baseSetting = state.mergeBase.settings.find((item) => item.id === setting.id)
    const field = index % 2 === 0 ? 'currentA' : 'timeS'
    const baseValue = baseSetting ? readField(baseSetting, field) : readField(setting, field)
    push('setting', setting.id, field, baseValue, alternativeValue(field, baseValue, null))
  })

  const untouchedDevice = state.devices.find(
    (device) =>
      device.kind !== 'relay' &&
      !locals.some((item) => item.objectKind === 'device' && item.objectId === device.id),
  )
  if (untouchedDevice && entries.length < 5) {
    const baseDevice = state.mergeBase.devices.find((item) => item.id === untouchedDevice.id)
    const baseStatus = baseDevice?.status ?? untouchedDevice.status
    push(
      'device',
      untouchedDevice.id,
      'status',
      baseStatus,
      alternativeValue('status', baseStatus, untouchedDevice.status),
    )
  }

  if (!entries.length) {
    const fallback = state.settings[0]
    if (fallback) {
      const baseSetting = state.mergeBase.settings.find((item) => item.id === fallback.id)
      const baseValue = baseSetting?.currentA ?? fallback.currentA
      push('setting', fallback.id, 'currentA', baseValue, alternativeValue('currentA', baseValue, null))
    }
  }

  return {
    id: batchId,
    title: `${sideLabels[peerSide]}离线批次 ${new Date().toLocaleString('zh-CN')}`,
    side: peerSide,
    status: 'pending',
    entries,
    attempts: 0,
    createdAt,
  }
}
