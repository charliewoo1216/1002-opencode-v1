// `ocx day` 명령: 낮 시간 혼잡 적응 실행
//   ocx day "<지시문>"   감독 실행 (정체·루프·시간 초과를 감지해 자동으로 이어서/새 세션으로 재시도)
//   ocx day --task T2    승인된 계획서의 작업 하나를 감독 실행
//   ocx day              원본 화면(TUI)을 측정 프록시를 거쳐 실행 (정체된 요청은 끊겨 원본이 다시 시도)
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Parsed } from "./args"
import { loadCfg } from "./cli-common"
import { buildBodyPatch, makeAttemptRunner } from "./dayrun"
import { ocxAgents } from "./agents"
import { buildTuiLaunch, reapOrphans, setChildRegistry } from "./runner"
import { layoutFor } from "./paths"
import { checkApproval } from "./plan"
import { ProfileError, loadProfile, type Profile } from "./profile"
import { startMeasureProxy } from "./proxy"
import { percentile } from "./metrics"
import { continuePrompt, supervise, type AttemptRecord } from "./supervise"
import { takeSnapshot } from "./snapshot"
import { loadTask } from "./taskprompt"

const stamp = () => new Date().toLocaleTimeString("ko-KR", { hour12: false })

export async function cmdDay(p: Parsed): Promise<number> {
  const cfg = loadCfg(p.flags)
  const cwd = resolve(String(p.flags.dir ?? "."))
  const layout = layoutFor(cwd)
  const model = String(p.flags.model ?? cfg.defaultModel)
  if (!cfg.models[model]) {
    console.error(`등록되지 않은 모델입니다: "${model}" (등록된 모델: ${Object.keys(cfg.models).join(", ")})`)
    return 2
  }

  let profile: Profile | undefined
  if (p.flags.profile) {
    try {
      profile = loadProfile(String(p.flags.profile), cfg.profilesDir)
    } catch (e) {
      if (e instanceof ProfileError) {
        console.error(e.message)
        return 2
      }
      throw e
    }
  }
  const light = p.flags.light === true
  const instruction = p.positionals.join(" ").trim()
  const stateFile = join(layout.batch, "day-state.json")

  // 작업 목표 결정
  let goal = instruction
  let label = "지시문"
  if (p.flags.task) {
    const approval = checkApproval(layout)
    if (!approval.approved) {
      console.error(`승인된 계획서가 필요합니다: ${approval.reason}\n'ocx plan'으로 계획서를 만들고 승인하세요.`)
      return 2
    }
    try {
      const loaded = loadTask(layout, String(p.flags.task))
      goal = loaded.goal
      label = `작업 ${loaded.task.id}`
    } catch (e) {
      console.error((e as Error).message)
      return 2
    }
  }

  // 재개: 이전에 중단된 감독 실행을 이어서 한다
  let resume: { goal: string; sessionID?: string; attempts: AttemptRecord[] } | undefined
  if (p.flags.resume === true) {
    if (!existsSync(stateFile)) {
      console.error("이어서 할 이전 실행 기록이 없습니다.")
      return 2
    }
    const prev = JSON.parse(readFileSync(stateFile, "utf8"))
    if (prev.status === "done") {
      console.error("이전 실행은 이미 완료되었습니다.")
      return 2
    }
    resume = { goal: prev.goal, sessionID: prev.sessionID, attempts: prev.attempts ?? [] }
    goal = prev.goal
    label = "재개"
  }

  if (!goal) return runInteractive(cfg, { cwd, layout, model, profile, light, continueSession: p.flags.continue === true })

  const registry = join(layout.batch, "children.json")
  const reaped = reapOrphans(registry)
  if (reaped > 0) console.error(`[${stamp()}] 이전 실행이 남긴 프로세스 ${reaped}개를 정리했습니다.`)
  setChildRegistry(registry)

  const runAttempt = makeAttemptRunner({
    cfg,
    layout,
    model,
    cwd,
    profile,
    agent: p.flags.agent ? String(p.flags.agent) : undefined,
    auto: p.flags.auto === true,
    mode: "day",
  })
  console.error(`[${stamp()}] 낮 모드 시작: ${label} (모델 ${model}, 시도당 예산 ${cfg.day.attemptBudgetMinutes}분, 최대 ${cfg.day.maxAttempts}회)`)
  const result = await supervise({
    goal,
    policy: cfg.day,
    runAttempt,
    contextLimit: cfg.models[model]!.contextLimit,
    takeSnapshot: () => takeSnapshot(cwd),
    notify: (m) => console.error(`[${stamp()}] ${m}`),
    stateFile,
    light,
    ...(resume
      ? {
          priorAttempts: resume.attempts,
          initial: {
            n: resume.attempts.length + 1,
            kind: resume.sessionID ? ("continue" as const) : ("fresh" as const),
            sessionID: resume.sessionID,
            prompt: resume.sessionID ? continuePrompt("이전 실행이 중단되어 재개함") : goal,
            light: true,
          },
        }
      : {}),
  })
  if (result.text) console.log(result.text)
  console.error(
    `\n[${stamp()}] ${result.status === "done" ? "완료" : "보류"}: 시도 ${result.attempts.length}회, 바뀐 파일 ${result.changedFiles.length}개` +
      (result.changedFiles.length ? `\n  ${result.changedFiles.slice(0, 20).join("\n  ")}` : "") +
      (result.status === "held" ? `\n이어서 하려면: ocx day --resume` : ""),
  )
  return result.status === "done" ? 0 : 3
}

/** 원본 화면(TUI)을 측정 프록시를 거쳐 실행한다. 알림은 화면을 깨지 않도록 파일에 남긴다 */
async function runInteractive(
  cfg: ReturnType<typeof loadCfg>,
  o: { cwd: string; layout: ReturnType<typeof layoutFor>; model: string; profile?: Profile; light: boolean; continueSession: boolean },
): Promise<number> {
  const policy = cfg.day
  mkdirSync(o.layout.batch, { recursive: true })
  const noticeFile = join(o.layout.batch, "day-notices.log")
  const note = (m: string) => appendFileSync(noticeFile, `[${new Date().toISOString()}] ${m}\n`)
  const proxy = startMeasureProxy({
    upstreams: Object.fromEntries(Object.entries(cfg.models).map(([id, m]) => [id, m.baseURL])),
    idleTimeoutMs: policy.streamIdleSeconds * 1000,
    firstTokenTimeoutMs: policy.firstTokenWaitSeconds * 1000,
    // 정체된 요청을 끊으면 원본이 오류로 보고 스스로 다시 요청한다 (단계 1에서 확인)
    abortOnStall: true,
    bodyPatch: buildBodyPatch(cfg, o.light, policy),
    onStall: (r) => note(`응답 정체로 요청 #${r.id}(${r.model})를 끊었습니다. 원본이 다시 시도합니다.`),
  })
  const launch = buildTuiLaunch(cfg, {
    model: o.model,
    cwd: o.cwd,
    baseURLOverrides: Object.fromEntries(Object.keys(cfg.models).map((id) => [id, proxy.urlFor(id)])),
    agents: ocxAgents(),
    instructions: o.profile?.instructions,
    continueSession: o.continueSession,
  })
  try {
    const code = await new Promise<number>((res) => {
      const child = spawn(launch.command, launch.args, { cwd: o.cwd, env: { ...process.env, ...launch.env }, stdio: "inherit" })
      child.on("close", (c) => res(c ?? 1))
      child.on("error", (e) => {
        console.error(`원본 opencode를 실행할 수 없습니다: ${e.message}`)
        res(127)
      })
    })
    const main = proxy.records.filter((r) => r.model === o.model && r.done)
    const ttft = percentile(main.map((r) => r.firstTokenMs).filter((v): v is number => v !== null), 50)
    console.error(
      `\n[ocx] 낮 모드 세션 종료: 요청 ${proxy.records.length}건, 첫 토큰 중앙값 ${ttft === null ? "-" : `${(ttft / 1000).toFixed(1)}초`}, 정체로 끊은 요청 ${proxy.records.filter((r) => r.stalledAborted).length}건 (알림: ${noticeFile})`,
    )
    return code
  } finally {
    proxy.stop()
  }
}
