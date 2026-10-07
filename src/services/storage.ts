import type { AppState } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { issueFingerprint } from '@/services/validation'
import { now, objectKey } from '@/services/revision'

const STORAGE_KEY = 'grid-protection-review-v1'

/**
 * 旧数据迁移：缺少修订链的状态整体标记为历史待核，
 * 补齐修订链之前不允许锁定新基线。
 */
export function migrateState(state: AppState): AppState {
  state.revisionLog ??= []
  state.objectRevisions ??= {}
  state.heads ??= { dispatch: null, station: null }
  state.conflicts ??= []
  state.syncBatches ??= []
  state.remote ??= null
  state.legacyKeys ??= []

  // 旧版本问题记录缺少指纹，按当前输入补齐
  state.issues = (state.issues ?? []).map((issue) =>
    issue.fingerprint
      ? issue
      : { ...issue, fingerprint: issueFingerprint(issue, state.settings, state.devices) },
  )

  if (!state.revisionLog.length) {
    const keys = [
      ...state.devices.map((item) => objectKey('device', item.id)),
      ...state.settings.map((item) => objectKey('setting', item.id)),
      ...state.issues.map((item) => objectKey('issue', item.id)),
      ...state.scenarios.map((item) => objectKey('scenario', item.id)),
      ...state.baselines.map((item) => objectKey('baseline', item.id)),
    ]
    state.revisionLog.push({
      id: 'rev-migrate-0',
      parentId: null,
      side: 'dispatch',
      kind: 'migrate',
      objectKeys: keys,
      summary: '历史数据迁移：原数据缺少修订链，全部标记为历史待核',
      createdAt: now(),
    })
    keys.forEach((key) => {
      state.objectRevisions[key] = 'rev-migrate-0'
    })
    state.heads.dispatch = 'rev-migrate-0'
    state.legacyKeys = keys
  }
  return state
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
  try {
    return migrateState(JSON.parse(raw) as AppState)
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

export function exportSettingsText(state: AppState): string {
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件',
  ]
  state.settings.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    lines.push(
      [
        setting.relayId,
        relay,
        target,
        setting.stage,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
      ].join(','),
    )
  })
  return lines.join('\n')
}
