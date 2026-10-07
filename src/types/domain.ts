export type DeviceKind = 'line' | 'transformer' | 'bus' | 'breaker' | 'relay'
export type DeviceStatus = 'running' | 'maintenance' | 'stopped'
export type IssueType = 'overreach' | 'time-inversion' | 'sensitivity' | 'reclose'
export type IssueLevel = 'high' | 'medium' | 'low'
export type ReviewStatus = 'draft' | 'reviewing' | 'approved' | 'locked' | 'returned'

export type MergeSide = 'dispatch' | 'station'
export type MergeObjectKind = 'device' | 'setting' | 'scenario' | 'issue' | 'baseline'
export type FieldValue = string | number | boolean | null
export type RevisionOutcome =
  | 'pending'
  | 'local'
  | 'auto'
  | 'convergent'
  | 'conflict'
  | 'resolved'
  | 'genesis'
  | 'skipped'

export interface RevisionRecord {
  id: string
  batchId: string | null
  side: MergeSide
  objectKind: MergeObjectKind
  objectId: string
  field: string
  baseValue: FieldValue
  value: FieldValue
  outcome: RevisionOutcome
  createdAt: string
}

export interface MergeBatchEntry extends RevisionRecord {
  merged: boolean
}

export interface MergeBatch {
  id: string
  title: string
  side: MergeSide
  status: 'pending' | 'merged' | 'failed'
  entries: MergeBatchEntry[]
  attempts: number
  createdAt: string
  mergedAt?: string
  error?: string
}

export interface MergeConflict {
  id: string
  entryId: string
  objectKind: MergeObjectKind
  objectId: string
  field: string
  baseValue: FieldValue
  localValue: FieldValue
  peerValue: FieldValue
  localSide: MergeSide
  peerSide: MergeSide
  status: 'pending' | 'resolved'
  resolvedValue?: FieldValue
  resolvedSide?: MergeSide
  resolvedAt?: string
}

export interface MergeBase {
  baselineId: string | null
  devices: Device[]
  settings: ProtectionSetting[]
  scenarios: FaultScenario[]
}

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
  dependsOn?: string[]
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
  deviceSnapshot?: Device[]
  scenarioSnapshot?: FaultScenario[]
  checksum: string
}

export interface ReviewComment {
  id: string
  targetType: 'issue' | 'baseline' | 'scenario' | 'merge'
  targetId: string
  author: string
  content: string
  createdAt: string
  status: 'open' | 'resolved'
  dedupeKey?: string
}

export interface AuditEntry {
  id: string
  action: string
  target: string
  operator: string
  detail: string
  createdAt: string
  dedupeKey?: string
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
  revisionChain: RevisionRecord[]
  mergeBatches: MergeBatch[]
  conflicts: MergeConflict[]
  mergeBase: MergeBase
  currentSide: MergeSide
  legacyPending: boolean
}

export interface SettingDiff {
  settingId: string
  relayName: string
  field: keyof ProtectionSetting
  before: string | number | boolean
  after: string | number | boolean
}
