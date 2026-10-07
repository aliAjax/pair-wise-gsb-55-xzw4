import type { AppState } from '@/types/domain'
import { createInitialState } from '@/data/mock'

const STORAGE_KEY = 'grid-protection-review-v1'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/**
 * 兼容旧版本持久化数据：
 * 缺少修订链的数据标记为“历史待核”，补齐前不允许锁定新基线；
 * 合并基线以最近锁定基线快照为准，缺失时退回当前工作状态。
 */
function migrateState(state: AppState): AppState {
  const next = state
  if (!Array.isArray(next.revisionChain) || !next.mergeBase) {
    const lockedBaseline =
      next.baselines.find((baseline) => baseline.id === next.activeBaselineId) ??
      [...next.baselines].reverse().find((baseline) => baseline.status === 'locked')
    next.revisionChain = []
    next.mergeBatches = []
    next.conflicts = []
    next.currentSide = 'dispatch'
    next.legacyPending = true
    next.mergeBase = {
      baselineId: lockedBaseline?.id ?? null,
      devices: clone(next.devices),
      settings: lockedBaseline ? clone(lockedBaseline.snapshot) : clone(next.settings),
      scenarios: clone(next.scenarios),
    }
  }
  next.mergeBatches = next.mergeBatches ?? []
  next.conflicts = next.conflicts ?? []
  next.currentSide = next.currentSide ?? 'dispatch'
  next.legacyPending = next.legacyPending ?? false
  next.issues.forEach((issue) => {
    if (!issue.dependsOn) {
      issue.dependsOn = [...new Set([...issue.settingIds, ...issue.deviceIds])]
    }
  })
  return next
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
