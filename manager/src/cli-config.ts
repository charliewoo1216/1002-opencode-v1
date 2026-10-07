// `ocx config` 명령: 현재 설정 보기 / 점검 / 항목 설명 / 예시
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Parsed } from "./args"
import { configPath } from "./cli-common"
import { ConfigError, loadConfig, type OcxConfig } from "./config"
import { exampleConfig, renderConfigKeys } from "./config-doc"
import { layoutFor } from "./paths"
import { listProfiles } from "./profile"

const OK = "✓"
const BAD = "✗"
const SKIP = "○"

/** 화면에 보여 줄 때 API 키는 가린다 (EMPTY는 그대로) */
export function maskedConfig(cfg: OcxConfig): unknown {
  return JSON.parse(
    JSON.stringify(cfg, (k, v) => (k === "apiKey" && typeof v === "string" && v !== "EMPTY" ? "********" : v)),
  )
}

export interface CheckLine {
  ok: boolean | null
  text: string
}

/** 설정과 환경을 점검한다. online이면 모델 서버에 실제로 접속해 본다 */
export async function runChecks(p: Parsed, online: boolean): Promise<CheckLine[]> {
  const lines: CheckLine[] = []
  const add = (ok: boolean | null, text: string) => lines.push({ ok, text })
  const path = configPath(p.flags)

  let cfg: OcxConfig
  try {
    cfg = loadConfig(path)
    add(true, `설정 파일: ${path}`)
  } catch (e) {
    add(false, e instanceof ConfigError ? `설정 오류: ${e.message}` : `설정을 읽을 수 없습니다: ${(e as Error).message}`)
    return lines
  }
  add(true, `모델 ${Object.keys(cfg.models).length}개 등록: ${Object.keys(cfg.models).join(", ")} (기본 ${cfg.defaultModel}${cfg.smallModel ? `, 보조 ${cfg.smallModel}` : ""})`)

  // 원본 opencode
  const [cmd, ...base] = cfg.opencode.command as [string, ...string[]]
  const v = spawnSync(cmd, [...base, "--version"], { encoding: "utf8", timeout: 30_000 })
  if (v.error) add(false, `원본 opencode를 실행할 수 없습니다 (${cfg.opencode.command.join(" ")}): ${v.error.message}`)
  else if (v.status !== 0) add(false, `원본 opencode --version 이 실패했습니다 (종료 코드 ${v.status}): ${(v.stderr || v.stdout).trim().slice(0, 200)}`)
  else add(true, `원본 opencode: ${v.stdout.trim().split("\n").pop()}`)

  // 모델 서버
  for (const [id, m] of Object.entries(cfg.models)) {
    if (!online) {
      add(null, `모델 ${id}: ${m.baseURL} (접속 확인은 --online)`)
      continue
    }
    const started = Date.now()
    try {
      const res = await fetch(`${m.baseURL}/models`, {
        headers: m.apiKey ? { authorization: `Bearer ${m.apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      })
      const ms = Date.now() - started
      if (res.ok) add(true, `모델 ${id}: ${m.baseURL} 응답 정상 (${ms}ms)`)
      else add(false, `모델 ${id}: ${m.baseURL} 에서 상태 코드 ${res.status} 응답 (주소나 API 키를 확인하세요)`)
    } catch (e) {
      add(false, `모델 ${id}: ${m.baseURL} 에 접속할 수 없습니다 (${(e as Error).name === "TimeoutError" ? "8초 안에 응답 없음" : (e as Error).message}). 주소·포트·프록시 환경변수(NO_PROXY)를 확인하세요`)
    }
  }

  // 작업 폴더
  const cwd = resolve(String(p.flags.dir ?? "."))
  const layout = layoutFor(cwd)
  try {
    mkdirSync(layout.batch, { recursive: true })
    const probe = join(layout.batch, ".write-test")
    writeFileSync(probe, "ok")
    rmSync(probe, { force: true })
    add(true, `작업 폴더 쓰기 가능: ${cwd}`)
  } catch (e) {
    add(false, `작업 폴더에 쓸 수 없습니다 (${cwd}): ${(e as Error).message}`)
  }
  const ref = join(cwd, cfg.referenceDir)
  add(existsSync(ref) ? true : null, existsSync(ref) ? `참조 폴더: ${ref}` : `참조 폴더(${cfg.referenceDir}/)가 없습니다. 참조 자료가 없으면 분석을 건너뜁니다`)
  if (cfg.profilesDir) add(existsSync(resolve(cfg.profilesDir)) ? true : false, existsSync(resolve(cfg.profilesDir)) ? `사용자 프로필 폴더: ${resolve(cfg.profilesDir)}` : `profilesDir 폴더가 없습니다: ${resolve(cfg.profilesDir)}`)
  add(true, `사용할 수 있는 프로필: ${listProfiles(cfg.profilesDir).join(", ")}`)

  const proxyEnv = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].filter((k) => process.env[k])
  if (proxyEnv.length) add(null, `프록시 환경변수가 설정되어 있습니다(${proxyEnv.join(", ")}). 사내 모델 서버는 NO_PROXY 에 넣어야 우회 없이 접속합니다 (현재 NO_PROXY: ${process.env.NO_PROXY ?? process.env.no_proxy ?? "없음"})`)
  return lines
}

export async function cmdConfig(p: Parsed): Promise<number> {
  const sub = p.positionals[0] ?? "show"
  switch (sub) {
    case "keys":
      console.log(renderConfigKeys())
      return 0
    case "example":
      console.log(exampleConfig())
      return 0
    case "show": {
      const path = configPath(p.flags)
      console.error(`설정 파일: ${path}${existsSync(path) ? "" : " (없음)"}`)
      const cfg = loadConfig(path)
      console.log(JSON.stringify(maskedConfig(cfg), null, 2))
      return 0
    }
    case "check": {
      const lines = await runChecks(p, p.flags.online === true)
      for (const l of lines) console.log(`${l.ok === true ? OK : l.ok === false ? BAD : SKIP} ${l.text}`)
      const failed = lines.filter((l) => l.ok === false).length
      console.log(failed ? `\n문제 ${failed}건이 있습니다. 위 ${BAD} 항목을 먼저 해결하세요.` : "\n점검을 통과했습니다.")
      return failed ? 1 : 0
    }
    default:
      console.error(`알 수 없는 하위 명령입니다: "${sub}" (사용 가능: show, check, keys, example)`)
      return 2
  }
}
