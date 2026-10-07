import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildArgs, runOpencode } from "../src/runner"
import { ev, fakeConfig } from "./helpers"

const tmp = () => mkdtempSync(join(tmpdir(), "ocx-run-"))

describe("실행 인자", () => {
  test("모델·옵션·구분자·환경변수를 구성한다", () => {
    const { args, env } = buildArgs({
      cfg: fakeConfig(),
      model: "b",
      prompt: "-x 로 시작하는 지시",
      cwd: ".",
      continueSession: true,
      sessionID: "ses_1",
      agent: "plan",
      auto: true,
    })
    expect(args.slice(-2)).toEqual(["--", "-x 로 시작하는 지시"])
    expect(args).toContain("--format")
    expect(args[args.indexOf("-m") + 1]).toBe("b/model-b")
    for (const f of ["--continue", "--auto"]) expect(args).toContain(f)
    expect(args[args.indexOf("-s") + 1]).toBe("ses_1")
    expect(args[args.indexOf("--agent") + 1]).toBe("plan")
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).model).toBe("b/model-b")
  })

  test("작업 폴더를 PWD로 명시한다 (원본이 PWD로 작업 폴더를 정함)", () => {
    const { env } = buildArgs({ cfg: fakeConfig(), prompt: "x", cwd: "/tmp/some-dir" })
    expect(env.PWD).toBe("/tmp/some-dir")
  })

  test("폐쇄망이면 웹 도구를 기본 차단하고, 명시한 권한이 우선한다", () => {
    const conf = (permission?: Record<string, unknown>) =>
      JSON.parse(buildArgs({ cfg: fakeConfig(), prompt: "x", cwd: ".", permission }).env.OPENCODE_CONFIG_CONTENT!)
    expect(conf().permission).toEqual({ webfetch: "deny", websearch: "deny" })
    expect(conf({ webfetch: "allow", bash: "deny" }).permission).toEqual({ webfetch: "allow", websearch: "deny", bash: "deny" })
    const open = JSON.parse(buildArgs({ cfg: fakeConfig({ closedNetwork: false }), prompt: "x", cwd: "." }).env.OPENCODE_CONFIG_CONTENT!)
    expect(open.permission).toBeUndefined()
  })

  test("closedNetwork=false면 차단 변수를 넣지 않는다", () => {
    const { env } = buildArgs({ cfg: fakeConfig({ closedNetwork: false }), prompt: "x", cwd: "." })
    expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBeUndefined()
  })
})

describe("실행과 이벤트 파싱", () => {
  test("이벤트를 파싱하고 텍스트·단계·토큰을 집계한다", async () => {
    const argsFile = join(tmp(), "args.json")
    const plan = [
      { line: "로그 한 줄(JSON 아님)" },
      { line: ev("step_start") },
      { delayMs: 50, line: ev("tool_use", { tool: "bash" }) },
      { line: ev("step_finish", { reason: "tool-calls", tokens: { input: 10, output: 5 } }) },
      { line: ev("text", { text: "안녕" }) },
      { line: ev("step_finish", { reason: "stop", tokens: { input: 20, output: 7 } }) },
    ]
    const seen: string[] = []
    const r = await runOpencode({
      cfg: fakeConfig(),
      prompt: "테스트",
      cwd: tmp(),
      onEvent: (e) => seen.push(e.type),
      extraEnv: { FAKE_PLAN: JSON.stringify(plan), FAKE_ARGS_FILE: argsFile },
    })
    expect(r.endedBy).toBe("exit")
    expect(r.exitCode).toBe(0)
    expect(r.text).toBe("안녕")
    expect(r.toolCalls).toBe(1)
    expect(r.steps).toBe(2)
    expect(r.inputTokens).toBe(30)
    expect(r.outputTokens).toBe(12)
    expect(r.sessionID).toBe("ses_test")
    expect(seen).toEqual(["step_start", "tool_use", "step_finish", "text", "step_finish"])
    expect(r.firstEventMs).not.toBeNull()
    expect(r.firstTextMs! >= r.firstEventMs!).toBe(true)
    const recorded = JSON.parse(readFileSync(argsFile, "utf8"))
    expect(recorded.args.slice(0, 5)).toEqual(["run", "--format", "json", "-m", "a/model-a"])
    expect(recorded.env.OPENCODE_DISABLE_MODELS_FETCH).toBe("1")
  })

  test("stdin을 닫고 실행한다 (stdin을 읽는 프로세스가 영구 대기하지 않음)", async () => {
    // 가짜 opencode 대신 stdin을 EOF까지 읽는 명령을 실행해 EOF가 즉시 전달되는지 본다
    const cfg = fakeConfig({ opencode: { command: ["bun", "-e", 'await Bun.stdin.text(); console.log("{\\"type\\":\\"text\\",\\"part\\":{\\"text\\":\\"ok\\"}}"); process.exit(0)', "--"] } })
    const r = await runOpencode({ cfg, prompt: "x", cwd: tmp(), totalTimeoutMs: 10000 })
    expect(r.endedBy).toBe("exit")
    expect(r.text).toBe("ok")
  })

  test("정체 시간을 넘기면 종료한다", async () => {
    const plan = [{ line: ev("step_start") }, { delayMs: 20000, line: ev("text", { text: "늦음" }) }]
    const r = await runOpencode({
      cfg: fakeConfig(),
      prompt: "x",
      cwd: tmp(),
      stallTimeoutMs: 600,
      extraEnv: { FAKE_PLAN: JSON.stringify(plan) },
    })
    expect(r.endedBy).toBe("stall")
    expect(r.durationMs).toBeLessThan(8000)
    expect(r.text).toBe("")
  })

  test("총 시간 제한을 넘기면 종료한다", async () => {
    const plan = [{ delayMs: 20000, line: ev("text", { text: "늦음" }) }]
    const r = await runOpencode({
      cfg: fakeConfig(),
      prompt: "x",
      cwd: tmp(),
      totalTimeoutMs: 500,
      extraEnv: { FAKE_PLAN: JSON.stringify(plan) },
    })
    expect(r.endedBy).toBe("timeout")
  })

  test("AbortSignal로 중단한다", async () => {
    const ac = new AbortController()
    const plan = [{ delayMs: 20000, line: ev("text", { text: "늦음" }) }]
    setTimeout(() => ac.abort(), 300)
    const r = await runOpencode({ cfg: fakeConfig(), prompt: "x", cwd: tmp(), signal: ac.signal, extraEnv: { FAKE_PLAN: JSON.stringify(plan) } })
    expect(r.endedBy).toBe("aborted")
  })

  test("비정상 종료 코드를 전달한다", async () => {
    const r = await runOpencode({ cfg: fakeConfig(), prompt: "x", cwd: tmp(), extraEnv: { FAKE_EXIT: "3" } })
    expect(r.endedBy).toBe("exit")
    expect(r.exitCode).toBe(3)
  })

  test("실행 파일이 없으면 오류 정보를 남긴다", async () => {
    const r = await runOpencode({ cfg: fakeConfig({ opencode: { command: ["없는-명령-xyz"] } }), prompt: "x", cwd: tmp() })
    expect(r.exitCode).toBeNull()
    expect(r.stderrTail).toContain("spawn 오류")
  })
})
