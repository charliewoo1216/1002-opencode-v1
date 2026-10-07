import { afterAll, describe, expect, test } from "bun:test"
import { deepMerge, startMeasureProxy } from "../src/proxy"
import { startMockLlm } from "./mock-llm"

const mock = startMockLlm(0)
afterAll(() => mock.stop())

const chat = (base: string, stream = true) =>
  fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer EMPTY" },
    body: JSON.stringify({ model: "m", stream, messages: [{ role: "user", content: "hi" }] }),
  })

describe("측정 프록시", () => {
  test("스트리밍을 그대로 통과시키고 첫 토큰 시간·사용량을 기록한다", async () => {
    mock.control.firstTokenDelayMs = 300
    mock.control.tokenIntervalMs = 0
    mock.control.replyText = "하나 둘 셋 "
    const proxy = startMeasureProxy({ upstreams: { big: `${mock.url}/v1` } })
    try {
      const res = await chat(proxy.urlFor("big"))
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text).toContain("하나")
      expect(text).toContain("[DONE]")
      await Bun.sleep(50)
      const [rec] = proxy.records
      expect(rec!.model).toBe("big")
      expect(rec!.path).toBe("/chat/completions")
      expect(rec!.done).toBe(true)
      expect(rec!.firstTokenMs!).toBeGreaterThanOrEqual(280)
      expect(rec!.durationMs!).toBeGreaterThanOrEqual(rec!.firstTokenMs!)
      expect(rec!.promptTokens).toBe(10)
      expect(rec!.completionTokens).toBe(7)
      expect(rec!.chunks).toBeGreaterThan(0)
    } finally {
      proxy.stop()
      mock.control.firstTokenDelayMs = 0
    }
  })

  test("상류의 오류 상태 코드를 그대로 전달한다", async () => {
    mock.control.failNext = 1
    mock.control.failStatus = 503
    const proxy = startMeasureProxy({ upstreams: { big: `${mock.url}/v1` } })
    try {
      const res = await chat(proxy.urlFor("big"))
      expect(res.status).toBe(503)
      await res.text()
      await Bun.sleep(50)
      expect(proxy.records[0]!.status).toBe(503)
    } finally {
      proxy.stop()
    }
  })

  test("클라이언트가 끊으면 상류 연결도 끊는다", async () => {
    mock.control.hang = true
    const before = mock.logs.length
    const proxy = startMeasureProxy({ upstreams: { big: `${mock.url}/v1` } })
    try {
      const ac = new AbortController()
      const p = fetch(`${proxy.urlFor("big")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, messages: [] }),
        signal: ac.signal,
      }).catch(() => null)
      await Bun.sleep(300)
      ac.abort()
      await p
      await Bun.sleep(500)
      expect(proxy.records[0]!.clientAborted).toBe(true)
      expect(mock.logs.slice(before).every((l) => l.aborted)).toBe(true)
    } finally {
      mock.control.hang = false
      proxy.stop()
    }
  })

  test("응답이 멈추면 정체를 알리고, 설정하면 상류 연결을 끊는다", async () => {
    mock.control.hang = true
    const stalled: number[] = []
    const proxy = startMeasureProxy({
      upstreams: { big: `${mock.url}/v1` },
      idleTimeoutMs: 400,
      abortOnStall: true,
      onStall: (r) => stalled.push(r.id),
    })
    try {
      const res = await chat(proxy.urlFor("big")).catch(() => null)
      await Bun.sleep(1200)
      expect(stalled.length).toBe(1)
      expect(proxy.records[0]!.stalledAborted).toBe(true)
      expect(proxy.records[0]!.done).toBe(true)
      void res
    } finally {
      mock.control.hang = false
      proxy.stop()
    }
  })

  test("알 수 없는 모델은 404, 상류 연결 실패는 502", async () => {
    const proxy = startMeasureProxy({ upstreams: { dead: "http://127.0.0.1:1/v1" } })
    try {
      expect((await chat(proxy.urlFor("none"))).status).toBe(404)
      const res = await chat(proxy.urlFor("dead"))
      expect(res.status).toBe(502)
      expect(proxy.records.at(-1)!.error).not.toBeNull()
    } finally {
      proxy.stop()
    }
  })

  test("첫 토큰 대기 한도와 응답 중간 정체 한도를 따로 적용한다", async () => {
    // 첫 토큰이 700ms 걸리지만, 첫 토큰 대기 한도가 길어서 정체로 보지 않는다
    mock.control.firstTokenDelayMs = 700
    const stalled: number[] = []
    const proxy = startMeasureProxy({
      upstreams: { big: `${mock.url}/v1` },
      idleTimeoutMs: 300,
      firstTokenTimeoutMs: 3000,
      abortOnStall: true,
      onStall: (r) => stalled.push(r.id),
    })
    try {
      const res = await chat(proxy.urlFor("big"))
      await res.text()
      expect(stalled).toEqual([])
      expect(proxy.records[0]!.stalledAborted).toBe(false)
    } finally {
      mock.control.firstTokenDelayMs = 0
      proxy.stop()
    }

    // 첫 토큰 대기 한도가 짧으면 정체로 본다
    mock.control.hang = true
    const stalled2: number[] = []
    const proxy2 = startMeasureProxy({
      upstreams: { big: `${mock.url}/v1` },
      idleTimeoutMs: 5000,
      firstTokenTimeoutMs: 400,
      onStall: (r) => stalled2.push(r.id),
    })
    try {
      void chat(proxy2.urlFor("big")).catch(() => null)
      await Bun.sleep(1200)
      expect(stalled2.length).toBe(1)
    } finally {
      mock.control.hang = false
      proxy2.stop()
    }
  })

  test("모델별 본문 패치를 요청에 덧붙인다 (깊은 병합)", async () => {
    const before = mock.logs.length
    const proxy = startMeasureProxy({
      upstreams: { big: `${mock.url}/v1`, other: `${mock.url}/v1` },
      bodyPatch: { big: { chat_template_kwargs: { enable_thinking: false }, max_tokens: 123 } },
    })
    try {
      await (await chat(proxy.urlFor("big"))).text()
      await (await chat(proxy.urlFor("other"))).text()
      const [a, b] = mock.logs.slice(before)
      expect((a!.body as any).chat_template_kwargs).toEqual({ enable_thinking: false })
      expect((a!.body as any).max_tokens).toBe(123)
      expect((a!.body as any).messages).toBeDefined() // 원래 필드는 유지
      expect((b!.body as any).chat_template_kwargs).toBeUndefined() // 다른 모델에는 적용 안 됨
    } finally {
      proxy.stop()
    }
  })
})

describe("깊은 병합", () => {
  test("객체는 병합하고 배열·원시값은 덮어쓴다", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2], e: 4 })).toEqual({ a: { b: 1, c: 3 }, d: [2], e: 4 })
  })
})
