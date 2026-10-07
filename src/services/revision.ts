import type {
  AppState,
  AuditEntry,
  ChainObjectKind,
  ReviewComment,
  RevisionRecord,
  SyncSide,
} from '@/types/domain'

export const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

export const now = () => new Date().toISOString()

/** 对象键：修订链、冲突、历史待核共用同一寻址方式 */
export const objectKey = (kind: ChainObjectKind, id: string) => `${kind}:${id}`

export const kindLabels: Record<ChainObjectKind, string> = {
  device: '设备',
  setting: '保护定值',
  issue: '校核结果',
  scenario: '故障场景',
  baseline: '基线会签',
  comment: '会签意见',
}

/**
 * 在共用修订链上追加一条记录，并把涉及对象指向新修订号。
 * 设备、定值、校核结果、故障场景、基线会签都走这一条链。
 */
export function appendRevision(
  state: AppState,
  input: {
    side: SyncSide
    kind: RevisionRecord['kind']
    objectKeys: string[]
    summary: string
  },
): RevisionRecord {
  const record: RevisionRecord = {
    id: createId('rev'),
    parentId: state.heads[input.side],
    side: input.side,
    kind: input.kind,
    objectKeys: [...input.objectKeys],
    summary: input.summary,
    createdAt: now(),
  }
  state.revisionLog.push(record)
  state.heads[input.side] = record.id
  input.objectKeys.forEach((key) => {
    state.objectRevisions[key] = record.id
  })
  return record
}

/** 本端（调度端）对象变更统一入口：登记修订链 */
export function touchObjects(
  state: AppState,
  kind: ChainObjectKind,
  ids: string[],
  summary: string,
  side: SyncSide = 'dispatch',
) {
  appendRevision(state, {
    side,
    kind: 'edit',
    objectKeys: ids.map((id) => objectKey(kind, id)),
    summary,
  })
}

/**
 * 追加审计记录。携带幂等键时，若同一键已存在则跳过，
 * 保证同步批次重试不会重复新增审计。
 */
export function appendAuditOnce(
  state: AppState,
  entry: Omit<AuditEntry, 'id' | 'createdAt'>,
  idempotencyKey?: string,
) {
  if (idempotencyKey && state.audit.some((item) => item.idempotencyKey === idempotencyKey)) {
    return
  }
  state.audit.unshift({
    ...entry,
    id: createId('audit'),
    createdAt: now(),
    idempotencyKey,
  })
}

/**
 * 追加会签意见。携带幂等键时按键去重，同时按记录 id 去重，
 * 保证两侧同步与批次重试不会重复新增会签记录。
 */
export function appendCommentOnce(
  state: AppState,
  comment: Omit<ReviewComment, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  idempotencyKey?: string,
) {
  const key = idempotencyKey ?? comment.idempotencyKey
  if (comment.id && state.comments.some((item) => item.id === comment.id)) return
  if (key && state.comments.some((item) => item.idempotencyKey === key)) return
  state.comments.unshift({
    ...comment,
    id: comment.id ?? createId('comment'),
    createdAt: comment.createdAt ?? now(),
    idempotencyKey: key,
  })
}
