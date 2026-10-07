// 검증 명령 실행기: 작업 계획서의 검증 명령(빌드·테스트 등)을 실행하고 결과를 모은다
// - 명령마다 시간 제한, 출력은 뒤쪽만 보관
// - 시간 초과 시 프로세스 트리 종료, 정상 종료 후에도 남은 자식(예: 테스트가 띄운 서버)을 정리
import { spawn } from "node:child_process"
import { killTree, trackChild, untrackChild } from "./runner"

export interface CommandResult {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  /** 출력의 뒤쪽 일부 (표준 출력 + 표준 에러) */
  outputTail: string
  /** 실행 자체를 거부한 사유 (금지 명령 등) */
  blocked?: string
}

export interface VerifyResult {
  ok: boolean
  results: CommandResult[]
  /** 모델에게 돌려줄 실패 요약 (성공이면 빈 문자열) */
  failureSummary: string
}

export interface VerifyOptions {
  cwd: string
  /** 명령 하나당 시간 제한(ms) */
  timeoutMs: number
  /** 명령 실행 전 검사. 허용하지 않으면 거부 사유 문자열을 돌려준다 */
  guard?: (command: string) => string | null
  /** 출력 보관 길이(문자) */
  tailChars?: number
  env?: Record<string, string>
}

const MAX_TAIL = 4000

export function shellFor(command: string): { cmd: string; args: string[] } {
  return process.platform === "win32" ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", command] } : { cmd: "sh", args: ["-c", command] }
}

export function runCommand(command: string, o: VerifyOptions): Promise<CommandResult> {
  const blocked = o.guard?.(command)
  if (blocked) return Promise.resolve({ command, exitCode: null, timedOut: false, durationMs: 0, outputTail: "", blocked })
  const started = Date.now()
  const { cmd, args } = shellFor(command)
  const keep = o.tailChars ?? MAX_TAIL

  return new Promise<CommandResult>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: { ...process.env, CI: "1", ...o.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    trackChild(child.pid, cmd, args)
    let tail = ""
    const onData = (b: Buffer) => {
      tail = (tail + b.toString("utf8")).slice(-keep)
    }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    let timedOut = false
    let exitCode: number | null = null
    let finished = false
    let grace: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) killTree(child.pid)
    }, o.timeoutMs)
    const finish = () => {
      if (finished) return
      finished = true
      untrackChild(child.pid)
      clearTimeout(timer)
      if (grace) clearTimeout(grace)
      child.stdout!.destroy()
      child.stderr!.destroy()
      resolve({ command, exitCode: timedOut ? null : exitCode, timedOut, durationMs: Date.now() - started, outputTail: tail })
    }
    // 'close'는 자식이 붙들고 있는 출력 파이프가 모두 닫혀야 오므로, 백그라운드 서버가 남아 있으면 오지 않는다.
    // 그래서 명령 자체가 끝난 시점('exit')에 남은 프로세스 그룹을 정리하고, 출력이 비워질 시간을 잠깐 준 뒤 끝낸다.
    child.on("exit", (code) => {
      exitCode = code
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM")
        } catch {}
      }
      grace = setTimeout(finish, 1500)
    })
    child.on("close", finish)
    child.on("error", (e) => {
      tail += `\n[실행 오류] ${e.message}`
      finish()
    })
  })
}

/** 명령을 순서대로 실행하고, 처음 실패한 명령에서 멈춘다 */
export async function runVerify(commands: string[], o: VerifyOptions): Promise<VerifyResult> {
  const results: CommandResult[] = []
  for (const c of commands) {
    const r = await runCommand(c, o)
    results.push(r)
    if (r.blocked || r.timedOut || r.exitCode !== 0) {
      const why = r.blocked
        ? `실행이 허용되지 않은 명령입니다: ${r.blocked}`
        : r.timedOut
          ? `시간 제한(${Math.round(o.timeoutMs / 60000)}분)을 넘겼습니다`
          : `종료 코드 ${r.exitCode}`
      return {
        ok: false,
        results,
        failureSummary: `검증 명령 \`${c}\` 실패 (${why})${r.outputTail.trim() ? `\n출력(뒤쪽):\n${r.outputTail.trim()}` : ""}`,
      }
    }
  }
  return { ok: true, results, failureSummary: "" }
}
