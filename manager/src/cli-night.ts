// `ocx night` / `ocx report` 명령: 야간 무인 완주
//   ocx night                   승인된 계획서의 작업을 야간 창(기본 19:00)부터 종료 시각(기본 07:00)까지 진행
//   ocx night --now             야간 창을 기다리지 않고 지금 시작
//   ocx night --until 06:30     종료 시각 지정 / --hours 3 : 지금부터 3시간
//   ocx night --retry-held      이전 실행에서 보류된 작업도 다시 시도
//   ocx night --dry-run         실행하지 않고 일정과 작업 순서만 확인
//   ocx report                  마지막 실행의 리포트 보기
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import type { Parsed } from "./args"
import { AGENT_CHECK } from "./agents"
import { loadCfg } from "./cli-common"
import { nightSupervisePolicy } from "./config"
import { makeAttemptRunner } from "./dayrun"
import { makeAgentRunner } from "./exec"
import { readMetrics } from "./metrics"
import { loadNightState, nightStatePath } from "./nightstate"
import { runNight } from "./nightrun"
import { layoutFor } from "./paths"
import { checkApproval, intentPath, orderTasks, parseTaskPlan, tasksPath, validateTaskPlan } from "./plan"
import { ProfileError, loadProfile, type Profile } from "./profile"
import { reportPath, writeReport } from "./report"
import { killAllChildren, reapOrphans, setChildRegistry } from "./runner"
import { guardCommand } from "./safety"
import { TimeError, deadlineFor, formatClock, inWindow, msUntilWindowOpens, nextOccurrence, parseClock } from "./schedule"
import { takeSnapshot } from "./snapshot"
import { supervise } from "./supervise"

const stamp = () => new Date().toLocaleTimeString("ko-KR", { hour12: false })

/** 중단 요청을 확인하면서 기다린다 (1초 단위로 깨어나 확인) */
async function sleepUnlessStopped(ms: number, stop: { requested: boolean }) {
  const end = Date.now() + ms
  while (Date.now() < end && !stop.requested) await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(1, end - Date.now()))))
}

export function cmdReport(p: Parsed): number {
  const layout = layoutFor(resolve(String(p.flags.dir ?? ".")))
  const state = loadNightState(layout)
  if (!state) {
    console.error("밤 모드 실행 기록이 없습니다. 먼저 'ocx night'를 실행하세요.")
    return 1
  }
  writeReport(layout, state, { metrics: readMetrics(layout) })
  console.log(readFileSync(reportPath(layout), "utf8"))
  console.error(`\n(리포트 파일: ${reportPath(layout)})`)
  return 0
}

export async function cmdNight(p: Parsed): Promise<number> {
  const cfg = loadCfg(p.flags)
  const cwd = resolve(String(p.flags.dir ?? "."))
  const layout = layoutFor(cwd)
  const model = String(p.flags.model ?? cfg.defaultModel)
  if (!cfg.models[model]) {
    console.error(`등록되지 않은 모델입니다: "${model}" (등록된 모델: ${Object.keys(cfg.models).join(", ")})`)
    return 2
  }

  // 승인된 계획서가 없으면 시작하지 않는다 (무인 실행의 안전장치)
  const approval = checkApproval(layout)
  if (!approval.approved) {
    console.error(`승인된 계획서가 필요합니다: ${approval.reason}\n'ocx plan'으로 계획서를 만들고 승인하세요.`)
    return 2
  }
  const intentMd = readFileSync(intentPath(layout), "utf8")
  const tasksMd = readFileSync(tasksPath(layout), "utf8")
  const parsed = parseTaskPlan(tasksMd)
  const validation = validateTaskPlan(parsed)
  if (!validation.ok) {
    console.error(`작업 계획서에 오류가 있습니다:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`)
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

  // ---- 일정 계산 ----
  const night = cfg.night
  let start = new Date()
  let deadline: Date
  try {
    const waitMs = p.flags.now === true ? 0 : msUntilWindowOpens(start, night.windowStart, night.endTime)
    const base = new Date(start.getTime() + waitMs)
    if (p.flags.hours) {
      const h = Number(p.flags.hours)
      if (!(h > 0)) throw new TimeError(`--hours는 0보다 큰 숫자여야 합니다: "${p.flags.hours}"`)
      deadline = new Date(base.getTime() + h * 3600_000)
    } else if (p.flags.until) {
      parseClock(String(p.flags.until))
      deadline = nextOccurrence(base, String(p.flags.until))
    } else {
      deadline = deadlineFor(base, night.endTime)
    }
    start = base
  } catch (e) {
    if (e instanceof TimeError) {
      console.error(e.message)
      return 2
    }
    throw e
  }
  const order = orderTasks(parsed.tasks)
  const prev = loadNightState(layout)

  console.error(`[${stamp()}] 밤 모드 준비: 작업 ${order.length}개, 모델 ${model}`)
  console.error(`  시작 예정 ${formatClock(start)}  /  종료 예정 ${formatClock(deadline)}`)
  console.error(`  작업 순서: ${order.map((t) => t.id).join(" -> ")}`)
  if (validation.reviewNeeded.length) console.error(`  사람 확인 필요 표시: ${validation.reviewNeeded.map((r) => `${r.taskId}(${r.reason})`).join("; ")}`)
  if (prev && existsSync(nightStatePath(layout))) console.error(`  이전 실행 기록이 있습니다 (계획서가 같으면 이어서 진행합니다${p.flags["retry-held"] ? ", 보류 작업도 다시 시도" : ""})`)
  if (p.flags["dry-run"] === true) {
    console.error("(--dry-run: 실행하지 않고 종료합니다)")
    return 0
  }

  // 이전 실행이 비정상 종료되며 남긴 프로세스가 있으면 정리하고, 이번 실행의 자식 프로세스도 기록해 둔다
  const registry = `${layout.batch}/children.json`
  const reaped = reapOrphans(registry)
  if (reaped > 0) console.error(`[${stamp()}] 이전 실행이 남긴 프로세스 ${reaped}개를 정리했습니다.`)
  setChildRegistry(registry)

  // ---- 중단 처리: 첫 Ctrl-C는 현재 작업을 마친 뒤 멈춤, 두 번째는 즉시 종료 ----
  const stop = { requested: false }
  const onSignal = () => {
    if (stop.requested) {
      console.error(`\n[${stamp()}] 즉시 종료합니다. 진행 중이던 작업은 다음 실행 때 처음부터 다시 합니다.`)
      killAllChildren()
      process.exit(130)
    }
    stop.requested = true
    console.error(`\n[${stamp()}] 중단 요청: 현재 작업을 마친 뒤 멈춥니다 (한 번 더 누르면 즉시 종료).`)
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
  process.on("exit", killAllChildren)

  // ---- 야간 창 대기 ----
  const waitMs = start.getTime() - Date.now()
  if (waitMs > 1000) {
    console.error(`[${stamp()}] 야간 창(${night.windowStart})까지 ${Math.round(waitMs / 60000)}분 기다립니다. 지금 시작하려면 --now`)
    await sleepUnlessStopped(waitMs, stop)
    if (stop.requested) return 130
  } else if (p.flags.now !== true && !inWindow(new Date(), night.windowStart, night.endTime)) {
    console.error(`[${stamp()}] 야간 창 밖이지만 바로 시작합니다.`)
  }

  const notify = (m: string) => console.error(`[${stamp()}] ${m}`)
  const policy = nightSupervisePolicy(night)
  const runCheckAgent = makeAgentRunner({
    cfg,
    layout,
    model,
    cwd,
    profile,
    mode: "night",
    totalTimeoutMs: night.attemptBudgetMinutes * 60_000,
  })

  const state = await runNight({
    cfg,
    layout,
    cwd,
    intentMd,
    tasksMd,
    tasks: parsed.tasks,
    reviewNeeded: validation.reviewNeeded,
    deadline,
    now: () => new Date(),
    sleep: (ms) => sleepUnlessStopped(ms, stop),
    retryHeld: p.flags["retry-held"] === true,
    stop,
    title: undefined,
    notify,
    guard: (c) => guardCommand(c, { extraBlocked: cfg.safety.extraBlocked }),
    readMetrics: () => readMetrics(layout),
    runSupervised: (goal, ctx) =>
      supervise({
        goal,
        policy,
        contextLimit: cfg.models[model]!.contextLimit,
        takeSnapshot: () => takeSnapshot(cwd),
        notify: (m) => notify(`${ctx.task.id}: ${m}`),
        stateFile: `${layout.batch}/night-attempt-${ctx.task.id}.json`,
        stopWhen: () => (Date.now() >= ctx.deadline.getTime() ? "종료 시각 또는 작업 시간 예산에 도달함" : stop.requested ? "사용자 중단 요청" : null),
        runAttempt: makeAttemptRunner({
          cfg,
          layout,
          model,
          cwd,
          profile,
          auto: p.flags.auto === true,
          policy,
          mode: "night",
          deadline: ctx.deadline,
        }),
      }),
    runCheck: (prompt) => runCheckAgent({ agent: AGENT_CHECK, prompt, label: "night:check" }),
  })

  const done = Object.values(state.tasks).filter((t) => t.status === "done").length
  const held = Object.values(state.tasks).filter((t) => t.status === "held").length
  const skipped = Object.values(state.tasks).filter((t) => t.status === "skipped").length
  const pending = Object.values(state.tasks).filter((t) => t.status === "pending").length
  console.error(`\n[${stamp()}] 밤 모드 종료 (${state.endReason}): 완료 ${done}, 보류 ${held}, 건너뜀 ${skipped}, 미실행 ${pending}`)
  console.error(`리포트: ${reportPath(layout)}  (다시 보기: ocx report)`)
  return state.endReason === "all-done" ? 0 : state.endReason === "aborted" ? 130 : 3
}
