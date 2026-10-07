export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

/** 同步两侧：调度端 / 站端 */
export type SyncSide = 'dispatch' | 'station'

/** 共用修订链覆盖的对象类别 */
export type ChainObjectKind = 'device' | 'setting' | 'issue' | 'scenario' | 'baseline' | 'comment'

/** 参与三向合并的对象类别 */
export type MergeableKind = 'device' | 'setting' | 'scenario'

export interface Device {
  id: string
  code: string
  name: string
  kind: DeviceKind
  station: string
  voltage: number
  parentId?: string
  status: DeviceStatus
  operationModes: string[]
}

export interface ProtectionSetting {
  id: string
  relayId: string
  protectedDeviceId: string
  stage: 'I' | 'II' | 'III'
  currentA: number
  timeS: number
  direction: 'forward' | 'reverse' | 'non-directional'
  sensitivity: number
  recloseEnabled: boolean
  recloseDelayS: number
  startCondition: string
  updatedAt: string
}

export interface ValidationIssue {
  id: string
  type: IssueType
  level: IssueLevel
  deviceIds: string[]
  settingIds: string[]
  message: string
  suggestion: string
  pairLabel: string
  status: 'open' | 'replying' | 'closed'
  createdAt: string
  /** 依赖输入（相关定值字段 + 设备状态）的指纹，输入变化即失效重算 */
  fingerprint: string
  /** 依赖变化后不再复现，保留待复核，不参与锁定条件 */
  stale?: boolean
  /** 最近一次失效重算时间 */
  recomputedAt?: string
}

export interface ScenarioStep {
  sequence: number
  relayId: string
  action: string
  delayMs: number
  status: 'executed' | 'pending' | 'skipped'
}

export interface FaultScenario {
  id: string
  name: string
  operationMode: string
  faultDeviceId: string
  faultType: string
  status: ReviewStatus
  steps: ScenarioStep[]
  outageDevices: string[]
  createdAt: string
  notes: string
  /** 批准时的校核指纹（动作序列 + 停电范围 + 涉及定值），变化后批准失效 */
  reviewFingerprint?: string
}

export interface BaselineVersion {
  id: string
  version: string
  status: ReviewStatus
  createdAt: string
  lockedAt?: string
  createdBy: string
  note: string
  snapshot: ProtectionSetting[]
  /** 锁定时的设备快照，作为设备三向合并的基线 */
  deviceSnapshot?: Device[]
  /** 锁定时的场景快照，作为场景三向合并的基线 */
  scenarioSnapshot?: FaultScenario[]
  /** 锁定时修订链头，作为合并基线点 */
  revisionId?: string
  checksum: string
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
  /** 幂等键：同步重试时防止会签记录重复新增 */
  idempotencyKey?: string
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
  /** 幂等键：同步重试时防止审计记录重复新增 */
  idempotencyKey?: string
}

/** 修订链记录：设备、定值、校核结果、故障场景、基线会签共用一条链 */
export interface RevisionRecord {
  id: string
  parentId: string | null
  side: SyncSide
  kind: 'edit' | 'merge' | 'resolve' | 'migrate' | 'baseline'
  objectKeys: string[]
  summary: string
  createdAt: string
}

/** 字段级冲突：同一字段相对上次锁定基线两边都改过，保留两份待选择 */
export interface FieldConflict {
  id: string
  batchId: string
  kind: ChainObjectKind
  objectId: string
  objectLabel: string
  field: string
  baseValue: unknown
  localValue: unknown
  remoteValue: unknown
  status: 'pending' | 'resolved'
  resolution?: 'local' | 'remote'
  resolvedAt?: string
}

export type SyncOpStatus = 'pending' | 'merged' | 'conflict' | 'failed'

export interface SyncOp {
  id: string
  kind: ChainObjectKind
  objectId: string
  label: string
  status: SyncOpStatus
  error?: string
}

/** 同步批次：保存失败后保留未完成部分，重试只补尚未合并对象 */
export interface SyncBatch {
  id: string
  side: SyncSide
  createdAt: string
  attempt: number
  status: 'open' | 'partial' | 'merged' | 'failed'
  ops: SyncOp[]
}

/** 站端离线维护的副本 */
export interface RemoteWorkspace {
  devices: Device[]
  settings: ProtectionSetting[]
  scenarios: FaultScenario[]
  issues: ValidationIssue[]
  comments: ReviewComment[]
  updatedAt: string
}

export interface AppState {
  devices: Device[]
  settings: ProtectionSetting[]
  issues: ValidationIssue[]
  scenarios: FaultScenario[]
  baselines: BaselineVersion[]
  comments: ReviewComment[]
  audit: AuditEntry[]
  activeBaselineId?: string
  /** 共用修订链（全部对象类别共享） */
  revisionLog: RevisionRecord[]
  /** 对象键（kind:id）→ 最近修订号 */
  objectRevisions: Record<string, string>
  /** 两侧各自的链头 */
  heads: Record<SyncSide, string | null>
  conflicts: FieldConflict[]
  syncBatches: SyncBatch[]
  remote: RemoteWorkspace | null
  /** 历史待核对象键：旧数据缺少修订链，补齐前不能锁定新基线 */
  legacyKeys: string[]
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}
