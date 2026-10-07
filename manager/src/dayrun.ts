// 낮 모드 실행: 감독자(supervise)가 시도를 요청하면 실제 opencode를 한 번 실행한다
// 한 번의 시도 = 측정 프록시 + 루프 감지 + 시간 예산 + 정체 감지를 묶은 실행
import { ocxAgents } from "./agents"
import { DAY_DEFAULTS, type DayConfig, type OcxConfig } from "./config"
import { LoopDetector } from "./loopdetect"
import { appendMetric, metricFromResult, summarizeLlm } from "./metrics"
import type { Layout } from "./paths"
import type { Profile } from "./profile"
import { deepMerge, startMeasureProxy } from "./proxy"
import { safetyPermission } from "./safety"
import { runOpencode, type OpencodeEvent } from "./runner"
import type { AbortReason, AttemptOutcome, AttemptRunner } from "./supervise"

export interface DayRunOptions {
  cfg: OcxConfig
  layout: Layout
  model: string
  cwd: string
  profile?: Profile
  /** 원본 에이전트 이름 (생략하면 원본 기본 에이전트) */
  agent?: string
  /** 무인 실행용 권한 자동 승인 */
  auto?: boolean
  policy?: DayConfig
  /** 속도 기록의 mode 값 */
  mode?: string
  extraEnv?: Record<string, string>
  /** 이 시각이 되면 시도를 중단한다 (밤 모드의 종료 시각). 시간 예산보다 우선한다 */
  deadline?: Date
}

/** 모델별 요청 본문 패치: 항상 적용(extraBody) + 가볍게 실행 시 추가(lightBody) */
export function buildBodyPatch(cfg: OcxConfig, light: boolean, policy: DayConfig): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, m] of Object.entries(cfg.models)) {
    const patch = deepMerge(m.extraBody ?? {}, light ? policy.lightBody : {}) as Record<string, unknown>
    if (Object.keys(patch).length > 0) out[id] = patch
  }
  return out
}

/** 실패한 시도의 마지막 상태를 다음 시도에 넘길 짧은 문장으로 정리한다 */
export function buildTail(events: OpencodeEvent[], text: string): string {
  const lines: string[] = []
  const tools = events.filter((e) => e.type === "tool_use").slice(-3)
  for (const e of tools) {
    const st = (e.part?.state ?? {}) as Record<string, any>
    const input = JSON.stringify(st.input ?? {}).slice(0, 160)
    const out = String(st.output ?? st.error ?? "").replace(/\s+/g, " ").slice(0, 160)
    lines.push(`- 도구 ${String(e.part?.tool)} ${input} -> ${st.status ?? "?"}${out ? `: ${out}` : ""}`)
  }
  if (text.trim()) lines.push(`- 마지막 응답: ${text.trim().replace(/\s+/g, " ").slice(0, 300)}`)
  return lines.join("\n")
}

export function makeAttemptRunner(o: DayRunOptions): AttemptRunner {
  const policy = o.policy ?? o.cfg.day ?? DAY_DEFAULTS
  return async (spec): Promise<AttemptOutcome> => {
    const ac = new AbortController()
    let abortedBy: AbortReason | null = null
    let detail: string | undefined
    const abort = (why: AbortReason, msg: string) => {
      if (abortedBy) return
      abortedBy = why
      detail = msg
      ac.abort()
    }
    const detector = new LoopDetector(policy.loopThreshold)
    const startedAt = new Date()

    const proxy = startMeasureProxy({
      upstreams: Object.fromEntries(Object.entries(o.cfg.models).map(([id, m]) => [id, m.baseURL])),
      idleTimeoutMs: policy.streamIdleSeconds * 1000,
      firstTokenTimeoutMs: policy.firstTokenWaitSeconds * 1000,
      bodyPatch: buildBodyPatch(o.cfg, spec.light, policy),
      onStall: (rec) =>
        abort(
          "stall",
          rec.firstTokenMs === null
            ? `첫 토큰을 ${policy.firstTokenWaitSeconds}초 넘게 기다림`
            : `응답이 ${policy.streamIdleSeconds}초 넘게 멈춤`,
        ),
    })
    const budgetMs = policy.attemptBudgetMinutes * 60_000
    const untilDeadline = o.deadline ? o.deadline.getTime() - Date.now() : Infinity
    const budget = setTimeout(
      () => abort("budget", untilDeadline < budgetMs ? "종료 시각에 도달함" : `한 번의 시도 시간 예산(${policy.attemptBudgetMinutes}분)을 넘김`),
      Math.max(1, Math.min(budgetMs, untilDeadline)),
    )
    try {
      const result = await runOpencode({
        cfg: o.cfg,
        model: o.model,
        prompt: spec.prompt,
        cwd: o.cwd,
        agent: o.agent,
        auto: o.auto,
        permission: safetyPermission({ extraBlocked: o.cfg.safety.extraBlocked }),
        sessionID: spec.kind === "continue" ? spec.sessionID : undefined,
        agents: ocxAgents(),
        instructions: o.profile?.instructions,
        extraEnv: o.extraEnv,
        signal: ac.signal,
        onEvent: (ev) => {
          const loop = detector.feed(ev)
          if (loop) abort("loop", loop)
        },
        baseURLOverrides: Object.fromEntries(Object.keys(o.cfg.models).map((id) => [id, proxy.urlFor(id)])),
      })
      appendMetric(
        o.layout,
        metricFromResult(result, {
          model: o.model,
          mode: o.mode ?? "day",
          label: `attempt-${spec.n}${spec.light ? "-light" : ""}`,
          startedAt,
          llm: summarizeLlm(proxy.records, o.model),
        }),
      )
      const prompts = proxy.records.filter((r) => r.model === o.model).map((r) => r.promptTokens ?? 0)
      return {
        result,
        abortedBy,
        abortDetail: detail,
        maxPromptTokens: prompts.length ? Math.max(...prompts) || null : null,
        tail: buildTail(result.events, result.text),
      }
    } finally {
      clearTimeout(budget)
      proxy.stop()
    }
  }
}
