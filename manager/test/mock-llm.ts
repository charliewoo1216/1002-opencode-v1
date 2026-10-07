// 모의 OpenAI 호환 LLM 서버 (테스트 전용)
// - /v1/chat/completions (스트리밍/비스트리밍), /v1/models 제공
// - /__control 로 지연, 오류, 무응답, 도구 호출 등을 실시간으로 바꿀 수 있다.

export interface MockControl {
  /** 첫 토큰이 나오기 전 대기 시간(ms) — 서버 혼잡 재현 */
  firstTokenDelayMs: number
  /** 토큰 사이 간격(ms) */
  tokenIntervalMs: number
  /** 응답 본문으로 보낼 텍스트 */
  replyText: string
  /** 다음 N개 요청을 이 HTTP 상태로 실패시킨다 (0이면 정상) */
  failNext: number
  failStatus: number
  /** true면 응답을 보내지 않고 계속 붙들고 있다 (정체 재현) */
  hang: boolean
  /** 도구가 포함된 요청(본 작업) 중 다음 N개만 응답하지 않는다 */
  hangNext: number
  /** N > 0이면 앞으로 오는 도구 포함 요청(본 작업) 중 N번째에서만 응답하지 않는다 (요청마다 1씩 줄어드는 카운트다운) */
  hangOnMain: number
  /** N > 0이면 도구 결과와 상관없이 N번 연속으로 같은 도구 호출만 응답한다 (루프 재현) */
  repeatToolCalls: number
  /** 첫 호출에서 이 도구를 호출하게 한다 (도구 결과가 오면 텍스트로 마무리) */
  toolCall: { name: string; args: Record<string, unknown> } | null
  /** 마지막 user 메시지 또는 system 메시지에 match 문구가 있으면 해당 text로 응답 (위에서부터 첫 일치) */
  rules: Array<{ match: string; text: string }>
  /** 마지막 user 메시지에 match 문구가 있으면 첫 토큰 전에 ms만큼 더 기다린다 (특정 작업만 느리게 만들 때) */
  delayRules: Array<{ match: string; ms: number }>
  /** 요청 내용에 match 문구가 있으면 해당 도구를 호출하게 한다 (도구 결과가 이미 있으면 텍스트로 마무리). 위에서부터 첫 일치 */
  toolRules: Array<{ match: string; name: string; args: Record<string, unknown> }>
}

export interface MockRequestLog {
  at: number
  model: string
  stream: boolean
  messageCount: number
  hasTools: boolean
  /** 서버가 응답을 시작하기 전 연결이 끊겼는지 */
  aborted: boolean
  status: number
  /** 첫 system 메시지 앞부분 (에이전트 프롬프트 주입 확인용) */
  systemText: string
  /** 요청에 포함된 도구 이름들 */
  toolNames: string[]
  /** 마지막 user 메시지 앞부분 */
  lastUserText: string
  /** 요청 본문 전체 (본문 패치 확인용) */
  body: Record<string, unknown>
}

const defaults = (): MockControl => ({
  firstTokenDelayMs: 0,
  tokenIntervalMs: 0,
  replyText: "모의 응답입니다.",
  failNext: 0,
  failStatus: 503,
  hang: false,
  hangNext: 0,
  hangOnMain: 0,
  repeatToolCalls: 0,
  toolCall: null,
  rules: [],
  toolRules: [],
  delayRules: [],
})

export function startMockLlm(port = 0) {
  const control: MockControl = defaults()
  const logs: MockRequestLog[] = []
  let toolCallCounter = 0

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)

      if (url.pathname === "/__control") {
        if (req.method === "POST") Object.assign(control, await req.json())
        if (req.method === "DELETE") Object.assign(control, defaults())
        return Response.json({ control, requests: logs.length })
      }
      if (url.pathname === "/__logs") return Response.json(logs)

      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "mock-1", object: "model" }] })
      }

      if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
        const body = (await req.json()) as {
          model: string
          stream?: boolean
          messages: Array<{ role: string; content?: unknown }>
          tools?: Array<{ function?: { name?: string } }>
        }
        const textOf = (c: unknown) =>
          typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : ""
        const sys = body.messages.find((m) => m.role === "system")
        const lastUser = [...body.messages].reverse().find((m) => m.role === "user")
        const entry: MockRequestLog = {
          at: Date.now(),
          model: body.model,
          stream: !!body.stream,
          messageCount: body.messages.length,
          hasTools: !!body.tools?.length,
          aborted: false,
          status: 200,
          systemText: textOf(sys?.content).slice(0, 2000),
          toolNames: (body.tools ?? []).map((t) => t.function?.name ?? "").filter(Boolean),
          lastUserText: textOf(lastUser?.content).slice(0, 12000),
          body: body as unknown as Record<string, unknown>,
        }
        logs.push(entry)
        req.signal.addEventListener("abort", () => {
          entry.aborted = true
        })

        // 오류 주입
        if (control.failNext > 0) {
          control.failNext--
          entry.status = control.failStatus
          return new Response(JSON.stringify({ error: { message: "mock failure" } }), {
            status: control.failStatus,
            headers: { "content-type": "application/json" },
          })
        }

        // 정체 주입: 연결이 끊길 때까지 응답하지 않는다
        let hangOnThis = false
        if (entry.hasTools && control.hangOnMain > 0) {
          control.hangOnMain--
          hangOnThis = control.hangOnMain === 0
        }
        const hangThis = control.hang || hangOnThis || (control.hangNext > 0 && entry.hasTools)
        if (hangThis && !control.hang && !hangOnThis) control.hangNext--
        if (hangThis) {
          await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve()))
          return new Response(null, { status: 499 })
        }

        // 도구 결과가 이미 있으면(=도구 호출 이후 턴) 텍스트로 마무리한다
        const hasToolResult = body.messages.some((m) => m.role === "tool")
        const toolRule = control.toolRules.find((r) => entry.lastUserText.includes(r.match))
        let toolSpec = control.toolCall
        let wantTool = !!control.toolCall && !hasToolResult && !!body.tools?.length
        if (!wantTool && toolRule && !hasToolResult && body.tools?.length) {
          toolSpec = { name: toolRule.name, args: toolRule.args }
          wantTool = true
        }
        if (control.toolCall && control.repeatToolCalls > 0 && body.tools?.length) {
          control.repeatToolCalls--
          wantTool = true
        }

        // 규칙에 맞는 응답 선택 (제목 생성 같은 요청과 본 요청을 구분해서 응답하기 위함)
        const rule = control.rules.find((r) => entry.lastUserText.includes(r.match) || entry.systemText.includes(r.match))
        const replyText = rule ? rule.text : control.replyText

        const extraDelay = control.delayRules.find((r) => entry.lastUserText.includes(r.match))?.ms ?? 0
        await sleep(control.firstTokenDelayMs + extraDelay)
        const id = `chatcmpl-mock-${Date.now()}`
        const created = Math.floor(Date.now() / 1000)

        // 비스트리밍
        if (!body.stream) {
          const message = wantTool
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call_${++toolCallCounter}`,
                    type: "function",
                    function: { name: toolSpec!.name, arguments: JSON.stringify(toolSpec!.args) },
                  },
                ],
              }
            : { role: "assistant", content: replyText }
          return Response.json({
            id,
            object: "chat.completion",
            created,
            model: body.model,
            choices: [{ index: 0, message, finish_reason: wantTool ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          })
        }

        // 스트리밍
        const encoder = new TextEncoder()
        const chunk = (delta: unknown, finish: string | null = null) =>
          encoder.encode(
            `data: ${JSON.stringify({
              id,
              object: "chat.completion.chunk",
              created,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
              // 마지막 청크에는 사용량을 넣는다 (실제 서버의 include_usage 동작과 유사)
              ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } } : {}),
            })}\n\n`,
          )

        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(chunk({ role: "assistant", content: "" }))
            if (wantTool) {
              controller.enqueue(
                chunk({
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${++toolCallCounter}`,
                      type: "function",
                      function: {
                        name: toolSpec!.name,
                        arguments: JSON.stringify(toolSpec!.args),
                      },
                    },
                  ],
                }),
              )
              controller.enqueue(chunk({}, "tool_calls"))
            } else {
              for (const word of replyText.split(/(?<=\s)/)) {
                if (req.signal.aborted) break
                controller.enqueue(chunk({ content: word }))
                if (control.tokenIntervalMs > 0) await sleep(control.tokenIntervalMs)
              }
              controller.enqueue(chunk({}, "stop"))
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }

      return new Response("not found", { status: 404 })
    },
  })

  return {
    server,
    control,
    logs,
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }
}

// 단독 실행: bun run test/mock-llm.ts [포트]
if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8000)
  const mock = startMockLlm(port)
  console.log(`모의 LLM 서버 시작: ${mock.url}/v1`)
}
