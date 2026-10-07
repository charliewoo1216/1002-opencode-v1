// 에이전트 실행기: 측정 프록시를 거쳐 원본 opencode를 실행하고 속도 기록을 남긴다
// 계획 모드, 낮/밤 모드가 공통으로 사용한다
import { ocxAgents } from "./agents"
import type { OcxConfig } from "./config"
import { appendMetric, metricFromResult, summarizeLlm } from "./metrics"
import type { Layout } from "./paths"
import type { Profile } from "./profile"
import { startMeasureProxy } from "./proxy"
import { runOpencode, type RunResult } from "./runner"

export interface AgentRunnerOptions {
  cfg: OcxConfig
  layout: Layout
  model: string
  /** 작업 폴더 */
  cwd: string
  profile?: Profile
  /** 속도 기록의 mode 값 (plan, day, night 등) */
  mode: string
  /** 측정 프록시 사용 여부 (기본 true) */
  useProxy?: boolean
  stallTimeoutMs?: number
  totalTimeoutMs?: number
  /** 무인 실행용 권한 자동 승인 */
  auto?: boolean
  extraEnv?: Record<string, string>
}

export interface AgentCall {
  agent: string
  prompt: string
  continueSession?: boolean
  label?: string
}

export type AgentRunner = (call: AgentCall) => Promise<RunResult>

export function makeAgentRunner(o: AgentRunnerOptions): AgentRunner {
  return async (call) => {
    const startedAt = new Date()
    const proxy =
      o.useProxy === false
        ? undefined
        : startMeasureProxy({ upstreams: Object.fromEntries(Object.entries(o.cfg.models).map(([id, m]) => [id, m.baseURL])) })
    try {
      const result = await runOpencode({
        cfg: o.cfg,
        model: o.model,
        prompt: call.prompt,
        cwd: o.cwd,
        agent: call.agent,
        continueSession: call.continueSession,
        auto: o.auto,
        agents: ocxAgents(),
        instructions: o.profile?.instructions,
        stallTimeoutMs: o.stallTimeoutMs,
        totalTimeoutMs: o.totalTimeoutMs,
        extraEnv: o.extraEnv,
        baseURLOverrides: proxy ? Object.fromEntries(Object.keys(o.cfg.models).map((id) => [id, proxy.urlFor(id)])) : undefined,
      })
      appendMetric(
        o.layout,
        metricFromResult(result, {
          model: o.model,
          mode: o.mode,
          label: call.label ?? call.agent,
          startedAt,
          llm: proxy ? summarizeLlm(proxy.records, o.model) : undefined,
        }),
      )
      return result
    } finally {
      proxy?.stop()
    }
  }
}
