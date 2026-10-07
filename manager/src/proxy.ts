// 로컬 측정 프록시
// OpenCode의 LLM 접속 주소를 이 프록시로 바꿔 두면, 모든 요청/응답이 여기를 지나가므로
// 토큰 단위(SSE 청크)로 첫 토큰 시간, 속도, 정체를 정확히 잴 수 있다.
// (원본 `run --format json`의 text 이벤트는 응답이 끝난 뒤에만 나오기 때문에 이벤트만으로는 불가능)
//
// 경로 규약: http://127.0.0.1:<포트>/<모델이름>/<나머지> -> <모델의 baseURL>/<나머지>

export interface LlmRecord {
  id: number
  /** ocx.config의 모델 이름 */
  model: string
  path: string
  startedAt: number
  /** 요청 도착부터 응답 헤더(첫 바이트)까지 */
  firstByteMs: number | null
  /** 요청 도착부터 첫 "내용" 청크(본문/도구 호출/추론)까지 */
  firstTokenMs: number | null
  durationMs: number | null
  status: number | null
  chunks: number
  promptTokens: number | null
  completionTokens: number | null
  /** 클라이언트(OpenCode)가 먼저 연결을 끊음 */
  clientAborted: boolean
  /** 정체로 판단되어 프록시가 상류 연결을 끊음 */
  stalledAborted: boolean
  /** 상류 연결 실패 등 오류 메시지 */
  error: string | null
  /** 응답이 끝났는지 */
  done: boolean
}

export interface ProxyOptions {
  /** 모델 이름 -> 상류 baseURL */
  upstreams: Record<string, string>
  port?: number
  /** 첫 토큰이 나온 뒤 다음 청크가 이 시간(ms) 동안 오지 않으면 정체로 판단 (0/생략: 사용 안 함) */
  idleTimeoutMs?: number
  /**
   * 첫 토큰이 나오기 전 대기 한도(ms). 생략하면 idleTimeoutMs와 같다.
   * 서버 대기열에서 기다리는 중에 끊고 다시 요청하면 줄 순서를 잃을 수 있어, 응답 중간 정체보다 길게 잡는 것이 안전하다.
   */
  firstTokenTimeoutMs?: number
  /** 모델 이름 -> 요청 본문(JSON)에 덧붙일 필드 (예: chat_template_kwargs로 사고 모드 끄기). 객체는 깊게 병합 */
  bodyPatch?: Record<string, Record<string, unknown>>
  /** true면 정체 시 상류 연결을 끊는다 (OpenCode가 오류로 보고 자체 재시도하게 됨). 기본 false */
  abortOnStall?: boolean
  onRecord?: (r: LlmRecord) => void
  onStall?: (r: LlmRecord) => void
}

export interface MeasureProxy {
  port: number
  /** OpenCode에 넘길 모델별 baseURL */
  urlFor(model: string): string
  records: LlmRecord[]
  stop(): void
}

/** 객체는 깊게 병합하고, 그 외 값은 patch가 이긴다 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (isPlain(base) && isPlain(patch)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(patch)) out[k] = k in out ? deepMerge(out[k], v) : v
    return out
  }
  return patch
}
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"])

export function startMeasureProxy(opts: ProxyOptions): MeasureProxy {
  const records: LlmRecord[] = []
  let nextId = 1

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const parts = url.pathname.split("/").filter(Boolean)
      const model = parts.shift() ?? ""
      const base = opts.upstreams[model]
      if (!base) return new Response(`알 수 없는 모델: ${model}`, { status: 404 })
      const upstreamUrl = `${base.replace(/\/+$/, "")}/${parts.join("/")}${url.search}`

      const rec: LlmRecord = {
        id: nextId++,
        model,
        path: `/${parts.join("/")}`,
        startedAt: Date.now(),
        firstByteMs: null,
        firstTokenMs: null,
        durationMs: null,
        status: null,
        chunks: 0,
        promptTokens: null,
        completionTokens: null,
        clientAborted: false,
        stalledAborted: false,
        error: null,
        done: false,
      }
      records.push(rec)

      const upstreamAbort = new AbortController()
      req.signal.addEventListener("abort", () => {
        if (!rec.done) rec.clientAborted = true
        upstreamAbort.abort()
        finish()
      })

      let lastActivity = Date.now()
      let stallTimer: ReturnType<typeof setInterval> | undefined
      let stallReported = false
      const finish = () => {
        if (rec.done) return
        rec.done = true
        rec.durationMs = Date.now() - rec.startedAt
        if (stallTimer) clearInterval(stallTimer)
        opts.onRecord?.(rec)
      }
      if (opts.idleTimeoutMs && opts.idleTimeoutMs > 0) {
        const idle = opts.idleTimeoutMs
        const firstWait = opts.firstTokenTimeoutMs && opts.firstTokenTimeoutMs > 0 ? opts.firstTokenTimeoutMs : idle
        stallTimer = setInterval(() => {
          if (rec.done || stallReported) return
          // 첫 토큰 전에는 첫 토큰 대기 한도를, 이후에는 청크 간격 한도를 적용한다
          const limit = rec.firstTokenMs === null ? firstWait : idle
          if (Date.now() - lastActivity >= limit) {
            stallReported = true
            opts.onStall?.(rec)
            if (opts.abortOnStall) {
              rec.stalledAborted = true
              upstreamAbort.abort()
              finish()
            }
          }
        }, Math.min(1000, Math.max(50, Math.floor(Math.min(idle, firstWait) / 4))))
      }

      const headers = new Headers()
      req.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v)
      })
      let body: ArrayBuffer | string | undefined = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer()
      const patch = opts.bodyPatch?.[model]
      if (patch && body && /\/chat\/completions$/.test(url.pathname) && (req.headers.get("content-type") ?? "").includes("json")) {
        try {
          body = JSON.stringify(deepMerge(JSON.parse(new TextDecoder().decode(body)), patch))
        } catch {
          // JSON이 아니면 그대로 전달한다
        }
      }

      let upstream: Response
      try {
        upstream = await fetch(upstreamUrl, { method: req.method, headers, body, signal: upstreamAbort.signal })
      } catch (e) {
        rec.error = (e as Error).message
        finish()
        return new Response(JSON.stringify({ error: { message: `상류 연결 실패: ${rec.error}` } }), {
          status: 502,
          headers: { "content-type": "application/json" },
        })
      }
      rec.status = upstream.status
      rec.firstByteMs = Date.now() - rec.startedAt
      lastActivity = Date.now()

      const outHeaders = new Headers()
      upstream.headers.forEach((v, k) => {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== "content-encoding") outHeaders.set(k, v)
      })

      if (!upstream.body) {
        finish()
        return new Response(null, { status: upstream.status, headers: outHeaders })
      }

      const decoder = new TextDecoder()
      let tail = ""
      const reader = upstream.body.getReader()
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              finish()
              controller.close()
              return
            }
            lastActivity = Date.now()
            rec.chunks++
            const text = decoder.decode(value, { stream: true })
            // 내용이 들어 있는 청크가 처음 나온 시점 = 첫 토큰
            if (rec.firstTokenMs === null && /"(content|tool_calls|reasoning_content|reasoning)"\s*:\s*(\[|"[^"])/.test(text)) {
              rec.firstTokenMs = Date.now() - rec.startedAt
            }
            tail = (tail + text).slice(-4000)
            const pt = tail.match(/"prompt_tokens"\s*:\s*(\d+)/g)?.pop()?.match(/(\d+)$/)
            const ct = tail.match(/"completion_tokens"\s*:\s*(\d+)/g)?.pop()?.match(/(\d+)$/)
            if (pt) rec.promptTokens = Number(pt[1])
            if (ct) rec.completionTokens = Number(ct[1])
            controller.enqueue(value)
          } catch (e) {
            if (!rec.clientAborted && !rec.stalledAborted) rec.error = (e as Error).message
            finish()
            try {
              controller.error(e)
            } catch {}
          }
        },
        cancel() {
          if (!rec.done) rec.clientAborted = true
          upstreamAbort.abort()
          finish()
        },
      })
      return new Response(stream, { status: upstream.status, headers: outHeaders })
    },
  })

  return {
    port: server.port!,
    urlFor: (model: string) => `http://127.0.0.1:${server.port}/${model}`,
    records,
    stop: () => server.stop(true),
  }
}
