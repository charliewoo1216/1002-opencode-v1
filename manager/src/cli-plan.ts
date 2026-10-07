// `ocx plan`, `ocx profiles` 명령
import { createInterface } from "node:readline/promises"
import { resolve } from "node:path"
import type { Parsed } from "./args"
import { configPath, loadCfg } from "./cli-common"
import { makeAgentRunner } from "./exec"
import { createLogger } from "./logger"
import { layoutFor } from "./paths"
import { approvePlan, checkApproval, intentPath, tasksPath } from "./plan"
import { runPlanFlow } from "./planflow"
import { ProfileError, listProfiles, loadProfile } from "./profile"

/** 터미널에서 질문하고 답을 받는다. 터미널이 아니면(파이프 등) 질문하지 않는다 */
function makePrompter() {
  if (!process.stdin.isTTY) {
    return { ask: async () => null as string | null, confirm: async () => false, close: () => {} }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    ask: async (q: string) => (await rl.question(`\n[질문] ${q}\n> `)) as string | null,
    confirm: async (m: string) => /^(y|yes|예|네|ㅇ)$/i.test((await rl.question(`\n${m} (y/N) `)).trim()),
    close: () => rl.close(),
  }
}

export function cmdProfiles(p: Parsed): number {
  let cfgDir: string | undefined
  try {
    cfgDir = loadCfg(p.flags).profilesDir
  } catch {
    cfgDir = undefined
  }
  const names = listProfiles(cfgDir)
  if (names.length === 0) {
    console.log("사용할 수 있는 프로필이 없습니다.")
    return 0
  }
  for (const n of names) {
    const prof = loadProfile(n, cfgDir)
    console.log(`${n.padEnd(10)} ${prof.description}`)
  }
  return 0
}

export async function cmdPlan(p: Parsed): Promise<number> {
  const cwd = resolve(String(p.flags.dir ?? "."))
  const layout = layoutFor(cwd)

  // 이미 만들어진 계획서의 상태 확인 / 직접 고친 뒤 승인
  if (p.flags.status === true) {
    const s = checkApproval(layout)
    console.log(s.approved ? "승인됨: 계획서가 승인 이후 변경되지 않았습니다." : `승인되지 않음: ${s.reason}`)
    console.log(`의도 계획서: ${intentPath(layout)}\n작업 계획서: ${tasksPath(layout)}`)
    return s.approved ? 0 : 1
  }
  if (p.flags.approve === true) {
    const r = approvePlan(layout)
    if (!r.ok) {
      console.error(`승인할 수 없습니다:\n${r.reasons.map((x) => `  - ${x}`).join("\n")}`)
      return 1
    }
    console.log("승인되었습니다.")
    return 0
  }

  const cfg = loadCfg(p.flags)
  const instruction = p.positionals.join(" ").trim()
  if (!instruction) {
    console.error('지시문이 없습니다. 예: ocx plan --profile python "로그인 입력 검증을 개선해줘"')
    return 2
  }
  const profileName = p.flags.profile ? String(p.flags.profile) : undefined
  if (!profileName) {
    console.error(`--profile 이 필요합니다. 사용 가능: ${listProfiles(cfg.profilesDir).join(", ")} (자세히: ocx profiles)`)
    return 2
  }
  let profile
  try {
    profile = loadProfile(profileName, cfg.profilesDir)
  } catch (e) {
    if (e instanceof ProfileError) {
      console.error(e.message)
      return 2
    }
    throw e
  }
  const model = String(p.flags.model ?? cfg.defaultModel)
  const log = createLogger("info")
  const prompter = makePrompter()
  try {
    const runAgent = makeAgentRunner({
      cfg,
      layout,
      model,
      cwd,
      profile,
      mode: "plan",
      stallTimeoutMs: p.flags["stall-timeout"] ? Number(p.flags["stall-timeout"]) * 1000 : undefined,
      totalTimeoutMs: p.flags.timeout ? Number(p.flags.timeout) * 1000 : 30 * 60 * 1000,
    })
    const r = await runPlanFlow({
      cfg,
      layout,
      model,
      profile,
      instruction,
      runAgent,
      ask: prompter.ask,
      confirm: prompter.confirm,
      log,
      skipAnalysis: p.flags["no-analyze"] === true,
      autoApprove: p.flags.yes === true,
    })
    console.log(`\n${r.message}`)
    if (r.analysis) {
      console.log(`참조 분석: 새로 ${r.analysis.analyzed.length}개, 건너뜀 ${r.analysis.skipped.length}개, 실패 ${r.analysis.failed.length}개`)
    }
    console.log(`계획서 위치: ${intentPath(layout)}, ${tasksPath(layout)} (설정: ${configPath(p.flags)})`)
    return r.stage === "approved" ? 0 : r.stage === "failed" ? 1 : 3
  } finally {
    prompter.close()
  }
}
