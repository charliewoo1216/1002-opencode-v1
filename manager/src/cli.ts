#!/usr/bin/env bun
// ocx: OpenCode 확장 관리 프로그램 진입점
// 명령: plan / day / night / auto / report / stats / run / profiles / config / guide / help. 그 밖의 명령은 원본 opencode로 그대로 전달
import { spawn } from "node:child_process"
import { resolve } from "node:path"
import { parseArgs, type Parsed } from "./args"
import { cmdAuto } from "./cli-auto"
import { cmdConfig } from "./cli-config"
import { cmdDay } from "./cli-day"
import { cmdNight, cmdReport } from "./cli-night"
import { cmdPlan, cmdProfiles } from "./cli-plan"
import { configPath, loadCfg } from "./cli-common"
import { ConfigError, loadConfig, type OcxConfig } from "./config"
import { renderCommandHelp, renderGuide, renderOverview } from "./help"
import pkg from "../package.json"
import { appendMetric, formatSummary, metricFromResult, readMetrics, summarizeByHour, summarizeLlm } from "./metrics"
import { layoutFor } from "./paths"
import { startMeasureProxy } from "./proxy"
import { runOpencode } from "./runner"

export { parseArgs }
async function cmdRun(p: Parsed): Promise<number> {
  const cfg = loadCfg(p.flags)
  const prompt = p.positionals.join(" ").trim()
  if (!prompt) {
    console.error('실행할 지시문이 없습니다. 예: ocx run "README를 요약해줘"')
    return 2
  }
  const cwd = resolve(String(p.flags.dir ?? "."))
  const model = String(p.flags.model ?? cfg.defaultModel)
  const startedAt = new Date()
  // 측정 프록시를 거쳐 접속해 토큰 단위 속도를 기록한다 (--no-proxy 로 끌 수 있음)
  const useProxy = p.flags["no-proxy"] !== true
  const proxy = useProxy
    ? startMeasureProxy({ upstreams: Object.fromEntries(Object.entries(cfg.models).map(([id, m]) => [id, m.baseURL])) })
    : undefined
  let result
  try {
    result = await runOpencode({
      cfg,
      model,
      prompt,
      cwd,
      continueSession: p.flags.continue === true,
      auto: p.flags.auto === true,
      stallTimeoutMs: p.flags["stall-timeout"] ? Number(p.flags["stall-timeout"]) * 1000 : undefined,
      totalTimeoutMs: p.flags.timeout ? Number(p.flags.timeout) * 1000 : undefined,
      baseURLOverrides: proxy ? Object.fromEntries(Object.keys(cfg.models).map((id) => [id, proxy.urlFor(id)])) : undefined,
    })
  } finally {
    proxy?.stop()
  }
  appendMetric(
    layoutFor(cwd),
    metricFromResult(result, {
      model,
      mode: String(p.flags.mode ?? "run"),
      startedAt,
      llm: proxy ? summarizeLlm(proxy.records, model) : undefined,
    }),
  )
  if (result.text) console.log(result.text)
  if (result.endedBy !== "exit") console.error(`실행이 중단되었습니다: ${result.endedBy}`)
  if (result.exitCode !== 0 && result.stderrTail) console.error(result.stderrTail)
  return result.endedBy === "exit" ? (result.exitCode ?? 1) : 3
}

function cmdStats(p: Parsed): number {
  const cwd = resolve(String(p.flags.dir ?? "."))
  const metrics = readMetrics(layoutFor(cwd))
  const rows = summarizeByHour(metrics, p.flags.model ? String(p.flags.model) : undefined)
  console.log(formatSummary(rows))
  return 0
}

/** ocx가 모르는 명령은 원본 opencode로 그대로 전달한다 */
function passthrough(argv: string[]): Promise<number> {
  let cfg: OcxConfig | undefined
  try {
    cfg = loadConfig(configPath({}))
  } catch {
    cfg = undefined
  }
  const [cmd, ...base] = cfg?.opencode.command ?? ["opencode"]
  return new Promise((res) => {
    const child = spawn(cmd!, [...base, ...argv], { stdio: "inherit" })
    child.on("close", (code) => res(code ?? 1))
    child.on("error", (e) => {
      console.error(`원본 opencode를 실행할 수 없습니다: ${e.message}`)
      res(127)
    })
  })
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv)
  } catch (e) {
    // 설정 오류는 스택 트레이스 대신 한글 안내만 보여 준다
    if (e instanceof ConfigError) {
      console.error(`설정 오류: ${e.message}`)
      return 2
    }
    throw e
  }
}

type Handler = (p: Parsed) => Promise<number> | number

/** 버전과 실행 환경 정보. 문제가 생겼을 때 어떤 파일이 어떤 환경에서 돌고 있는지 확인하는 용도 */
export function versionText(): string {
  let opencode = "(설정 파일 없음)"
  try {
    opencode = loadConfig(configPath({})).opencode.command.join(" ")
  } catch (e) {
    opencode = e instanceof Error ? `(설정을 읽지 못함: ${e.message.split("\n")[0]})` : "(알 수 없음)"
  }
  return [
    `ocx ${pkg.version}`,
    `실행 파일: ${process.execPath}`,
    `환경: ${process.platform} ${process.arch}, Bun ${Bun.version}`,
    `원본 opencode 실행 명령: ${opencode}`,
  ].join("\n")
}

/** ocx가 직접 처리하는 명령. 여기에 없는 명령은 원본 opencode로 그대로 전달한다 */
const HANDLERS: Record<string, Handler> = {
  run: cmdRun,
  stats: cmdStats,
  plan: cmdPlan,
  day: cmdDay,
  night: cmdNight,
  auto: cmdAuto,
  report: cmdReport,
  profiles: cmdProfiles,
  config: cmdConfig,
  guide: (p) => (console.log(renderGuide(p.positionals[0])), 0),
  version: () => (console.log(versionText()), 0),
  help: (p) => {
    const target = p.positionals[0]
    if (target) {
      const text = renderCommandHelp(target)
      if (text) return (console.log(text), 0)
      console.error(`알 수 없는 명령입니다: "${target}"\n`)
      console.log(renderOverview())
      return 2
    }
    console.log(renderOverview())
    return 0
  },
}
export const COMMAND_NAMES = Object.keys(HANDLERS)

async function dispatch(argv: string[]): Promise<number> {
  const p = parseArgs(argv)
  // ocx --version : 버전과 실행 환경 (원본 opencode 의 --version 이 아님)
  if (p.command === undefined && p.flags.version === true) {
    console.log(versionText())
    return 0
  }
  // 인자가 없거나 --help 만 있으면 개요 도움말
  if (p.command === undefined) {
    if (argv.length === 0 || p.flags.help) {
      console.log(renderOverview())
      return 0
    }
    return passthrough(argv)
  }
  const handler = HANDLERS[p.command]
  if (!handler) return passthrough(argv)
  // ocx 명령의 --help 는 명령별 상세 도움말 (원본 명령의 --help 는 원본이 처리)
  if (p.flags.help === true && p.command !== "help") {
    const text = renderCommandHelp(p.command)
    if (text) return (console.log(text), 0)
  }
  return handler(p)
}
