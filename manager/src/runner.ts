// 원본 `opencode run` 실행 래퍼
// - stdin을 반드시 닫고 실행한다 (닫지 않으면 run이 EOF까지 stdin을 읽으며 영구 대기함: 단계 0 실측)
// - `--format json` 이벤트 스트림을 줄 단위로 파싱한다
// - 정체/총 시간 초과 시 프로세스 트리를 종료한다
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { buildOpencodeConfig, closedNetworkEnv, opencodeModelRef, type OcxConfig } from "./config"
import { safetyPermission } from "./safety"

export interface OpencodeEvent {
  type: string
  timestamp?: number
  sessionID?: string
  part?: Record<string, any>
}

export interface RunOptions {
  cfg: OcxConfig
  /** ocx.config의 모델 이름 (생략하면 defaultModel) */
  model?: string
  prompt: string
  cwd: string
  continueSession?: boolean
  sessionID?: string
  agent?: string
  /** 무인 실행용: 권한 요청을 자동 승인 (거부 규칙이 없는 항목만). 안전 규칙 모듈과 함께 사용할 것 */
  auto?: boolean
  extraEnv?: Record<string, string>
  /** 모델 이름 -> baseURL 덮어쓰기 (측정 프록시 연결용) */
  baseURLOverrides?: Record<string, string>
  /** 이 실행에만 주입할 원본 설정 (에이전트, 지침 파일, 권한) */
  agents?: Record<string, unknown>
  instructions?: string[]
  permission?: Record<string, unknown>
  onEvent?: (e: OpencodeEvent) => void
  /** 마지막 출력(이벤트) 이후 이 시간(ms) 동안 출력이 없으면 정체로 보고 종료. 0/생략이면 사용 안 함 */
  stallTimeoutMs?: number
  /** 실행 전체 제한 시간(ms). 0/생략이면 사용 안 함 */
  totalTimeoutMs?: number
  signal?: AbortSignal
}

export type EndedBy = "exit" | "stall" | "timeout" | "aborted"

export interface RunResult {
  exitCode: number | null
  endedBy: EndedBy
  sessionID?: string
  events: OpencodeEvent[]
  /** text 이벤트를 이어붙인 최종 응답 */
  text: string
  durationMs: number
  /** 시작 후 첫 이벤트까지 걸린 시간 */
  firstEventMs: number | null
  /** 시작 후 첫 text 이벤트까지 걸린 시간 */
  firstTextMs: number | null
  toolCalls: number
  steps: number
  inputTokens: number
  outputTokens: number
  stderrTail: string
}

/** 실행 인자 구성 (테스트 가능하도록 분리) */
export function buildArgs(opts: RunOptions): { command: string; args: string[]; env: Record<string, string> } {
  const { cfg } = opts
  const selected = opts.model ?? cfg.defaultModel
  const [command, ...base] = cfg.opencode.command as [string, ...string[]]
  const args = [...base, "run", "--format", "json", "-m", opencodeModelRef(cfg, selected)]
  if (opts.continueSession) args.push("--continue")
  if (opts.sessionID) args.push("-s", opts.sessionID)
  if (opts.agent) args.push("--agent", opts.agent)
  if (opts.auto) args.push("--auto")
  // 프롬프트가 '-'로 시작해도 옵션으로 해석되지 않도록 구분자를 둔다
  args.push("--", opts.prompt)

  // 폐쇄망에서는 웹 검색·웹 가져오기 도구가 쓸모없고 위험하므로 기본으로 막는다 (명시한 권한이 우선)
  const permission = { ...(cfg.closedNetwork ? { webfetch: "deny", websearch: "deny" } : {}), ...opts.permission }
  const env: Record<string, string> = {
    // 원본은 작업 폴더를 process.env.PWD 로 정한다(run.ts). 부모의 PWD가 상속되면
    // 엉뚱한 폴더에 파일이 만들어지므로 반드시 대상 폴더로 지정한다.
    PWD: resolve(opts.cwd),
    ...(cfg.closedNetwork ? closedNetworkEnv() : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(buildOpencodeConfig(cfg, selected, {
        baseURLOverrides: opts.baseURLOverrides,
        agents: opts.agents,
        instructions: opts.instructions,
        permission: Object.keys(permission).length ? permission : undefined,
      })),
    ...opts.extraEnv,
  }
  return { command, args, env }
}

/** 대화형(TUI) 실행 구성: `run` 없이 원본 화면을 띄운다. 설정은 환경변수로 주입한다 */
export function buildTuiLaunch(
  cfg: OcxConfig,
  o: { model?: string; cwd: string; baseURLOverrides?: Record<string, string>; agents?: Record<string, unknown>; instructions?: string[]; continueSession?: boolean },
): { command: string; args: string[]; env: Record<string, string> } {
  const selected = o.model ?? cfg.defaultModel
  const [command, ...base] = cfg.opencode.command as [string, ...string[]]
  const args = [...base, "-m", opencodeModelRef(cfg, selected)]
  if (o.continueSession) args.push("--continue")
  // 화면 실행에도 안전 규칙(Git 금지 등)을 항상 적용한다
  const permission = safetyPermission({ interactive: true, extraBlocked: cfg.safety.extraBlocked })
  const env: Record<string, string> = {
    PWD: resolve(o.cwd),
    ...(cfg.closedNetwork ? closedNetworkEnv() : {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(
      buildOpencodeConfig(cfg, selected, { baseURLOverrides: o.baseURLOverrides, agents: o.agents, instructions: o.instructions, permission }),
    ),
  }
  return { command, args, env }
}

/**
 * 실행 중인 자식 프로세스 목록.
 * - 관리 프로그램이 정상 종료될 때(Ctrl-C 등) 함께 정리하기 위해 메모리에 보관
 * - kill -9, 전원 차단처럼 정상 종료가 불가능한 경우를 위해 등록부 파일에도 기록해 두었다가,
 *   다음 실행 시작 때 아직 살아 있는 고아 프로세스를 정리한다 (reapOrphans)
 */
interface ChildEntry {
  pid: number
  command: string
  cmdline: string
}
const activeChildren = new Map<number, ChildEntry>()
let registryFile: string | null = null

export function setChildRegistry(file: string | null) {
  registryFile = file
}

function writeRegistry() {
  if (!registryFile) return
  try {
    mkdirSync(dirname(registryFile), { recursive: true })
    writeFileSync(registryFile, JSON.stringify([...activeChildren.values()]))
  } catch {
    // 기록 실패는 실행을 막지 않는다
  }
}

export function trackChild(pid: number | undefined, command = "", args: string[] = []) {
  if (!pid) return
  activeChildren.set(pid, { pid, command, cmdline: [command, ...args].join(" ").slice(0, 300) })
  writeRegistry()
}
export function untrackChild(pid: number | undefined) {
  if (pid && activeChildren.delete(pid)) writeRegistry()
}

/** 아직 살아 있는 자식 프로세스 트리를 모두 종료한다 (Ctrl-C, 종료 시 호출) */
export function killAllChildren() {
  for (const pid of [...activeChildren.keys()]) {
    killTree(pid)
    activeChildren.delete(pid)
  }
  writeRegistry()
}

/** pid가 같은 프로그램인지 확인한다 (pid 재사용으로 엉뚱한 프로세스를 죽이지 않기 위함) */
function sameProcess(e: ChildEntry): boolean {
  try {
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${e.pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
      const image = (e.command.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase().replace(/\.exe$/, "")
      return !!image && r.stdout.toLowerCase().includes(image)
    }
    const r = spawnSync("ps", ["-o", "command=", "-p", String(e.pid)], { encoding: "utf8" })
    const live = r.stdout.trim()
    if (!live) return false
    const head = e.cmdline.split(" ").slice(0, 3).join(" ")
    return live.startsWith(head)
  } catch {
    return false
  }
}

/** 이전 실행이 비정상 종료되며 남긴 자식 프로세스를 정리한다. 정리한 개수를 돌려준다 */
export function reapOrphans(file: string): number {
  if (!existsSync(file)) return 0
  let entries: ChildEntry[] = []
  try {
    entries = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    entries = []
  }
  let killed = 0
  for (const e of entries) {
    if (activeChildren.has(e.pid)) continue
    if (sameProcess(e)) {
      killTree(e.pid)
      killed++
    }
  }
  try {
    writeFileSync(file, "[]")
  } catch {}
  return killed
}

/** 프로세스 트리 종료. 자식(워커) 프로세스가 남아 서버 연결을 붙들지 않게 한다 */
export function killTree(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  // 끝까지 안 죽으면 강제 종료
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {}
  }, 3000).unref()
}

export function runOpencode(opts: RunOptions): Promise<RunResult> {
  const { command, args, env } = buildArgs(opts)
  const started = Date.now()

  return new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"], // stdin 닫기
      detached: process.platform !== "win32", // 프로세스 그룹으로 묶어 트리 종료 가능하게 함
    })

    trackChild(child.pid, command, args)
    const events: OpencodeEvent[] = []
    let text = ""
    let firstEventMs: number | null = null
    let firstTextMs: number | null = null
    let toolCalls = 0
    let steps = 0
    let inputTokens = 0
    let outputTokens = 0
    let sessionID: string | undefined
    let stderrTail = ""
    let buffer = ""
    let endedBy: EndedBy = "exit"
    let lastOutputAt = started
    let finished = false

    const stop = (why: EndedBy) => {
      if (finished || endedBy !== "exit") return
      endedBy = why
      if (child.pid) killTree(child.pid)
    }

    const handleLine = (line: string) => {
      const s = line.trim()
      if (!s.startsWith("{")) return
      let ev: OpencodeEvent
      try {
        ev = JSON.parse(s)
      } catch {
        return
      }
      if (typeof ev.type !== "string") return
      const now = Date.now()
      lastOutputAt = now
      if (firstEventMs === null) firstEventMs = now - started
      sessionID ??= ev.sessionID
      if (ev.type === "text") {
        if (firstTextMs === null) firstTextMs = now - started
        text += String(ev.part?.text ?? "")
      } else if (ev.type === "tool_use") {
        toolCalls++
      } else if (ev.type === "step_finish") {
        steps++
        inputTokens += Number(ev.part?.tokens?.input ?? 0)
        outputTokens += Number(ev.part?.tokens?.output ?? 0)
      }
      events.push(ev)
      opts.onEvent?.(ev)
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8")
      let idx: number
      while ((idx = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, idx))
        buffer = buffer.slice(idx + 1)
      }
    })
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000)
      lastOutputAt = Date.now()
    })

    const timers: ReturnType<typeof setInterval>[] = []
    if (opts.stallTimeoutMs && opts.stallTimeoutMs > 0) {
      const t = setInterval(() => {
        if (Date.now() - lastOutputAt >= opts.stallTimeoutMs!) stop("stall")
      }, Math.min(1000, Math.max(50, Math.floor(opts.stallTimeoutMs / 4))))
      timers.push(t)
    }
    if (opts.totalTimeoutMs && opts.totalTimeoutMs > 0) {
      const t = setTimeout(() => stop("timeout"), opts.totalTimeoutMs)
      timers.push(t as unknown as ReturnType<typeof setInterval>)
    }
    const onAbort = () => stop("aborted")
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      untrackChild(child.pid)
      for (const t of timers) {
        clearInterval(t)
        clearTimeout(t as unknown as ReturnType<typeof setTimeout>)
      }
      opts.signal?.removeEventListener("abort", onAbort)
      if (buffer) handleLine(buffer)
      resolve({
        exitCode: code,
        endedBy,
        sessionID,
        events,
        text,
        durationMs: Date.now() - started,
        firstEventMs,
        firstTextMs,
        toolCalls,
        steps,
        inputTokens,
        outputTokens,
        stderrTail,
      })
    }
    child.on("close", (code) => finish(code))
    child.on("error", (err) => {
      stderrTail += `\n[spawn 오류] ${err.message}`
      finish(null)
    })
  })
}
