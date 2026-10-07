// 오토 모드: 시각, 서버 응답 속도, 사람이 붙어 있는지를 보고 낮/밤 동작을 스스로 고른다.
// 원칙
//  - 애매하면 보수적으로 (표본이 모자라거나 알 수 없으면 낮 동작)
//  - 무인(사람이 없는) 상태로 시작하려면 승인된 계획서가 반드시 있어야 한다
//  - 느림 <-> 빠름 판단은 완충(히스테리시스)을 둬서 모드가 오락가락하지 않게 한다
//  - 안전 규칙(Git 금지, 허용/금지 명령, 작업 범위)은 어떤 모드로 판단되든 동일하다
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AutoConfig, NightConfig } from "./config"
import { percentile, type RunMetric } from "./metrics"
import type { Layout } from "./paths"
import { writeJsonAtomic } from "./nightstate"
import { inWindow } from "./schedule"

export type SpeedLevel = "fast" | "slow" | "unknown"

export interface SpeedSignal {
  samples: number
  medianFirstTokenMs: number | null
  medianTokensPerSec: number | null
  level: SpeedLevel
  /** 판단 근거 문장 */
  note: string
}

/** 최근 속도 기록에서 속도 수준을 판단한다. previous는 직전 판단(완충에 사용) */
export function judgeSpeed(metrics: RunMetric[], now: Date, cfg: AutoConfig, previous: SpeedLevel | null): SpeedSignal {
  const since = now.getTime() - cfg.lookbackHours * 3600_000
  const recent = metrics.filter((m) => m.llm && new Date(m.at).getTime() >= since && (m.llm.firstTokenMs !== null || m.llm.tokensPerSec !== null))
  const ttfts = recent.map((m) => m.llm!.firstTokenMs).filter((v): v is number => v !== null)
  const tps = recent.map((m) => m.llm!.tokensPerSec).filter((v): v is number => v !== null)
  const ttft = percentile(ttfts, 50)
  const rate = percentile(tps, 50)
  const base = { samples: recent.length, medianFirstTokenMs: ttft, medianTokensPerSec: rate }
  if (recent.length < cfg.minSamples) {
    return { ...base, level: "unknown", note: `최근 ${cfg.lookbackHours}시간의 측정 기록이 ${recent.length}건뿐이라(최소 ${cfg.minSamples}건) 속도를 알 수 없습니다` }
  }
  const slowTtft = cfg.slowFirstTokenSeconds * 1000
  // 이미 '느림'이었다면 기준보다 확실히 나아졌을 때만 '빠름'으로 돌아간다 (완충)
  const recover = previous === "slow" ? cfg.recoverFactor : 1
  const ttftSlow = ttft !== null && ttft > slowTtft * recover
  const rateSlow = rate !== null && rate < cfg.slowTokensPerSec / recover
  const level: SpeedLevel = ttftSlow || rateSlow ? "slow" : "fast"
  const fmt = `첫 토큰 ${ttft === null ? "-" : `${(ttft / 1000).toFixed(1)}초`}, 초당 토큰 ${rate === null ? "-" : rate}`
  const note =
    level === "slow"
      ? `최근 ${recent.length}건 기준 ${fmt} → 느림${previous === "slow" && !(ttft !== null && ttft > slowTtft) && !(rate !== null && rate < cfg.slowTokensPerSec) ? " (직전에 느렸고 아직 충분히 회복되지 않음)" : ""}`
      : `최근 ${recent.length}건 기준 ${fmt} → 빠름`
  return { ...base, level, note }
}

export interface AutoSignals {
  now: Date
  /** 야간 창 안인지 */
  inNightWindow: boolean
  /** 사람이 화면 앞에 있는지 (터미널에서 직접 실행) */
  human: boolean
  speed: SpeedSignal
  approvedPlan: boolean
  /** 승인되지 않은 이유 (승인되지 않았을 때) */
  approvalReason?: string
  /** 사용자가 즉석 지시문을 줬는지 */
  hasInstruction: boolean
}

export type AutoMode = "day" | "night"

export interface AutoDecision {
  /** 실행할 동작. refuse면 시작하지 않는다 */
  action: AutoMode | "refuse"
  /** 낮 동작일 때 가볍게 실행할지 (서버가 느릴 때) */
  light: boolean
  /** 낮 동작의 형태: instruction(지시문 감독 실행) / interactive(원본 화면) */
  dayKind?: "instruction" | "interactive"
  reasons: string[]
}

export interface AutoOverrides {
  mode?: AutoMode
}

export function decideMode(s: AutoSignals, o: AutoOverrides = {}): AutoDecision {
  const reasons: string[] = []
  const slow = s.speed.level === "slow"
  reasons.push(`${s.now.getHours()}시 (야간 창 ${s.inNightWindow ? "안" : "밖"}), ${s.human ? "사람이 직접 실행" : "무인(터미널 아님)"}`)
  reasons.push(s.speed.note)

  const refuse = (why: string): AutoDecision => ({ action: "refuse", light: false, reasons: [...reasons, why] })
  const night = (why: string): AutoDecision => ({ action: "night", light: false, reasons: [...reasons, why] })
  const day = (kind: "instruction" | "interactive", why: string): AutoDecision => ({
    action: "day",
    light: slow,
    dayKind: kind,
    reasons: [...reasons, why, ...(slow ? ["서버가 느려서 가볍게 실행합니다(사고 모드 해제 등 day.lightBody 적용)"] : [])],
  })

  // 사용자가 모드를 직접 지정한 경우: 지정을 따르되 무인 시작의 안전 조건은 그대로 확인한다
  if (o.mode === "night") {
    return s.approvedPlan ? night("--mode night로 지정됨") : refuse(`밤 모드는 승인된 계획서가 필요합니다: ${s.approvalReason ?? "승인 기록이 없습니다"}`)
  }
  if (o.mode === "day") {
    if (s.hasInstruction) return day("instruction", "--mode day로 지정됨")
    return s.human ? day("interactive", "--mode day로 지정됨") : refuse("무인 상태에서는 지시문이나 승인된 계획서 없이 낮 모드를 시작할 수 없습니다")
  }

  // 즉석 지시문
  if (s.hasInstruction) {
    if (s.human) return day("instruction", "사람이 직접 지시문을 주었으므로 낮 동작(감독 실행)으로 진행합니다")
    return refuse("무인 상태에서 승인된 계획서 없이 즉석 지시문을 실행할 수 없습니다. 'ocx plan'으로 계획서를 만들고 승인하세요")
  }

  // 지시문 없음
  if (s.approvedPlan) {
    if (!s.human) return night("무인 상태이고 승인된 계획서가 있어 밤 동작으로 진행합니다 (야간 창 전이면 열릴 때까지 기다립니다)")
    if (s.inNightWindow) return night("야간 창 안이고 승인된 계획서가 있어 밤 동작으로 진행합니다")
    return day("interactive", "낮 시간이므로 원본 화면을 혼잡 대응과 함께 엽니다. 계획서의 작업은 'ocx day --task <번호>'로 실행할 수 있습니다")
  }
  if (s.human) return day("interactive", "승인된 계획서가 없어 원본 화면을 혼잡 대응과 함께 엽니다")
  return refuse(`무인 상태에서는 승인된 계획서가 필요합니다: ${s.approvalReason ?? "승인 기록이 없습니다"}`)
}

// ---------- 판단 기록 (완충용 직전 속도 수준 + 전환 이력) ----------

export interface AutoState {
  version: 1
  lastLevel: SpeedLevel
  lastAction: string
  decidedAt: string
}

export const autoStatePath = (l: Layout) => join(l.batch, "auto-state.json")
export const autoLogPath = (l: Layout) => join(l.batch, "auto-log.jsonl")

export function loadAutoState(layout: Layout): AutoState | null {
  const p = autoStatePath(layout)
  if (!existsSync(p)) return null
  try {
    const s = JSON.parse(readFileSync(p, "utf8")) as AutoState
    return s.version === 1 ? s : null
  } catch {
    return null
  }
}

/** 판단을 기록하고, 이전과 달라졌으면 전환 사유를 돌려준다 */
export function recordDecision(layout: Layout, d: AutoDecision, speed: SpeedLevel, now: Date): string | null {
  const prev = loadAutoState(layout)
  const label = d.action === "day" ? `day(${d.dayKind}${d.light ? ",light" : ""})` : d.action
  const changed = prev && prev.lastAction !== label ? `${prev.lastAction} → ${label}` : null
  mkdirSync(layout.batch, { recursive: true })
  writeJsonAtomic(autoStatePath(layout), { version: 1, lastLevel: speed, lastAction: label, decidedAt: now.toISOString() } satisfies AutoState)
  appendFileSync(autoLogPath(layout), JSON.stringify({ at: now.toISOString(), action: label, speed, switchedFrom: prev?.lastAction ?? null, reasons: d.reasons }) + "\n")
  return changed
}

export function windowOf(now: Date, night: NightConfig) {
  return inWindow(now, night.windowStart, night.endTime)
}
