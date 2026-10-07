import type {
  AppState,
  Device,
  FaultScenario,
  ProtectionSetting,
  SettingDiff,
  ValidationIssue,
} from '@/types/domain'
import { appendAuditOnce, now } from '@/services/revision'

const issueMeta: Record<ValidationIssue['type'], Pick<ValidationIssue, 'level' | 'suggestion'>> = {
  overreach: {
    level: 'high',
    suggestion: '延长上级保护动作时限，或核对下级保护的配合级差与方向元件。',
  },
  'time-inversion': {
    level: 'high',
    suggestion: '调整同装置各段时限，确保近区段动作快于远区段。',
  },
  sensitivity: {
    level: 'medium',
    suggestion: '复核最小运行方式下的短路电流，并下调定值或提高灵敏度裕度。',
  },
  reclose: {
    level: 'medium',
    suggestion: '协调相邻装置重合闸延迟，避免非同期并列或重复冲击。',
  },
}

const deviceName = (devices: Device[], id: string) =>
  devices.find((device) => device.id === id)?.name ?? id

export function hashText(source: string): string {
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0')
}

/**
 * 校核结果指纹：只取与该问题类型真正相关的输入字段。
 * 设备、定值或场景动作一旦变化，对应指纹即改变，校核结果失效重算。
 */
export function issueFingerprint(
  issue: Pick<ValidationIssue, 'type' | 'settingIds' | 'deviceIds'>,
  settings: ProtectionSetting[],
  devices: Device[],
): string {
  const related = issue.settingIds
    .map((id) => settings.find((setting) => setting.id === id))
    .filter((item): item is ProtectionSetting => Boolean(item))
  const parts: unknown[] = [issue.type]
  if (issue.type === 'time-inversion' || issue.type === 'overreach') {
    parts.push(related.map((item) => [item.id, item.timeS, item.direction]))
  }
  if (issue.type === 'overreach') {
    parts.push(
      issue.deviceIds.map((id) => {
        const device = devices.find((item) => item.id === id)
        return [id, device?.parentId ?? null, device?.status ?? null]
      }),
    )
  }
  if (issue.type === 'sensitivity') {
    parts.push(related.map((item) => [item.id, item.sensitivity, item.currentA]))
  }
  if (issue.type === 'reclose') {
    parts.push(related.map((item) => [item.id, item.recloseEnabled, item.recloseDelayS]))
  }
  return hashText(JSON.stringify(parts))
}

/** 场景校核指纹：动作序列、停电范围与涉及装置的定值共同决定批准结论 */
export function scenarioFingerprint(
  scenario: FaultScenario,
  settings: ProtectionSetting[],
): string {
  const relayIds = [...new Set(scenario.steps.map((step) => step.relayId))]
  const related = settings
    .filter((setting) => relayIds.includes(setting.relayId))
    .map((setting) => [
      setting.id,
      setting.stage,
      setting.currentA,
      setting.timeS,
      setting.recloseEnabled,
      setting.recloseDelayS,
    ])
  return hashText(
    JSON.stringify([
      scenario.operationMode,
      scenario.faultDeviceId,
      scenario.faultType,
      scenario.steps,
      scenario.outageDevices,
      related,
    ]),
  )
}

export function validateSettings(
  settings: ProtectionSetting[],
  devices: Device[],
): ValidationIssue[] {
  const issues: Array<Omit<ValidationIssue, 'fingerprint'>> = []
  const createdAt = new Date().toISOString()
  const addIssue = (
    type: ValidationIssue['type'],
    pair: ProtectionSetting[],
    message: string,
    pairLabel: string,
  ) => {
    const meta = issueMeta[type]
    issues.push({
      id: `${type}-${pair.map((item) => item.id).join('-')}`,
      type,
      level: meta.level,
      deviceIds: [...new Set(pair.map((item) => item.protectedDeviceId))],
      settingIds: pair.map((item) => item.id),
      message,
      suggestion: meta.suggestion,
      pairLabel,
      status: 'open',
      createdAt,
    })
  }

  settings.forEach((setting) => {
    const stageOrder = { I: 1, II: 2, III: 3 }
    const slowerStage = settings.find(
      (candidate) =>
        candidate.relayId === setting.relayId &&
        stageOrder[candidate.stage] > stageOrder[setting.stage] &&
        candidate.timeS < setting.timeS,
    )
    if (slowerStage) {
      addIssue(
        'time-inversion',
        [setting, slowerStage],
        `${deviceName(devices, setting.relayId)} 的 ${setting.stage} 段时限 ${setting.timeS}s 长于 ${slowerStage.stage} 段 ${slowerStage.timeS}s。`,
        `${setting.stage} 段 / ${slowerStage.stage} 段`,
      )
    }
  })

  settings.forEach((upstream) => {
    const protectedDevice = devices.find((device) => device.id === upstream.protectedDeviceId)
    if (!protectedDevice) return
    const downstreamSettings = settings.filter((candidate) => {
      const candidateDevice = devices.find((device) => device.id === candidate.protectedDeviceId)
      return candidateDevice?.parentId === upstream.protectedDeviceId
    })
    downstreamSettings.forEach((downstream) => {
      if (downstream.timeS <= upstream.timeS && upstream.timeS - downstream.timeS < 0.3) {
        addIssue(
          'overreach',
          [upstream, downstream],
          `${deviceName(devices, upstream.relayId)} 与 ${deviceName(devices, downstream.relayId)} 配合级差仅 ${(upstream.timeS - downstream.timeS).toFixed(2)}s。`,
          `${deviceName(devices, upstream.protectedDeviceId)} / ${deviceName(devices, downstream.protectedDeviceId)}`,
        )
      }
    })
  })

  settings
    .filter((setting) => setting.sensitivity < 1.2)
    .forEach((setting) => {
      addIssue(
        'sensitivity',
        [setting],
        `${deviceName(devices, setting.relayId)} ${setting.stage} 段灵敏度仅 ${setting.sensitivity.toFixed(2)}。`,
        `${deviceName(devices, setting.protectedDeviceId)} 单端校核`,
      )
    })

  const activeReclosers = settings.filter((setting) => setting.recloseEnabled)
  activeReclosers.forEach((setting, index) => {
    activeReclosers.slice(index + 1).forEach((candidate) => {
      if (
        setting.protectedDeviceId !== candidate.protectedDeviceId &&
        Math.abs(setting.recloseDelayS - candidate.recloseDelayS) < 0.5
      ) {
        addIssue(
          'reclose',
          [setting, candidate],
          `${deviceName(devices, setting.relayId)} 与 ${deviceName(devices, candidate.relayId)} 的重合闸延迟差不足 0.5s。`,
          `${deviceName(devices, setting.protectedDeviceId)} / ${deviceName(devices, candidate.protectedDeviceId)}`,
        )
      }
    })
  })

  const unique = new Map<string, Omit<ValidationIssue, 'fingerprint'>>()
  issues.forEach((issue) => unique.set(issue.id, issue))
  return [...unique.values()].map((issue) => ({
    ...issue,
    fingerprint: issueFingerprint(issue, settings, devices),
  }))
}

/**
 * 校核结果失效重算：
 * - 依赖输入未变的问题保留处理状态（曾失效的自动复活）；
 * - 依赖输入已变的问题结论失效，重算后回到待处理；
 * - 不再复现的问题标记“已失效”留痕，不参与基线锁定条件；
 * - 已批准场景的动作序列或涉及定值变化后，批准结论失效退回会签。
 * 已锁定基线的快照不参与重算，始终保持原样。
 */
export function recomputeIssues(state: AppState): void {
  const previous = state.issues
  const fresh = validateSettings(state.settings, state.devices)
  const recomputedAt = now()
  let invalidated = 0

  const carried = fresh.map((issue) => {
    const old = previous.find((item) => item.id === issue.id)
    if (old && old.fingerprint === issue.fingerprint) {
      return { ...issue, status: old.status, createdAt: old.createdAt }
    }
    if (old) {
      invalidated += 1
      return { ...issue, status: 'open' as const, createdAt: old.createdAt, recomputedAt }
    }
    return issue
  })

  const stale = previous
    .filter((item) => !fresh.some((issue) => issue.id === item.id))
    .map((item) => {
      if (item.stale) return item
      invalidated += 1
      return { ...item, stale: true as const, recomputedAt }
    })

  state.issues = [...carried, ...stale]

  const demoted: string[] = []
  state.scenarios.forEach((scenario) => {
    const fingerprint = scenarioFingerprint(scenario, state.settings)
    if (
      scenario.status === 'approved' &&
      scenario.reviewFingerprint &&
      scenario.reviewFingerprint !== fingerprint
    ) {
      scenario.status = 'reviewing'
      demoted.push(scenario.name)
    }
  })

  if (invalidated > 0) {
    appendAuditOnce(state, {
      action: '校核失效重算',
      target: '保护配合校核结果',
      operator: '系统',
      detail: `设备、定值或场景动作变化，${invalidated} 条校核结果失效并重算。`,
    })
  }
  if (demoted.length > 0) {
    appendAuditOnce(state, {
      action: '场景校核失效',
      target: demoted.join('、'),
      operator: '系统',
      detail: '场景动作或涉及定值已变化，批准结论失效，退回会签。',
    })
  }
}

export function diffSettings(
  current: ProtectionSetting[],
  baseline: ProtectionSetting[],
): SettingDiff[] {
  const fields: (keyof ProtectionSetting)[] = [
    'currentA',
    'timeS',
    'direction',
    'sensitivity',
    'recloseEnabled',
    'recloseDelayS',
    'startCondition',
  ]
  const diffs: SettingDiff[] = []
  current.forEach((setting) => {
    const previous = baseline.find((item) => item.id === setting.id)
    if (!previous) {
      diffs.push({
        settingId: setting.id,
        relayName: setting.relayId,
        field: 'id',
        before: '不存在',
        after: setting.id,
      })
      return
    }
    fields.forEach((field) => {
      if (previous[field] !== setting[field]) {
        diffs.push({
          settingId: setting.id,
          relayName: setting.relayId,
          field,
          before: previous[field] as string | number | boolean,
          after: setting[field] as string | number | boolean,
        })
      }
    })
  })
  return diffs
}
