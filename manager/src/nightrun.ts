// 밤 모드 오케스트레이터: 승인된 계획서의 작업을 순서대로 끝까지 진행한다
//
// 작업 하나의 흐름:
//   백업 -> 구현(감독 실행, 서버 문제는 기다렸다 재시도) -> 범위 확인 -> 검증 명령 -> 완료 기준 점검
//   -> 통과하면 완료, 검증/점검에 실패하면 문제를 알려 고치게 함(최대 N회)
//   -> 끝내 못 하면 변경분을 보관하고 작업 전 상태로 되돌린 뒤 보류하고 다음 작업으로
//
// 종료: 전부 완료 / 종료 시각 도달 / 남은 작업이 모두 보류·건너뜀 / 사용자 중단
import { createHash } from "node:crypto"
import { existsSync, renameSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createBackup, restoreFromBackup, saveChangedFiles, type BackupInfo } from "./backup"
import type { OcxConfig } from "./config"
import type { RunMetric } from "./metrics"
import {
  addEvent, loadNightState, newTaskState, nightStatePath, prepareResume, saveNightState,
  type EndReason, type NightState, type TaskState,
} from "./nightstate"
import type { Layout } from "./paths"
import { orderTasks, type PlanTask, type PlanValidation } from "./plan"
import { writeReport } from "./report"
import type { RunResult } from "./runner"
import { inWindow } from "./schedule"
import { outOfScope } from "./scope"
import { pickReady } from "./taskorder"
import { parseSelfCheck, selfCheckPrompt } from "./selfcheck"
import { changedPaths, diffSnapshots, takeSnapshot } from "./snapshot"
import type { SuperviseResult } from "./supervise"
import { taskGoal } from "./taskprompt"
import { runVerify, type VerifyResult } from "./verify"

export interface NightRunDeps {
  cfg: OcxConfig
  layout: Layout
  cwd: string
  intentMd: string
  tasksMd: string
  tasks: PlanTask[]
  reviewNeeded: PlanValidation["reviewNeeded"]
  /** 이 시각이 되면 안전하게 멈춘다 */
  deadline: Date
  now: () => Date
  sleep: (ms: number) => Promise<void>
  /** 작업 하나를 구현하는 감독 실행 (낮 모드 감독자를 밤 정책으로 사용) */
  runSupervised: (goal: string, ctx: { task: PlanTask; deadline: Date }) => Promise<SuperviseResult>
  /** 완료 기준 점검 에이전트 실행 */
  runCheck: (prompt: string, ctx: { task: PlanTask }) => Promise<RunResult>
  verify?: typeof runVerify
  /** 검증 명령 실행 전 검사 (안전 규칙) */
  guard?: (command: string) => string | null
  notify?: (message: string) => void
  /** 이전 실행에서 보류·건너뜀이 된 작업도 다시 시도 */
  retryHeld?: boolean
  /** true가 되면 현재 작업을 마친 뒤 멈춘다 (사용자 중단) */
  stop?: { requested: boolean }
  title?: string
  readMetrics?: () => RunMetric[]
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex")

export function fixSection(feedback: string): string {
  return `

[이전 시도의 문제]
${feedback.trim()}

위 문제를 고치세요. 작업 폴더에는 이전 시도의 변경이 남아 있습니다. 먼저 현재 상태를 확인하고, 이미 맞게 된 부분은 그대로 두세요. 끝내기 전에 검증 명령을 다시 실행해 통과를 확인하세요.`
}

const RESUME_NOTE = `

[참고] 이전 시도가 서버 응답 문제로 중단되었습니다. 작업 폴더의 현재 상태를 먼저 확인하고, 아직 되지 않은 부분만 이어서 진행하세요.`

export async function runNight(d: NightRunDeps): Promise<NightState> {
  const { layout, cfg } = d
  const night = cfg.night
  const planHash = sha(`${d.intentMd}\n---\n${d.tasksMd}`)
  const ordered = orderTasks(d.tasks)
  const reviewBy = new Map<string, string[]>()
  for (const r of d.reviewNeeded) reviewBy.set(r.taskId, [...(reviewBy.get(r.taskId) ?? []), r.reason])

  // ---- 상태 불러오기 / 새로 시작 ----
  let state = loadNightState(layout)
  if (state && state.planHash === planHash) {
    const notes = prepareResume(state, { retryHeld: !!d.retryHeld })
    state.status = "running"
    state.endReason = undefined
    state.finishedAt = undefined
    state.deadline = d.deadline.toISOString()
    addEvent(state, "이전 실행 상태를 이어받아 재개합니다", d.now())
    for (const n of notes) addEvent(state, n, d.now())
  } else {
    if (state) {
      // 계획서가 바뀌었으면 이어받을 수 없다: 이전 기록은 보관하고 새로 시작
      renameSync(nightStatePath(layout), join(layout.batch, `night-state.${d.now().toISOString().replace(/[:.]/g, "-")}.bak.json`))
    }
    state = {
      version: 1,
      planHash,
      startedAt: d.now().toISOString(),
      deadline: d.deadline.toISOString(),
      status: "running",
      order: ordered.map((t) => t.id),
      tasks: Object.fromEntries(ordered.map((t) => [t.id, newTaskState(t.id, t.title, reviewBy.get(t.id) ?? [])])),
      events: [],
    }
    addEvent(state, `밤 모드 시작: 작업 ${ordered.length}개, 종료 예정 ${d.deadline.toLocaleString("ko-KR", { hour12: false })}`, d.now())
  }
  const S = state
  const say = (message: string) => {
    addEvent(S, message, d.now())
    d.notify?.(message)
  }
  const persist = () => {
    saveNightState(layout, S)
    writeReport(layout, S, { metrics: d.readMetrics?.(), title: d.title, now: d.now() })
  }
  persist()

  const finish = (reason: EndReason) => {
    S.status = "finished"
    S.endReason = reason
    S.finishedAt = d.now().toISOString()
    persist()
  }
  const past = (t: Date) => d.now().getTime() >= t.getTime()

  // ---- 작업 하나 실행 ----
  async function executeTask(task: PlanTask) {
    const ts: TaskState = S.tasks[task.id]!
    ts.status = "running"
    ts.startedAt ??= d.now().toISOString()
    const startedMs = d.now().getTime()
    const taskDeadline = new Date(Math.min(d.deadline.getTime(), startedMs + night.taskBudgetMinutes * 60_000))
    say(`${task.id} 시작: ${task.title}`)
    persist()

    const backupDir = join(layout.batch, "backup", "current")
    const backup: BackupInfo = createBackup(d.cwd, backupDir, { maxBytes: night.backupMaxMB * 1024 * 1024, priority: task.files })
    if (backup.partial) {
      ts.restoreWarnings.push(`작업 폴더가 백업 용량 상한(${night.backupMaxMB}MB)을 넘어 계획서의 대상 파일만 백업했습니다. 그 밖의 파일은 보류 시 되돌릴 수 없습니다.`)
      say(`${task.id}: 백업 용량 초과로 일부만 백업했습니다`)
    }

    const baseGoal = taskGoal(d.intentMd, task)
    const verifyRun = d.verify ?? runVerify
    let feedback = ""

    const hold = async (reason: string, lastError?: string) => {
      const diff = diffSnapshots(backup.snapshot, takeSnapshot(d.cwd))
      const heldDir = join(layout.batch, "held", task.id)
      if (changedPaths(diff).length > 0) {
        saveChangedFiles(d.cwd, diff, heldDir)
        ts.heldDir = heldDir
        const r = restoreFromBackup(d.cwd, backup)
        if (r.unrestorable.length) ts.restoreWarnings.push(`백업이 없어 되돌리지 못한 파일: ${r.unrestorable.join(", ")}`)
        if (r.failed.length) ts.restoreWarnings.push(`되돌리기에 실패한 파일: ${r.failed.join(", ")}`)
      }
      ts.changedFiles = []
      ts.status = "held"
      ts.reason = reason
      if (lastError) ts.lastError = lastError
      ts.finishedAt = d.now().toISOString()
      ts.durationMs += d.now().getTime() - startedMs
      say(`${task.id} 보류: ${reason}`)
    }

    try {
      for (let round = 0; ; round++) {
        const stopReason = (): string | null =>
          past(d.deadline) ? "종료 시각에 도달해 중단함" : d.stop?.requested ? "사용자 중단 요청" : past(taskDeadline) ? `작업 시간 예산(${night.taskBudgetMinutes}분)을 넘김` : null
        let why = stopReason()
        if (why) return await hold(why, feedback || undefined)

        // 1) 구현 (서버 문제로 보류되면 기다렸다가 같은 작업을 다시 시도한다)
        let prompt = round === 0 ? baseGoal : baseGoal + fixSection(feedback)
        let sv: SuperviseResult
        let implementationFailed = false
        for (let wait = 0; ; wait++) {
          sv = await d.runSupervised(prompt, { task, deadline: taskDeadline })
          ts.attempts += sv.attempts.length
          if (sv.status === "done") break
          if (sv.attempts.some((a) => a.endedBy === "loop")) {
            // 모델이 같은 동작을 반복한 경우: 기다려도 소용없으므로 실패로 보고 문제를 알려 다시 시도한다
            feedback = "같은 도구 호출 또는 같은 오류를 반복하다가 중단되었습니다. 다른 방법을 시도하세요."
            ts.lastError = sv.notices.slice(-3).join("\n")
            implementationFailed = true
            break
          }
          why = stopReason()
          if (why) return await hold(why, sv.notices.slice(-3).join("\n"))
          // 서버가 느리거나 응답하지 않는 경우: 간격을 늘리며 기다렸다가 다시 시도
          const delay = Math.min(night.patienceInitialSeconds * 1000 * 2 ** wait, night.patienceMaxSeconds * 1000)
          const remaining = taskDeadline.getTime() - d.now().getTime()
          if (remaining <= delay) return await hold("서버 응답 문제로 작업 시간 안에 끝내지 못함", sv.notices.slice(-3).join("\n"))
          ts.waitedMs += delay
          say(`${task.id}: 서버 응답 문제로 ${Math.round(delay / 1000)}초 뒤 다시 시도합니다 (${wait + 1}번째 대기)`)
          persist()
          await d.sleep(delay)
          prompt = baseGoal + RESUME_NOTE + (feedback ? fixSection(feedback) : "")
        }

        // 2) 범위 확인
        let changed = changedPaths(diffSnapshots(backup.snapshot, takeSnapshot(d.cwd)))
        const oos = outOfScope(changed, task.files)
        if (oos.length) {
          if (night.scope === "strict") {
            restoreFromBackup(d.cwd, backup, (p) => oos.includes(p))
            say(`${task.id}: 계획서 범위 밖 변경 ${oos.length}개를 되돌렸습니다`)
            changed = changedPaths(diffSnapshots(backup.snapshot, takeSnapshot(d.cwd)))
          } else {
            say(`${task.id}: 계획서 범위 밖 변경 ${oos.length}개가 있습니다 (리포트에 표시)`)
          }
          ts.outOfScope = [...new Set([...ts.outOfScope, ...oos])]
        }
        ts.changedFiles = changed

        if (implementationFailed) {
          ts.fixRounds++
          if (round >= night.maxFixRounds) return await hold("구현이 반복 실패함(같은 동작 반복)", ts.lastError)
          continue
        }

        // 3) 검증 명령
        if (task.verify.length === 0) {
          ts.verification = "none"
        } else {
          const remaining = taskDeadline.getTime() - d.now().getTime()
          const v: VerifyResult = await verifyRun(task.verify, {
            cwd: d.cwd,
            timeoutMs: Math.max(1000, Math.min(night.verifyTimeoutMinutes * 60_000, remaining)),
            guard: d.guard,
          })
          ts.verifyRuns.push({ at: d.now().toISOString(), ok: v.ok, summary: v.ok ? `통과 (${v.results.length}개 명령)` : v.failureSummary.slice(0, 600) })
          if (!v.ok) {
            ts.verification = "failed"
            ts.lastError = v.failureSummary
            feedback = v.failureSummary
            ts.fixRounds++
            say(`${task.id}: 검증 실패 (수정 ${ts.fixRounds}/${night.maxFixRounds})`)
            if (round >= night.maxFixRounds) return await hold(`검증 실패(수정 ${night.maxFixRounds}회 시도 후에도 통과하지 못함)`, v.failureSummary)
            persist()
            continue
          }
          ts.verification = "passed"
        }

        // 4) 완료 기준 점검
        if (night.selfCheck && task.criteria.length > 0) {
          const res = await d.runCheck(selfCheckPrompt(task, changed), { task })
          const verdict = res.endedBy === "exit" && res.exitCode === 0 ? parseSelfCheck(res.text) : ({ kind: "unclear", note: "점검 실행이 정상 종료되지 않았습니다" } as const)
          if (verdict.kind === "fail") {
            ts.selfCheck = "fail"
            ts.selfCheckNote = verdict.reason
            feedback = `완료 기준 점검에서 미흡 판정을 받았습니다: ${verdict.reason}`
            ts.fixRounds++
            say(`${task.id}: 완료 기준 점검 미흡 — ${verdict.reason}`)
            if (round >= night.maxFixRounds) return await hold(`완료 기준 점검 미흡: ${verdict.reason}`, feedback)
            persist()
            continue
          }
          ts.selfCheck = verdict.kind === "pass" ? "pass" : "unclear"
          ts.selfCheckNote = verdict.kind === "unclear" ? verdict.note : undefined
        } else {
          ts.selfCheck = "off"
        }

        // 5) 완료 (백업은 더 필요 없으므로 지운다)
        rmSync(backupDir, { recursive: true, force: true })
        ts.status = "done"
        ts.reason = undefined
        ts.finishedAt = d.now().toISOString()
        ts.durationMs += d.now().getTime() - startedMs
        say(`${task.id} 완료${ts.verification === "none" ? " (검증 명령 없음: 사람 확인 필요)" : ""}`)
        return
      }
    } catch (e) {
      // 예기치 못한 오류가 나도 밤새 멈추지 않도록 이 작업만 보류하고 계속한다
      await hold(`예기치 못한 오류: ${(e as Error).message}`, (e as Error).stack?.split("\n").slice(0, 6).join("\n"))
    }
  }

  // ---- 메인 루프 ----
  for (;;) {
    if (d.stop?.requested) return (finish("aborted"), S)
    if (past(d.deadline)) return (finish("deadline"), S)

    // 의존 작업이 보류·건너뜀이면 이 작업도 건너뜀
    for (const t of ordered) {
      const ts = S.tasks[t.id]!
      if (ts.status !== "pending") continue
      const bad = t.dependsOn.find((x) => ["held", "skipped"].includes(S.tasks[x]?.status ?? ""))
      if (bad) {
        ts.status = "skipped"
        ts.reason = `의존하는 작업 ${bad}이(가) ${S.tasks[bad]!.status === "held" ? "보류" : "건너뜀"} 상태입니다`
        say(`${t.id} 건너뜀: ${ts.reason}`)
        persist()
      }
    }

    const ready = ordered.filter((t) => S.tasks[t.id]!.status === "pending" && t.dependsOn.every((x) => S.tasks[x]?.status === "done"))
    const fw = night.fastWindow
    const next = pickReady(ready, { enabled: fw.enabled, inFastWindow: fw.enabled && inWindow(d.now(), fw.start, fw.end) })
    if (!next) {
      const all = ordered.every((t) => S.tasks[t.id]!.status === "done")
      return (finish(all ? "all-done" : "all-held"), S)
    }
    await executeTask(next)
    persist()
  }
}

/** 이전 실행의 상태 파일이 있는지 (CLI에서 안내용) */
export const hasPreviousRun = (layout: Layout) => existsSync(nightStatePath(layout))
