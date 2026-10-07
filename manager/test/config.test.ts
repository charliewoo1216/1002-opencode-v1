import { describe, expect, test } from "bun:test"
import { ConfigError, DAY_DEFAULTS, buildOpencodeConfig, closedNetworkEnv, normalizeConfig, opencodeModelRef } from "../src/config"

const base = {
  models: {
    qwen38: { baseURL: "http://h:8000/v1/", model: "qwen3.8-27b" },
    oss: { baseURL: "http://h:8001/v1", model: "gpt-oss", apiKey: "k" },
  },
}

describe("설정 검증", () => {
  test("기본값을 채운다", () => {
    const cfg = normalizeConfig(base)
    expect(cfg.defaultModel).toBe("qwen38")
    expect(cfg.models.qwen38!.apiKey).toBe("EMPTY")
    expect(cfg.models.qwen38!.baseURL).toBe("http://h:8000/v1") // 끝의 / 제거
    expect(cfg.closedNetwork).toBe(true)
    expect(cfg.opencode.command).toEqual(["opencode"])
  })

  test("잘못된 설정은 한글 오류를 낸다", () => {
    expect(() => normalizeConfig(null)).toThrow(ConfigError)
    expect(() => normalizeConfig({ models: {} })).toThrow("모델을 1개 이상")
    expect(() => normalizeConfig({ models: { a: { baseURL: "ftp://x", model: "m" } } })).toThrow("baseURL")
    expect(() => normalizeConfig({ models: { "a b": { baseURL: "http://x", model: "m" } } })).toThrow("영문")
    expect(() => normalizeConfig({ ...base, defaultModel: "none" })).toThrow("defaultModel")
    expect(() => normalizeConfig({ ...base, smallModel: "none" })).toThrow("smallModel")
    expect(() => normalizeConfig({ ...base, opencode: { command: "opencode" } })).toThrow("opencode.command")
  })

  test("원본 opencode 설정을 만든다", () => {
    const cfg = normalizeConfig({ ...base, smallModel: "oss" })
    const oc = buildOpencodeConfig(cfg, "qwen38") as any
    expect(oc.model).toBe("qwen38/qwen3.8-27b")
    expect(oc.small_model).toBe("oss/gpt-oss")
    expect(oc.provider.qwen38.npm).toBe("@ai-sdk/openai-compatible")
    expect(oc.provider.qwen38.options).toEqual({ baseURL: "http://h:8000/v1", apiKey: "EMPTY" })
    expect(oc.provider.oss.options.apiKey).toBe("k")
    expect(oc.autoupdate).toBe(false)
  })

  test("등록되지 않은 모델 선택은 오류", () => {
    const cfg = normalizeConfig(base)
    expect(() => opencodeModelRef(cfg, "nope")).toThrow("등록되지 않은 모델")
  })

  test("폐쇄망 환경변수에 모델 목록 차단이 포함된다", () => {
    expect(closedNetworkEnv().OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  })

  test("낮 모드 설정은 기본값을 채우고 범위를 검사한다", () => {
    expect(normalizeConfig(base).day).toEqual(DAY_DEFAULTS)
    const c = normalizeConfig({ ...base, day: { attemptBudgetMinutes: 5, maxAttempts: 2, lightBody: { chat_template_kwargs: { enable_thinking: false } } } })
    expect(c.day.attemptBudgetMinutes).toBe(5)
    expect(c.day.maxAttempts).toBe(2)
    expect(c.day.streamIdleSeconds).toBe(DAY_DEFAULTS.streamIdleSeconds)
    expect(c.day.lightBody).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(() => normalizeConfig({ ...base, day: { maxAttempts: 0 } })).toThrow("day.maxAttempts")
    expect(() => normalizeConfig({ ...base, day: { contextRenewRatio: 2 } })).toThrow("day.contextRenewRatio")
    expect(() => normalizeConfig({ ...base, day: { lightBody: [] } })).toThrow("day.lightBody")
  })

  test("모델별 extraBody와 프로필·참조 폴더 설정을 읽는다", () => {
    const c = normalizeConfig({
      models: { a: { baseURL: "http://h/v1", model: "m", extraBody: { top_k: 20 } } },
      profilesDir: "my-profiles",
      referenceDir: "refs",
    })
    expect(c.models.a!.extraBody).toEqual({ top_k: 20 })
    expect(c.profilesDir).toBe("my-profiles")
    expect(c.referenceDir).toBe("refs")
  })

  test("에이전트·지침·권한을 원본 설정에 넣는다", () => {
    const cfg = normalizeConfig(base)
    const oc = buildOpencodeConfig(cfg, "qwen38", {
      agents: { x: { prompt: "p" } },
      instructions: ["/a/AGENTS.md"],
      permission: { webfetch: "deny" },
      baseURLOverrides: { qwen38: "http://127.0.0.1:9/qwen38" },
    }) as any
    expect(oc.agent).toEqual({ x: { prompt: "p" } })
    expect(oc.instructions).toEqual(["/a/AGENTS.md"])
    expect(oc.permission).toEqual({ webfetch: "deny" })
    expect(oc.provider.qwen38.options.baseURL).toBe("http://127.0.0.1:9/qwen38")
    expect(oc.provider.oss.options.baseURL).toBe("http://h:8001/v1")
  })
})

describe("밤 모드 설정", () => {
  const b = { models: { a: { baseURL: "http://h/v1", model: "m" } } }
  test("기본값과 범위 검사", async () => {
    const { NIGHT_DEFAULTS } = await import("../src/config")
    expect(normalizeConfig(b).night).toEqual(NIGHT_DEFAULTS)
    expect(normalizeConfig(b).night.endTime).toBe("07:00")
    expect(normalizeConfig({ ...b, night: { endTime: "06:30", maxFixRounds: 5, scope: "strict", fastWindow: { enabled: true } } }).night).toMatchObject({
      endTime: "06:30", maxFixRounds: 5, scope: "strict", fastWindow: { enabled: true, start: "01:00", end: "07:00" },
    })
    expect(() => normalizeConfig({ ...b, night: { endTime: "7시" } })).toThrow("night.endTime")
    expect(() => normalizeConfig({ ...b, night: { scope: "x" } })).toThrow("night.scope")
    expect(() => normalizeConfig({ ...b, night: { maxFixRounds: -1 } })).toThrow("night.maxFixRounds")
    expect(() => normalizeConfig({ ...b, night: { fastWindow: { start: "abc" } } })).toThrow("fastWindow.start")
  })
})

describe("안전 규칙 설정", () => {
  const b = { models: { a: { baseURL: "http://h/v1", model: "m" } } }
  test("추가 금지 명령을 읽고 검증한다", () => {
    expect(normalizeConfig(b).safety).toEqual({ extraBlocked: [] })
    expect(normalizeConfig({ ...b, safety: { extraBlocked: ["Docker", "kubectl", "docker"] } }).safety.extraBlocked).toEqual(["docker", "kubectl"])
    expect(() => normalizeConfig({ ...b, safety: { extraBlocked: "docker" } })).toThrow("safety.extraBlocked")
    expect(() => normalizeConfig({ ...b, safety: { extraBlocked: ["rm -rf"] } })).toThrow("safety.extraBlocked")
    expect(() => normalizeConfig({ ...b, safety: 1 })).toThrow("safety")
  })
})
