import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NIGHT_DEFAULTS, type NightConfig } from "../src/config"
import { loadNightState, nightStatePath } from "../src/nightstate"
import { layoutFor } from "../src/paths"
import { parseTaskPlan, validateTaskPlan } from "../src/plan"
import { reportPath } from "../src/report"
import type { RunResult } from "../src/runner"
import type { SuperviseResult } from "../src/supervise"
import { runNight, type NightRunDeps } from "../src/nightrun"
import { fakeConfig } from "./helpers"

const INTENT = "# 의도\n## 목적\n로그인 개선\n## 범위\n- 검증\n## 비목표\n- UI 변경\n## 전체 완료 기준\n- 통과\n## 열린 질문\n없음\n"
const task = (id: string, o: { dep?: string; verify?: string; criteria?: string; files?: string } = {}) => `
## 작업 ${id}: 작업 ${id}
- 유형: 구현
- 설명: ${id} 작업을 한다
- 대상 파일: ${o.files ?? `\`src/${id}.txt\``}
- 의존: ${o.dep ?? "없음"}
${o.verify === "" ? "" : `- 검증 명령: \`${o.verify ?? `grep -q ok src/${id}.txt`}\`\n`}- 완료 기준:
${o.criteria === "" ? "" : `  - ${o.criteria ?? "파일에 ok가 있다"}\n`}`

const sv = (status: "done" | "held", over: Partial<SuperviseResult> = {}): SuperviseResult => ({
  status, attempts: [{ n: 1, kind: "fresh", light: false, endedBy: status === "done" ? "exit" : "stall", reason: null, durationMs: 1, promptTokens: null, changedFiles: [], sessionID: "s" }],
  text: "", notices: ["알림"], changedFiles: [], ...over,
})
const checkRes = (text: string): RunResult => ({
  exitCode: 0, endedBy: "exit", events: [], text, durationMs: 1, firstEventMs: 1, firstTextMs: 1,
  toolCalls: 0, steps: 1, inputTokens: 0, outputTokens: 0, stderrTail: "",
})

function setup(tasksMd: string, opts: { night?: Partial<NightConfig>; start?: Date; deadlineHours?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-nr-"))
  mkdirSync(join(root, "src"), { recursive: true })
  const layout = layoutFor(root)
  let t = opts.start ?? new Date(2026, 9, 7, 23, 0, 0)
  const sleeps: number[] = []
  const parsed = parseTaskPlan(tasksMd)
  const validation = validateTaskPlan(parsed)
  expect(validation.errors).toEqual([])
  const prompts: string[] = []
  const deps: NightRunDeps = {
    cfg: fakeConfig({ night: { ...NIGHT_DEFAULTS, patienceInitialSeconds: 30, patienceMaxSeconds: 240, ...opts.night } }),
    layout,
    cwd: root,
    intentMd: INTENT,
    tasksMd,
    tasks: parsed.tasks,
    reviewNeeded: validation.reviewNeeded,
    deadline: new Date(t.getTime() + (opts.deadlineHours ?? 8) * 3600_000),
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms)
      t = new Date(t.getTime() + ms)
    },
    // 기본 구현: 작업 대상 파일에 ok를 쓴다
    runSupervised: async (goal, ctx) => {
      prompts.push(goal)
      writeFileSync(join(root, "src", `${ctx.task.id}.txt`), "ok")
      t = new Date(t.getTime() + 60_000)
      return sv("done")
    },
    runCheck: async () => checkRes("모두 확인했습니다.\n점검결과: 통과"),
    title: "테스트 계획",
  }
  return { root, layout, deps, sleeps, prompts, advance: (ms: number) => void (t = new Date(t.getTime() + ms)) }
}

describe("밤 모드: 정상 흐름", () => {
  test("모든 작업을 순서대로 완료하고 리포트와 상태를 남긴다", async () => {
    const md = `# 계획${task("T1")}${task("T2", { dep: "T1" })}`
    const { layout, deps, prompts, root } = setup(md)
    const s = await runNight(deps)
    expect(s.status).toBe("finished")
    expect(s.endReason).toBe("all-done")
    expect(Object.values(s.tasks).map((t) => [t.id, t.status, t.verification, t.selfCheck])).toEqual([
      ["T1", "done", "passed", "pass"],
      ["T2", "done", "passed", "pass"],
    ])
    expect(prompts.length).toBe(2)
    expect(prompts[0]).toContain("[비목표]") // 작업마다 의도가 다시 주입된다
    expect(prompts[0]).toContain("UI 변경")
    expect(s.tasks.T1!.changedFiles).toEqual(["src/T1.txt"])
    expect(loadNightState(layout)!.status).toBe("finished")
    const report = readFileSync(reportPath(layout), "utf8")
    expect(report).toContain("완료 2")
    expect(report).toContain("모든 작업 완료")
    expect(existsSync(join(root, ".batch/backup/current"))).toBe(false) // 완료하면 백업 삭제
  })
})

describe("밤 모드: 검증과 수정", () => {
  test("검증이 실패하면 문제를 알려 주고 고치게 한 뒤 통과하면 완료한다", async () => {
    const { deps, prompts, root } = setup(`# 계획${task("T1")}`)
    let calls = 0
    deps.runSupervised = async (goal, ctx) => {
      prompts.push(goal)
      writeFileSync(join(root, "src/T1.txt"), ++calls === 1 ? "bad" : "ok")
      return sv("done")
    }
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("done")
    expect(s.tasks.T1!.fixRounds).toBe(1)
    expect(s.tasks.T1!.verifyRuns.map((r) => r.ok)).toEqual([false, true])
    expect(prompts[1]).toContain("[이전 시도의 문제]")
    expect(prompts[1]).toContain("grep -q ok src/T1.txt")
  })

  test("끝내 통과하지 못하면 변경분을 보관하고 되돌린 뒤 보류하고, 의존 작업은 건너뛰고, 독립 작업은 계속한다", async () => {
    const md = `# 계획${task("T1")}${task("T2", { dep: "T1" })}${task("T3")}`
    const { layout, deps, root } = setup(md, { night: { maxFixRounds: 2 } })
    writeFileSync(join(root, "src/T1.txt"), "원래 내용")
    deps.runSupervised = async (goal, ctx) => {
      writeFileSync(join(root, "src", `${ctx.task.id}.txt`), ctx.task.id === "T1" ? "bad" : "ok")
      writeFileSync(join(root, "src/extra.txt"), "새 파일")
      return sv("done")
    }
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("held")
    expect(s.tasks.T1!.reason).toContain("검증 실패")
    expect(s.tasks.T1!.fixRounds).toBe(3)
    expect(s.tasks.T2!.status).toBe("skipped")
    expect(s.tasks.T2!.reason).toContain("T1")
    expect(s.tasks.T3!.status).toBe("done")
    expect(s.endReason).toBe("all-held")
    // 작업 전 상태로 복원: 수정된 파일은 원래 내용, 새로 생긴 파일은 제거(단, T3 작업의 결과는 남음)
    expect(readFileSync(join(root, "src/T1.txt"), "utf8")).toBe("원래 내용")
    // 보류 직전 변경분은 보관된다
    expect(readFileSync(join(root, ".batch/held/T1/files/src/T1.txt"), "utf8")).toBe("bad")
    expect(readFileSync(join(root, ".batch/held/T1/files/src/extra.txt"), "utf8")).toBe("새 파일")
    const report = readFileSync(reportPath(layout), "utf8")
    expect(report).toContain("보류·건너뜀 작업")
    expect(report).toContain("보류 직전 변경분 보관 위치")
  })

  test("검증 명령이 없는 작업은 완료하되 사람 확인 필요로 표시한다", async () => {
    const { layout, deps } = setup(`# 계획${task("T1", { verify: "" })}`)
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("done")
    expect(s.tasks.T1!.verification).toBe("none")
    expect(readFileSync(reportPath(layout), "utf8")).toContain("직접 확인이 필요합니다")
  })

  test("완료 기준 점검이 미흡이면 다시 고치게 하고, 불명확하면 완료하되 표시한다", async () => {
    const { deps, prompts } = setup(`# 계획${task("T1")}`)
    const answers = ["확인했습니다.\n점검결과: 미흡 - 두 번째 기준이 빠짐", "점검결과: 통과"]
    deps.runCheck = async () => checkRes(answers.shift()!)
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("done")
    expect(s.tasks.T1!.fixRounds).toBe(1)
    expect(prompts[1]).toContain("두 번째 기준이 빠짐")

    const u = setup(`# 계획${task("T1")}`)
    u.deps.runCheck = async () => checkRes("잘 모르겠습니다")
    const s2 = await runNight(u.deps)
    expect(s2.tasks.T1!.status).toBe("done")
    expect(s2.tasks.T1!.selfCheck).toBe("unclear")
  })

  test("점검을 끄거나 완료 기준이 없으면 점검하지 않는다", async () => {
    const a = setup(`# 계획${task("T1")}`, { night: { selfCheck: false } })
    let called = 0
    a.deps.runCheck = async () => (called++, checkRes("점검결과: 통과"))
    expect((await runNight(a.deps)).tasks.T1!.selfCheck).toBe("off")
    const b = setup(`# 계획${task("T1", { criteria: "" })}`)
    b.deps.runCheck = async () => (called++, checkRes("점검결과: 통과"))
    expect((await runNight(b.deps)).tasks.T1!.selfCheck).toBe("off")
    expect(called).toBe(0)
  })
})

describe("밤 모드: 서버 문제와 시간", () => {
  test("서버 응답 문제로 보류되면 간격을 늘려 가며 기다렸다가 다시 시도한다", async () => {
    const { deps, sleeps, prompts, root } = setup(`# 계획${task("T1")}`)
    let n = 0
    deps.runSupervised = async (goal) => {
      prompts.push(goal)
      if (++n <= 3) return sv("held")
      writeFileSync(join(root, "src/T1.txt"), "ok")
      return sv("done")
    }
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("done")
    expect(sleeps).toEqual([30_000, 60_000, 120_000]) // 두 배씩 증가
    expect(s.tasks.T1!.waitedMs).toBe(210_000)
    expect(prompts[1]).toContain("서버 응답 문제로 중단")
    expect(s.events.some((e) => e.message.includes("서버 응답 문제로 30초 뒤"))).toBe(true)
  })

  test("대기 간격은 상한을 넘지 않는다", async () => {
    const { deps, sleeps, root } = setup(`# 계획${task("T1")}`)
    let n = 0
    deps.runSupervised = async () => {
      if (++n <= 6) return sv("held")
      writeFileSync(join(root, "src/T1.txt"), "ok")
      return sv("done")
    }
    await runNight(deps)
    expect(sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 240_000, 240_000])
  })

  test("서버 문제가 길어져 작업 시간 예산을 넘기면 보류한다", async () => {
    const { deps } = setup(`# 계획${task("T1")}`, { night: { taskBudgetMinutes: 5 } })
    deps.runSupervised = async () => sv("held")
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("held")
    expect(s.tasks.T1!.reason).toContain("서버 응답 문제")
  })

  test("모델이 같은 동작을 반복(루프)하면 기다리지 않고 고치게 하며, 계속되면 보류한다", async () => {
    const { deps, sleeps } = setup(`# 계획${task("T1")}`, { night: { maxFixRounds: 1 } })
    deps.runSupervised = async () => sv("held", { attempts: [{ n: 1, kind: "fresh", light: false, endedBy: "loop", reason: "루프", durationMs: 1, promptTokens: null, changedFiles: [] }] })
    const s = await runNight(deps)
    expect(sleeps).toEqual([])
    expect(s.tasks.T1!.status).toBe("held")
    expect(s.tasks.T1!.reason).toContain("반복")
  })

  test("종료 시각이 되면 남은 작업을 실행하지 않고 끝낸다", async () => {
    const md = `# 계획${task("T1")}${task("T2")}${task("T3")}`
    const { deps } = setup(md, { deadlineHours: 1 })
    let n = 0
    const base = deps.runSupervised
    deps.runSupervised = async (g, c) => {
      const r = await base(g, c)
      n++
      deps.now() // 첫 작업이 55분 걸린 것으로 처리
      return r
    }
    const start = deps.now()
    let t = start.getTime()
    deps.now = () => new Date(t)
    deps.runSupervised = async (g, c) => {
      writeFileSync(join(deps.cwd, "src", `${c.task.id}.txt`), "ok")
      t += 35 * 60_000
      return sv("done")
    }
    const s = await runNight(deps)
    expect(s.endReason).toBe("deadline")
    expect(Object.values(s.tasks).map((x) => x.status)).toEqual(["done", "done", "pending"]) // 70분 > 60분
  })

  test("작업 도중 종료 시각이 되면 보류하고 작업 전 상태로 되돌린다", async () => {
    const { deps, root } = setup(`# 계획${task("T1")}`, { deadlineHours: 1 })
    let t = deps.now().getTime()
    deps.now = () => new Date(t)
    deps.runSupervised = async (g, c) => {
      writeFileSync(join(root, "src/T1.txt"), "bad")
      t += 2 * 3600_000 // 종료 시각을 넘김
      return sv("held")
    }
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("held")
    expect(s.tasks.T1!.reason).toContain("종료 시각")
    expect(existsSync(join(root, "src/T1.txt"))).toBe(false)
  })

  test("사용자 중단 요청이 있으면 현재 작업을 마치고 멈춘다", async () => {
    const md = `# 계획${task("T1")}${task("T2")}`
    const { deps } = setup(md)
    const stop = { requested: false }
    deps.stop = stop
    const base = deps.runSupervised
    deps.runSupervised = async (g, c) => {
      const r = await base(g, c)
      stop.requested = true
      return r
    }
    const s = await runNight(deps)
    expect(s.endReason).toBe("aborted")
    expect(s.tasks.T1!.status).toBe("done")
    expect(s.tasks.T2!.status).toBe("pending")
  })
})

describe("밤 모드: 범위와 예외", () => {
  const writer = (root: string) => async (g: string, c: { task: { id: string } }) => {
    writeFileSync(join(root, "src", `${c.task.id}.txt`), "ok")
    writeFileSync(join(root, "elsewhere.txt"), "범위 밖")
    return sv("done")
  }

  test("범위 밖 변경은 경고만 하고 리포트에 표시한다 (warn)", async () => {
    const { layout, deps, root } = setup(`# 계획${task("T1")}`)
    deps.runSupervised = writer(root)
    const s = await runNight(deps)
    expect(s.tasks.T1!.outOfScope).toEqual(["elsewhere.txt"])
    expect(existsSync(join(root, "elsewhere.txt"))).toBe(true)
    expect(readFileSync(reportPath(layout), "utf8")).toContain("계획서 범위를 벗어난 변경")
  })

  test("strict면 범위 밖 변경을 되돌린다", async () => {
    const { deps, root } = setup(`# 계획${task("T1")}`, { night: { scope: "strict" } })
    deps.runSupervised = writer(root)
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("done")
    expect(s.tasks.T1!.outOfScope).toEqual(["elsewhere.txt"])
    expect(existsSync(join(root, "elsewhere.txt"))).toBe(false)
    expect(existsSync(join(root, "src/T1.txt"))).toBe(true)
  })

  test("같은 폴더의 새 파일은 범위 안으로 본다", async () => {
    const { deps, root } = setup(`# 계획${task("T1")}`)
    deps.runSupervised = async (g, c) => {
      writeFileSync(join(root, "src/T1.txt"), "ok")
      writeFileSync(join(root, "src/helper.txt"), "도우미")
      return sv("done")
    }
    expect((await runNight(deps)).tasks.T1!.outOfScope).toEqual([])
  })

  test("예기치 못한 오류가 나도 그 작업만 보류하고 다음 작업을 계속한다", async () => {
    const md = `# 계획${task("T1")}${task("T2")}`
    const { deps, root } = setup(md)
    deps.runSupervised = async (g, c) => {
      if (c.task.id === "T1") throw new Error("뜻밖의 오류")
      writeFileSync(join(root, "src/T2.txt"), "ok")
      return sv("done")
    }
    const s = await runNight(deps)
    expect(s.tasks.T1!.status).toBe("held")
    expect(s.tasks.T1!.reason).toContain("뜻밖의 오류")
    expect(s.tasks.T2!.status).toBe("done")
  })
})

describe("밤 모드: 이어받기", () => {
  test("중단된 실행을 이어받아 완료된 작업은 다시 하지 않는다", async () => {
    const md = `# 계획${task("T1")}${task("T2")}`
    const first = setup(md)
    let crashed = false
    first.deps.runSupervised = async (g, c) => {
      if (c.task.id === "T2") {
        crashed = true
        throw new Error("simulated")
      }
      writeFileSync(join(first.root, "src/T1.txt"), "ok")
      return sv("done")
    }
    // 두 번째 작업에서 비정상 종료한 것처럼 상태를 만든다: T1 완료, T2 실행 중으로 남김
    await runNight(first.deps)
    expect(crashed).toBe(true)
    const st = loadNightState(first.layout)!
    st.tasks.T2!.status = "running"
    st.status = "running"
    st.endReason = undefined
    const { saveNightState } = await import("../src/nightstate")
    saveNightState(first.layout, st)

    const calls: string[] = []
    first.deps.runSupervised = async (g, c) => {
      calls.push(c.task.id)
      writeFileSync(join(first.root, "src", `${c.task.id}.txt`), "ok")
      return sv("done")
    }
    const s = await runNight(first.deps)
    expect(calls).toEqual(["T2"]) // T1은 다시 하지 않음
    expect(s.tasks.T1!.status).toBe("done")
    expect(s.tasks.T2!.status).toBe("done")
    expect(s.events.some((e) => e.message.includes("이어받아 재개"))).toBe(true)
  })

  test("--retry-held면 보류된 작업을 다시 시도한다", async () => {
    const md = `# 계획${task("T1")}`
    const a = setup(md, { night: { maxFixRounds: 0 } })
    a.deps.runSupervised = async () => sv("done") // 파일을 안 만들어 검증 실패
    expect((await runNight(a.deps)).tasks.T1!.status).toBe("held")
    a.deps.runSupervised = async (g, c) => (writeFileSync(join(a.root, "src/T1.txt"), "ok"), sv("done"))
    const stay = await runNight(a.deps)
    expect(stay.tasks.T1!.status).toBe("held") // 기본은 다시 시도하지 않음
    a.deps.retryHeld = true
    const retried = await runNight(a.deps)
    expect(retried.tasks.T1!.status).toBe("done")
  })

  test("계획서가 바뀌었으면 이전 상태를 보관하고 새로 시작한다", async () => {
    const a = setup(`# 계획${task("T1")}`)
    await runNight(a.deps)
    a.deps.tasksMd = `# 계획${task("T1")}${task("T2")}`
    a.deps.tasks = parseTaskPlan(a.deps.tasksMd).tasks
    const s = await runNight(a.deps)
    expect(Object.keys(s.tasks)).toEqual(["T1", "T2"])
    expect(readdirSync(a.layout.batch).some((f) => f.startsWith("night-state.") && f.endsWith(".bak.json"))).toBe(true)
    expect(existsSync(nightStatePath(a.layout))).toBe(true)
  })
})

describe("밤 모드: 빠른 시간대 활용 옵션", () => {
  const md = `# 계획
## 작업 L1: 가벼운 작업
- 유형: 구현
- 설명: 작다
- 대상 파일: \`src/L1.txt\`
- 검증 명령: \`grep -q ok src/L1.txt\`
- 완료 기준:
  - ok
## 작업 H1: 무거운 작업
- 유형: MCP
- 설명: 크다
- 대상 파일: \`src/H1.txt\`, \`src/x.txt\`, \`src/y.txt\`
- 검증 명령: \`grep -q ok src/H1.txt\`, \`true\`
- 완료 기준:
  - a
  - b
  - c
## 작업 L2: 또 가벼운 작업
- 유형: 구현
- 설명: 작다
- 대상 파일: \`src/L2.txt\`
- 검증 명령: \`grep -q ok src/L2.txt\`
- 완료 기준:
  - ok
`
  const run = async (fastWindow: { enabled: boolean; start: string; end: string }, start: Date) => {
    const s = setup(md, { night: { fastWindow }, start })
    const order: string[] = []
    s.deps.runSupervised = async (g, c) => {
      order.push(c.task.id)
      writeFileSync(join(s.root, "src", `${c.task.id}.txt`), "ok")
      return sv("done")
    }
    await runNight(s.deps)
    return order
  }

  test("꺼져 있으면 계획서 순서대로 진행한다", async () => {
    expect(await run({ enabled: false, start: "01:00", end: "07:00" }, new Date(2026, 9, 8, 2, 0))).toEqual(["L1", "H1", "L2"])
  })

  test("빠른 시간대 안에서는 무거운 작업부터 한다", async () => {
    expect(await run({ enabled: true, start: "01:00", end: "07:00" }, new Date(2026, 9, 8, 2, 0))).toEqual(["H1", "L1", "L2"])
  })

  test("빠른 시간대 밖에서는 가벼운 작업부터 한다", async () => {
    expect(await run({ enabled: true, start: "01:00", end: "07:00" }, new Date(2026, 9, 7, 21, 0))).toEqual(["L1", "L2", "H1"])
  })
})
