// 속도 측정 기록 (JSON Lines) 과 요약
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Layout } from "./paths"
import type { LlmRecord } from "./proxy"
import type { RunResult } from "./runner"

/** 프록시가 관측한 LLM 호출 요약 */
export interface LlmSummary {
  requests: number
  /** 본 모델 호출의 첫 토큰 시간(중앙값) */
  firstTokenMs: number | null
  /** 본 모델의 초당 출력 토큰 (출력 토큰 합 / 생성 구간 시간 합) */
  tokensPerSec: number | null
  promptTokens: number
  completionTokens: number
  /** 상태 코드 400 이상이거나 연결 오류가 난 호출 수 */
  errors: number
  clientAborted: number
}

export interface RunMetric {
  /** 실행 시작 시각 (ISO) */
  at: string
  /** 시작 시각의 로컬 시(0~23) — 시간대별 요약용 */
  hour: number
  model: string
  mode: string
  label?: string
  durationMs: number
  firstEventMs: number | null
  firstTextMs: number | null
  endedBy: string
  exitCode: number | null
  toolCalls: number
  steps: number
  inputTokens: number
  outputTokens: number
  outputChars: number
  sessionID?: string
  llm?: LlmSummary
}

/** 프록시 기록을 요약한다. 제목 생성 같은 보조 호출이 섞이므로 속도는 본 모델 호출만 본다 */
export function summarizeLlm(records: LlmRecord[], mainModel: string): LlmSummary {
  const main = records.filter((r) => r.model === mainModel && r.done)
  const ttfts = main.map((r) => r.firstTokenMs).filter((v): v is number => v !== null)
  let genMs = 0
  let genTokens = 0
  for (const r of main) {
    if (r.firstTokenMs !== null && r.durationMs !== null && r.completionTokens) {
      genMs += Math.max(1, r.durationMs - r.firstTokenMs)
      genTokens += r.completionTokens
    }
  }
  return {
    requests: records.length,
    firstTokenMs: percentile(ttfts, 50),
    tokensPerSec: genMs > 0 ? Math.round((genTokens / genMs) * 1000 * 10) / 10 : null,
    promptTokens: records.reduce((a, r) => a + (r.promptTokens ?? 0), 0),
    completionTokens: records.reduce((a, r) => a + (r.completionTokens ?? 0), 0),
    errors: records.filter((r) => (r.status ?? 0) >= 400 || r.error !== null).length,
    clientAborted: records.filter((r) => r.clientAborted).length,
  }
}

export function metricFromResult(
  r: RunResult,
  info: { model: string; mode: string; label?: string; startedAt: Date; llm?: LlmSummary },
): RunMetric {
  return {
    at: info.startedAt.toISOString(),
    hour: info.startedAt.getHours(),
    model: info.model,
    mode: info.mode,
    label: info.label,
    durationMs: r.durationMs,
    firstEventMs: r.firstEventMs,
    firstTextMs: r.firstTextMs,
    endedBy: r.endedBy,
    exitCode: r.exitCode,
    toolCalls: r.toolCalls,
    steps: r.steps,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    outputChars: r.text.length,
    sessionID: r.sessionID,
    llm: info.llm,
  }
}

export function appendMetric(layout: Layout, m: RunMetric) {
  mkdirSync(dirname(layout.metricsFile), { recursive: true })
  appendFileSync(layout.metricsFile, JSON.stringify(m) + "\n")
}

export function readMetrics(layout: Layout): RunMetric[] {
  if (!existsSync(layout.metricsFile)) return []
  const out: RunMetric[] = []
  for (const line of readFileSync(layout.metricsFile, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 깨진 줄은 건너뛴다 (비정상 종료로 일부만 기록된 경우)
    }
  }
  return out
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

export interface GroupSummary {
  key: string
  count: number
  medianDurationMs: number | null
  p90DurationMs: number | null
  medianFirstEventMs: number | null
  /** 프록시 측정값 (프록시 없이 실행한 기록은 null) */
  medianFirstTokenMs: number | null
  medianTokensPerSec: number | null
  failed: number
}

/** 시간대(시)별 요약. model을 주면 해당 모델만 집계 */
export function summarizeByHour(metrics: RunMetric[], model?: string): GroupSummary[] {
  const groups = new Map<number, RunMetric[]>()
  for (const m of metrics) {
    if (model && m.model !== model) continue
    const list = groups.get(m.hour) ?? []
    list.push(m)
    groups.set(m.hour, list)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, list]) => ({
      key: `${String(hour).padStart(2, "0")}시`,
      count: list.length,
      medianDurationMs: percentile(list.map((m) => m.durationMs), 50),
      p90DurationMs: percentile(list.map((m) => m.durationMs), 90),
      medianFirstEventMs: percentile(
        list.map((m) => m.firstEventMs).filter((v): v is number => v !== null),
        50,
      ),
      medianFirstTokenMs: percentile(
        list.map((m) => m.llm?.firstTokenMs ?? null).filter((v): v is number => v !== null),
        50,
      ),
      medianTokensPerSec: percentile(
        list.map((m) => m.llm?.tokensPerSec ?? null).filter((v): v is number => v !== null),
        50,
      ),
      failed: list.filter((m) => m.endedBy !== "exit" || (m.exitCode ?? 1) !== 0).length,
    }))
}

const fmt = (ms: number | null) => (ms === null ? "-" : ms >= 60000 ? `${(ms / 60000).toFixed(1)}분` : `${(ms / 1000).toFixed(1)}초`)

export function formatSummary(rows: GroupSummary[]): string {
  if (rows.length === 0) return "기록이 없습니다."
  const header = "시간대  실행수  소요(중앙)  소요(90%)  첫토큰(중앙)  토큰/초  실패"
  const lines = rows.map(
    (r) =>
      `${r.key.padEnd(6)}  ${String(r.count).padStart(5)}  ${fmt(r.medianDurationMs).padStart(9)}  ${fmt(r.p90DurationMs).padStart(9)}  ${fmt(r.medianFirstTokenMs ?? r.medianFirstEventMs).padStart(11)}  ${(r.medianTokensPerSec === null ? "-" : r.medianTokensPerSec.toFixed(1)).padStart(7)}  ${String(r.failed).padStart(4)}`,
  )
  return [header, ...lines].join("\n")
}
