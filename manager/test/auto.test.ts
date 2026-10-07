import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { autoLogPath, decideMode, judgeSpeed, loadAutoState, recordDecision, type AutoSignals, type SpeedSignal } from "../src/auto"
import { AUTO_DEFAULTS, normalizeConfig } from "../src/config"
import type { RunMetric } from "../src/metrics"
import { layoutFor } from "../src/paths"

const NOW = new Date(2026, 9, 7, 14, 0, 0)

const metric = (minutesAgo: number, ttftMs: number | null, tps: number | null): RunMetric => ({
  at: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  hour: 0, model: "m", mode: "day", durationMs: 1, firstEventMs: 1, firstTextMs: 1, endedBy: "exit", exitCode: 0,
  toolCalls: 0, steps: 1, inputTokens: 0, outputTokens: 0, outputChars: 0,
  llm: { requests: 1, firstTokenMs: ttftMs, tokensPerSec: tps, promptTokens: 1, completionTokens: 1, errors: 0, clientAborted: 0 },
})

describe("속도 판단", () => {
  const many = (ttft: number, tps: number, n = 5) => Array.from({ length: n }, (_, i) => metric(10 + i, ttft, tps))

  test("표본이 모자라면 알 수 없음", () => {
    const s = judgeSpeed(many(1000, 50, 2), NOW, AUTO_DEFAULTS, null)
    expect(s.level).toBe("unknown")
    expect(s.note).toContain("알 수 없습니다")
  })

  test("첫 토큰이 늦거나 초당 토큰이 낮으면 느림, 아니면 빠름", () => {
    expect(judgeSpeed(many(3000, 30), NOW, AUTO_DEFAULTS, null).level).toBe("fast")
    expect(judgeSpeed(many(45_000, 30), NOW, AUTO_DEFAULTS, null).level).toBe("slow")
    expect(judgeSpeed(many(3000, 3), NOW, AUTO_DEFAULTS, null).level).toBe("slow")
  })

  test("완충: 직전에 느렸다면 기준 근처로는 빠름으로 돌아가지 않는다", () => {
    // 기준 20초. 18초는 처음엔 빠름이지만, 직전이 느림이었다면 기준의 70%(14초) 이하여야 회복
    expect(judgeSpeed(many(18_000, 30), NOW, AUTO_DEFAULTS, null).level).toBe("fast")
    const stay = judgeSpeed(many(18_000, 30), NOW, AUTO_DEFAULTS, "slow")
    expect(stay.level).toBe("slow")
    expect(stay.note).toContain("충분히 회복되지 않음")
    expect(judgeSpeed(many(10_000, 30), NOW, AUTO_DEFAULTS, "slow").level).toBe("fast")
  })

  test("오래된 기록은 보지 않는다", () => {
    const old = Array.from({ length: 5 }, (_, i) => metric(60 * 8 + i, 90_000, 1)) // 8시간 전
    expect(judgeSpeed(old, NOW, AUTO_DEFAULTS, null).level).toBe("unknown")
    const mixed = [...old, ...many(2000, 40)]
    expect(judgeSpeed(mixed, NOW, AUTO_DEFAULTS, null).level).toBe("fast")
  })

  test("속도 기록이 없는 실행(프록시 없이 실행)은 세지 않는다", () => {
    const noLlm = { ...metric(5, 1, 1), llm: undefined } as RunMetric
    expect(judgeSpeed([noLlm, noLlm, noLlm, noLlm], NOW, AUTO_DEFAULTS, null).level).toBe("unknown")
  })
})

const speed = (level: SpeedSignal["level"]): SpeedSignal => ({ samples: 5, medianFirstTokenMs: 1000, medianTokensPerSec: 20, level, note: `속도 ${level}` })
const sig = (o: Partial<AutoSignals> = {}): AutoSignals => ({
  now: NOW, inNightWindow: false, human: true, speed: speed("fast"), approvedPlan: false, hasInstruction: false, ...o,
})

describe("모드 판단", () => {
  test("사람이 지시문을 주면 낮 동작(감독 실행), 느리면 가볍게", () => {
    const d = decideMode(sig({ hasInstruction: true }))
    expect(d).toMatchObject({ action: "day", dayKind: "instruction", light: false })
    expect(decideMode(sig({ hasInstruction: true, speed: speed("slow") })).light).toBe(true)
    expect(decideMode(sig({ hasInstruction: true, speed: speed("unknown") })).light).toBe(false) // 모르면 가볍게 하지 않음
  })

  test("무인 상태에서 승인된 계획서 없이는 시작하지 않는다 (지시문이 있어도)", () => {
    const a = decideMode(sig({ human: false, hasInstruction: true }))
    expect(a.action).toBe("refuse")
    expect(a.reasons.join(" ")).toContain("승인된 계획서")
    const b = decideMode(sig({ human: false, approvalReason: "승인 기록이 없습니다" }))
    expect(b.action).toBe("refuse")
    expect(b.reasons.join(" ")).toContain("승인 기록이 없습니다")
  })

  test("무인 + 승인된 계획서면 밤 동작", () => {
    expect(decideMode(sig({ human: false, approvedPlan: true })).action).toBe("night")
    expect(decideMode(sig({ human: false, approvedPlan: true, inNightWindow: true })).action).toBe("night")
  })

  test("사람이 있고 승인된 계획서가 있으면 야간 창 안은 밤, 낮은 원본 화면", () => {
    expect(decideMode(sig({ approvedPlan: true, inNightWindow: true })).action).toBe("night")
    const d = decideMode(sig({ approvedPlan: true, inNightWindow: false }))
    expect(d).toMatchObject({ action: "day", dayKind: "interactive" })
    expect(d.reasons.join(" ")).toContain("ocx day --task")
  })

  test("사람이 있고 계획서도 지시문도 없으면 원본 화면", () => {
    expect(decideMode(sig())).toMatchObject({ action: "day", dayKind: "interactive" })
    expect(decideMode(sig({ speed: speed("slow") })).light).toBe(true)
  })

  test("모드를 직접 지정해도 무인 시작의 안전 조건은 확인한다", () => {
    expect(decideMode(sig({ human: false }), { mode: "night" }).action).toBe("refuse")
    expect(decideMode(sig({ human: false, approvedPlan: true }), { mode: "night" }).action).toBe("night")
    expect(decideMode(sig({ human: false }), { mode: "day" }).action).toBe("refuse")
    expect(decideMode(sig({ human: true }), { mode: "day" })).toMatchObject({ action: "day", dayKind: "interactive" })
    expect(decideMode(sig({ human: true, approvedPlan: true, inNightWindow: true }), { mode: "day" }).action).toBe("day")
  })

  test("판단 이유에 시각과 속도 근거가 들어간다", () => {
    const r = decideMode(sig({ hasInstruction: true })).reasons.join("\n")
    expect(r).toContain("14시")
    expect(r).toContain("속도 fast")
  })
})

describe("판단 기록", () => {
  test("직전 판단을 저장하고, 달라지면 전환 사유를 알려 준다", () => {
    const layout = layoutFor(mkdtempSync(join(tmpdir(), "ocx-au-")))
    expect(loadAutoState(layout)).toBeNull()
    const first = recordDecision(layout, decideMode(sig({ hasInstruction: true })), "fast", NOW)
    expect(first).toBeNull() // 처음이라 전환 아님
    expect(loadAutoState(layout)).toMatchObject({ lastLevel: "fast", lastAction: "day(instruction)" })
    const again = recordDecision(layout, decideMode(sig({ hasInstruction: true })), "fast", NOW)
    expect(again).toBeNull()
    const sw = recordDecision(layout, decideMode(sig({ human: false, approvedPlan: true })), "slow", NOW)
    expect(sw).toBe("day(instruction) → night")
    const lines = readFileSync(autoLogPath(layout), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.length).toBe(3)
    expect(lines[2].switchedFrom).toBe("day(instruction)")
  })
})

describe("오토 설정", () => {
  const b = { models: { a: { baseURL: "http://h/v1", model: "m" } } }
  test("기본값과 범위 검사", () => {
    expect(normalizeConfig(b).auto).toEqual(AUTO_DEFAULTS)
    expect(normalizeConfig({ ...b, auto: { slowFirstTokenSeconds: 30, minSamples: 5 } }).auto).toMatchObject({ slowFirstTokenSeconds: 30, minSamples: 5, recoverFactor: 0.7 })
    expect(() => normalizeConfig({ ...b, auto: { recoverFactor: 2 } })).toThrow("auto.recoverFactor")
    expect(() => normalizeConfig({ ...b, auto: { minSamples: 0 } })).toThrow("auto.minSamples")
  })
})
