// `ocx auto` 명령: 시각, 서버 속도, 사람 유무를 보고 낮/밤 동작을 스스로 고른다
//   ocx auto "<지시문>"        사람이 직접 지시하면 낮 동작(감독 실행), 서버가 느리면 가볍게
//   ocx auto                    승인된 계획서가 있으면 밤/낮을 판단, 없으면 원본 화면 (무인이면 승인된 계획서 필수)
//   ocx auto --status           판단 결과와 근거만 보여 주고 실행하지 않음
//   ocx auto --mode night|day   모드를 직접 지정 (안전 조건은 그대로 확인)
import { resolve } from "node:path"
import type { Parsed } from "./args"
import { autoLogPath, decideMode, judgeSpeed, loadAutoState, recordDecision, windowOf, type AutoMode } from "./auto"
import { cmdDay } from "./cli-day"
import { cmdNight } from "./cli-night"
import { loadCfg } from "./cli-common"
import { readMetrics } from "./metrics"
import { layoutFor } from "./paths"
import { checkApproval } from "./plan"

export interface AutoEnv {
  /** 사람이 화면 앞에 있는지 (생략하면 터미널 여부로 판단) */
  human?: boolean
  now?: Date
}

export async function cmdAuto(p: Parsed, env: AutoEnv = {}): Promise<number> {
  const cfg = loadCfg(p.flags)
  const cwd = resolve(String(p.flags.dir ?? "."))
  const layout = layoutFor(cwd)
  const now = env.now ?? new Date()
  const human = env.human ?? !!(process.stdin.isTTY && process.stdout.isTTY)

  let mode: AutoMode | undefined
  if (p.flags.mode !== undefined) {
    if (p.flags.mode !== "day" && p.flags.mode !== "night") {
      console.error(`--mode는 day 또는 night여야 합니다: "${p.flags.mode}"`)
      return 2
    }
    mode = p.flags.mode
  }

  const approval = checkApproval(layout)
  const previous = loadAutoState(layout)
  const speed = judgeSpeed(readMetrics(layout), now, cfg.auto, previous?.lastLevel ?? null)
  const decision = decideMode(
    {
      now,
      inNightWindow: windowOf(now, cfg.night),
      human,
      speed,
      approvedPlan: approval.approved,
      approvalReason: approval.reason,
      hasInstruction: p.positionals.join(" ").trim().length > 0,
    },
    { mode },
  )

  const label = decision.action === "day" ? `낮(${decision.dayKind === "instruction" ? "지시문 감독 실행" : "원본 화면"}${decision.light ? ", 가볍게" : ""})` : decision.action === "night" ? "밤" : "시작하지 않음"
  console.error(`[auto] 판단: ${label}`)
  for (const r of decision.reasons) console.error(`  - ${r}`)

  if (p.flags.status === true) {
    console.error("(--status: 실행하지 않고 판단만 보여 줍니다)")
    return decision.action === "refuse" ? 1 : 0
  }
  const switched = recordDecision(layout, decision, speed.level, now)
  if (switched) console.error(`[auto] 이전 판단에서 전환: ${switched} (기록: ${autoLogPath(layout)})`)

  switch (decision.action) {
    case "refuse":
      return 2
    case "night":
      return cmdNight(p)
    case "day":
      // 서버가 느리다고 판단되면 가볍게 실행한다 (사용자가 --light를 줬으면 그대로 유지)
      if (decision.light) p.flags.light = true
      return cmdDay(p)
  }
}
