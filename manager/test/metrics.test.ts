import { describe, expect, test } from "bun:test"
import { mkdtempSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendMetric, formatSummary, percentile, readMetrics, summarizeByHour, summarizeLlm, type RunMetric } from "../src/metrics"
import type { LlmRecord } from "../src/proxy"
import { layoutFor } from "../src/paths"

const metric = (hour: number, durationMs: number, extra: Partial<RunMetric> = {}): RunMetric => ({
  at: new Date().toISOString(),
  hour,
  model: "qwen38",
  mode: "run",
  durationMs,
  firstEventMs: 100,
  firstTextMs: 200,
  endedBy: "exit",
  exitCode: 0,
  toolCalls: 0,
  steps: 1,
  inputTokens: 0,
  outputTokens: 0,
  outputChars: 10,
  ...extra,
})

describe("속도 기록", () => {
  test("백분위 계산", () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(50)
  })

  test("기록 저장과 읽기, 깨진 줄은 건너뜀", () => {
    const layout = layoutFor(mkdtempSync(join(tmpdir(), "ocx-")))
    appendMetric(layout, metric(14, 1000))
    appendFileSync(layout.metricsFile, "{깨진줄\n")
    appendMetric(layout, metric(15, 2000))
    expect(readMetrics(layout).map((m) => m.hour)).toEqual([14, 15])
  })

  test("시간대별 요약", () => {
    const rows = summarizeByHour([
      metric(14, 600000),
      metric(14, 1200000, { endedBy: "stall" }),
      metric(2, 5000),
    ])
    expect(rows.map((r) => r.key)).toEqual(["02시", "14시"])
    const r14 = rows.find((r) => r.key === "14시")!
    expect(r14.count).toBe(2)
    expect(r14.failed).toBe(1)
    expect(formatSummary(rows)).toContain("14시")
    expect(formatSummary([])).toBe("기록이 없습니다.")
  })

  test("모델 필터", () => {
    const rows = summarizeByHour([metric(1, 1), metric(1, 2, { model: "oss" })], "oss")
    expect(rows[0]!.count).toBe(1)
  })

  test("프록시 측정값을 시간대 요약에 반영한다", () => {
    const rows = summarizeByHour([
      metric(14, 1000, { llm: { requests: 2, firstTokenMs: 4000, tokensPerSec: 5, promptTokens: 1, completionTokens: 1, errors: 0, clientAborted: 0 } }),
      metric(14, 1000, { llm: { requests: 2, firstTokenMs: 8000, tokensPerSec: 9, promptTokens: 1, completionTokens: 1, errors: 0, clientAborted: 0 } }),
    ])
    expect(rows[0]!.medianFirstTokenMs).toBe(4000)
    expect(rows[0]!.medianTokensPerSec).toBe(5)
    expect(formatSummary(rows)).toContain("토큰/초")
  })
})

const rec = (over: Partial<LlmRecord>): LlmRecord => ({
  id: 1, model: "big", path: "/chat/completions", startedAt: 0, firstByteMs: 10, firstTokenMs: 1000, durationMs: 3000,
  status: 200, chunks: 5, promptTokens: 100, completionTokens: 40, clientAborted: false, stalledAborted: false,
  error: null, done: true, ...over,
})

describe("프록시 기록 요약", () => {
  test("본 모델 호출만으로 속도를 계산하고 오류를 센다", () => {
    const s = summarizeLlm(
      [
        rec({}), // 본 모델: 생성 구간 2000ms, 40토큰 -> 20토큰/초
        rec({ id: 2, model: "small", firstTokenMs: 50, durationMs: 100, completionTokens: 3 }),
        rec({ id: 3, status: 503, firstTokenMs: null, completionTokens: null, error: null }),
      ],
      "big",
    )
    expect(s.requests).toBe(3)
    expect(s.tokensPerSec).toBe(20)
    expect(s.firstTokenMs).toBe(1000)
    expect(s.errors).toBe(1)
    expect(s.promptTokens).toBe(300)
    expect(s.completionTokens).toBe(43)
  })

  test("기록이 없으면 null", () => {
    const s = summarizeLlm([], "big")
    expect(s.firstTokenMs).toBeNull()
    expect(s.tokensPerSec).toBeNull()
  })
})
