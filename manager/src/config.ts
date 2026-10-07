// 관리 프로그램 설정(JSON) 로드와 검증, 원본 OpenCode 설정 생성
import { readFileSync, existsSync } from "node:fs"

export interface ModelEntry {
  /** 접속 주소 (예: http://host:8000/v1) */
  baseURL: string
  /** 서버에 보낼 모델 ID */
  model: string
  apiKey: string
  contextLimit: number
  outputLimit: number
  label?: string
  /** 이 모델로 가는 모든 요청 본문에 덧붙일 필드 (프록시가 적용) */
  extraBody?: Record<string, unknown>
}

/** 낮 모드(혼잡 적응) 설정 */
export interface DayConfig {
  /** 한 번의 시도에 허용하는 총 시간(분). 평소 2~3분 걸리는 작업이면 10분 정도 */
  attemptBudgetMinutes: number
  /** 응답이 나오기 시작한 뒤 청크 간격이 이 시간(초)을 넘으면 정체로 본다 */
  streamIdleSeconds: number
  /** 첫 토큰까지 기다리는 최대 시간(초). 대기열에서 줄 서는 중일 수 있으므로 길게 잡는다 */
  firstTokenWaitSeconds: number
  /** 최대 시도 횟수 (이어하기 -> 새 세션 -> ...) */
  maxAttempts: number
  /** 프롬프트 토큰이 컨텍스트 한도의 이 비율을 넘으면 새 세션으로 넘어간다 (0~1) */
  contextRenewRatio: number
  /** 같은 도구 호출/오류가 연속 이 횟수 반복되면 루프로 본다 */
  loopThreshold: number
  /** 가볍게 실행할 때 모든 요청에 덧붙일 본문 필드 (예: Qwen3 사고 모드 끄기) */
  lightBody: Record<string, unknown>
}

export interface OcxConfig {
  /** 원본 OpenCode 실행 명령 (예: ["opencode"] 또는 ["bun","run","src/index.ts"]) */
  opencode: { command: string[] }
  models: Record<string, ModelEntry>
  defaultModel: string
  /** 제목 생성 등 보조 호출용 모델 (생략하면 기본 모델과 동일) */
  smallModel?: string
  /** 폐쇄망 설정(외부 호출 차단 플래그) 적용 여부. 기본 true */
  closedNetwork: boolean
  /** 프로필 폴더 (사용자 정의 프로필 위치). 생략하면 내장 프로필만 사용 */
  profilesDir?: string
  /** 참조 자료 폴더 이름(작업 폴더 기준). 기본 "reference" */
  referenceDir: string
  day: DayConfig
  night: NightConfig
  auto: AutoConfig
  safety: SafetyConfig
}

/** 안전 규칙 설정. Git 금지 등 기본 규칙은 항상 적용되고, 여기서는 금지 명령을 더할 수 있다 */
export interface SafetyConfig {
  /** 추가로 금지할 명령 이름들 (명령의 첫 단어 기준, 예: ["docker", "kubectl"]) */
  extraBlocked: string[]
}

export class ConfigError extends Error {}

export const DAY_DEFAULTS: DayConfig = {
  attemptBudgetMinutes: 10,
  streamIdleSeconds: 120,
  firstTokenWaitSeconds: 300,
  maxAttempts: 4,
  contextRenewRatio: 0.7,
  loopThreshold: 3,
  lightBody: {},
}

/** 밤 모드(무정지 완주) 설정 */
export interface NightConfig {
  /** 야간 창 시작 (이 시각 전에 시작하면 창이 열릴 때까지 대기) */
  windowStart: string
  /** 종료 시각 (이 시각이 되면 안전하게 멈추고 리포트를 쓴다) */
  endTime: string
  /** 작업 하나를 구현하는 한 번의 시도에 허용하는 시간(분). 야간에는 모델이 빠르므로 낮보다 넉넉하게 */
  attemptBudgetMinutes: number
  streamIdleSeconds: number
  firstTokenWaitSeconds: number
  /** 한 번의 감독 실행 안에서 이어하기·새 세션으로 재시도하는 최대 횟수 */
  maxAttempts: number
  contextRenewRatio: number
  loopThreshold: number
  lightBody: Record<string, unknown>
  /** 검증 실패 후 다시 고치게 하는 최대 횟수 */
  maxFixRounds: number
  /** 검증 명령 하나당 시간 제한(분) */
  verifyTimeoutMinutes: number
  /** 작업 하나에 쓸 수 있는 총 시간(분). 넘으면 보류 */
  taskBudgetMinutes: number
  /** 서버가 응답하지 않을 때 재시도 간격: 처음(초) -> 두 배씩 늘려 최대(초)까지 */
  patienceInitialSeconds: number
  patienceMaxSeconds: number
  /** 검증 통과 후 완료 기준 대조 점검을 한 번 더 할지 */
  selfCheck: boolean
  /** 계획서 범위를 벗어난 변경: warn(리포트에 표시) / strict(되돌림) */
  scope: "warn" | "strict"
  /** 작업 전 백업 용량 상한(MB) */
  backupMaxMB: number
  /** 빠른 시간대 활용(기본 꺼짐): 켜면 서버가 빠른 시간대에는 무거운 작업을, 그 밖에는 가벼운 작업을 먼저 한다 */
  fastWindow: { enabled: boolean; start: string; end: string }
}

export const NIGHT_DEFAULTS: NightConfig = {
  windowStart: "19:00",
  endTime: "07:00",
  attemptBudgetMinutes: 30,
  streamIdleSeconds: 600,
  firstTokenWaitSeconds: 1800,
  maxAttempts: 6,
  contextRenewRatio: 0.7,
  loopThreshold: 3,
  lightBody: {},
  maxFixRounds: 3,
  verifyTimeoutMinutes: 30,
  taskBudgetMinutes: 180,
  patienceInitialSeconds: 30,
  patienceMaxSeconds: 600,
  selfCheck: true,
  scope: "warn",
  backupMaxMB: 500,
  fastWindow: { enabled: false, start: "01:00", end: "07:00" },
}

/** 오토 모드(자동 판단) 설정 */
export interface AutoConfig {
  /** 최근 호출의 첫 토큰 중앙값이 이 시간(초)을 넘으면 서버가 느리다고 본다 */
  slowFirstTokenSeconds: number
  /** 최근 호출의 초당 토큰 중앙값이 이 값보다 낮으면 느리다고 본다 */
  slowTokensPerSec: number
  /** 한 번 '느림'으로 판단한 뒤 '빠름'으로 돌아가려면 기준의 이 비율 이하여야 한다 (0~1, 낮을수록 보수적). 모드가 오락가락하는 것을 막는 완충 */
  recoverFactor: number
  /** 속도를 볼 최근 기간(시간) */
  lookbackHours: number
  /** 판단에 필요한 최소 표본 수. 모자라면 '알 수 없음'으로 보고 보수적으로(낮 동작) 판단한다 */
  minSamples: number
}

export const AUTO_DEFAULTS: AutoConfig = {
  slowFirstTokenSeconds: 20,
  slowTokensPerSec: 8,
  recoverFactor: 0.7,
  lookbackHours: 6,
  minSamples: 3,
}

const DEFAULTS = {
  opencode: { command: ["opencode"] },
  closedNetwork: true,
  referenceDir: "reference",
}

function fail(msg: string): never {
  throw new ConfigError(msg)
}

/** 설정 객체를 검증하고 기본값을 채운다. 오류 메시지는 한글로 안내한다. */
export function normalizeConfig(raw: unknown): OcxConfig {
  if (typeof raw !== "object" || raw === null) fail("설정 파일의 최상위는 JSON 객체여야 합니다.")
  const r = raw as Record<string, unknown>

  const modelsRaw = r.models
  if (typeof modelsRaw !== "object" || modelsRaw === null || Object.keys(modelsRaw).length === 0) {
    fail('"models" 항목에 모델을 1개 이상 등록해야 합니다.')
  }
  const models: Record<string, ModelEntry> = {}
  for (const [id, v] of Object.entries(modelsRaw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) fail(`모델 이름 "${id}"에는 영문, 숫자, '-', '_'만 쓸 수 있습니다.`)
    const m = v as Record<string, unknown>
    if (typeof m?.baseURL !== "string" || !/^https?:\/\//.test(m.baseURL)) {
      fail(`모델 "${id}"의 baseURL은 http:// 또는 https:// 로 시작해야 합니다.`)
    }
    if (typeof m.model !== "string" || !m.model) fail(`모델 "${id}"의 "model"(서버 모델 ID)이 필요합니다.`)
    models[id] = {
      baseURL: m.baseURL.replace(/\/+$/, ""),
      model: m.model,
      apiKey: typeof m.apiKey === "string" && m.apiKey ? m.apiKey : "EMPTY",
      contextLimit: Number(m.contextLimit ?? 32768),
      outputLimit: Number(m.outputLimit ?? 4096),
      label: typeof m.label === "string" ? m.label : undefined,
      extraBody: m.extraBody && typeof m.extraBody === "object" && !Array.isArray(m.extraBody) ? (m.extraBody as Record<string, unknown>) : undefined,
    }
    if (!(models[id]!.contextLimit > 0) || !(models[id]!.outputLimit > 0)) {
      fail(`모델 "${id}"의 contextLimit, outputLimit은 0보다 큰 숫자여야 합니다.`)
    }
  }

  const defaultModel = String(r.defaultModel ?? Object.keys(models)[0])
  if (!models[defaultModel]) fail(`defaultModel "${defaultModel}"이(가) models에 등록되어 있지 않습니다.`)
  const smallModel = r.smallModel === undefined ? undefined : String(r.smallModel)
  if (smallModel && !models[smallModel]) fail(`smallModel "${smallModel}"이(가) models에 등록되어 있지 않습니다.`)

  const opencodeRaw = (r.opencode as { command?: unknown } | undefined)?.command
  if (opencodeRaw !== undefined && !(Array.isArray(opencodeRaw) && opencodeRaw.length > 0 && opencodeRaw.every((x) => typeof x === "string"))) {
    fail('"opencode.command"는 문자열 배열이어야 합니다. 예: ["opencode"]')
  }

  return {
    opencode: { command: (opencodeRaw as string[] | undefined) ?? DEFAULTS.opencode.command },
    models,
    defaultModel,
    smallModel,
    closedNetwork: r.closedNetwork === undefined ? DEFAULTS.closedNetwork : Boolean(r.closedNetwork),
    profilesDir: typeof r.profilesDir === "string" && r.profilesDir ? r.profilesDir : undefined,
    referenceDir: typeof r.referenceDir === "string" && r.referenceDir ? r.referenceDir : DEFAULTS.referenceDir,
    day: normalizeDay(r.day),
    night: normalizeNight(r.night),
    auto: normalizeAuto(r.auto),
    safety: normalizeSafety(r.safety),
  }
}

function normalizeDay(raw: unknown): DayConfig {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (key: keyof DayConfig, min: number, max: number): number => {
    const v = d[key] === undefined ? (DAY_DEFAULTS[key] as number) : Number(d[key])
    if (!Number.isFinite(v) || v < min || v > max) fail(`"day.${key}"은(는) ${min} 이상 ${max} 이하의 숫자여야 합니다.`)
    return v
  }
  const lightBody = d.lightBody
  if (lightBody !== undefined && (typeof lightBody !== "object" || lightBody === null || Array.isArray(lightBody))) {
    fail('"day.lightBody"는 JSON 객체여야 합니다.')
  }
  return {
    attemptBudgetMinutes: num("attemptBudgetMinutes", 1, 24 * 60),
    streamIdleSeconds: num("streamIdleSeconds", 5, 3600),
    firstTokenWaitSeconds: num("firstTokenWaitSeconds", 5, 24 * 3600),
    maxAttempts: Math.floor(num("maxAttempts", 1, 20)),
    contextRenewRatio: num("contextRenewRatio", 0.1, 1),
    loopThreshold: Math.floor(num("loopThreshold", 2, 20)),
    lightBody: (lightBody as Record<string, unknown> | undefined) ?? DAY_DEFAULTS.lightBody,
  }
}

function normalizeNight(raw: unknown): NightConfig {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (key: keyof NightConfig, min: number, max: number): number => {
    const v = d[key] === undefined ? (NIGHT_DEFAULTS[key] as number) : Number(d[key])
    if (!Number.isFinite(v) || v < min || v > max) fail(`"night.${key}"은(는) ${min} 이상 ${max} 이하의 숫자여야 합니다.`)
    return v
  }
  const clock = (key: "windowStart" | "endTime"): string => {
    const v = d[key] === undefined ? NIGHT_DEFAULTS[key] : String(d[key])
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) fail(`"night.${key}"은(는) HH:MM 형식이어야 합니다 (예: 07:00).`)
    return v
  }
  const lightBody = d.lightBody
  if (lightBody !== undefined && (typeof lightBody !== "object" || lightBody === null || Array.isArray(lightBody))) {
    fail('"night.lightBody"는 JSON 객체여야 합니다.')
  }
  const scope = d.scope === undefined ? NIGHT_DEFAULTS.scope : String(d.scope)
  if (scope !== "warn" && scope !== "strict") fail('"night.scope"는 "warn" 또는 "strict"여야 합니다.')
  return {
    windowStart: clock("windowStart"),
    endTime: clock("endTime"),
    attemptBudgetMinutes: num("attemptBudgetMinutes", 1, 24 * 60),
    streamIdleSeconds: num("streamIdleSeconds", 5, 24 * 3600),
    firstTokenWaitSeconds: num("firstTokenWaitSeconds", 5, 24 * 3600),
    maxAttempts: Math.floor(num("maxAttempts", 1, 50)),
    contextRenewRatio: num("contextRenewRatio", 0.1, 1),
    loopThreshold: Math.floor(num("loopThreshold", 2, 20)),
    lightBody: (lightBody as Record<string, unknown> | undefined) ?? NIGHT_DEFAULTS.lightBody,
    maxFixRounds: Math.floor(num("maxFixRounds", 0, 20)),
    verifyTimeoutMinutes: num("verifyTimeoutMinutes", 0.05, 24 * 60),
    taskBudgetMinutes: num("taskBudgetMinutes", 0.1, 24 * 60),
    patienceInitialSeconds: num("patienceInitialSeconds", 0.05, 3600),
    patienceMaxSeconds: num("patienceMaxSeconds", 0.05, 24 * 3600),
    selfCheck: d.selfCheck === undefined ? NIGHT_DEFAULTS.selfCheck : Boolean(d.selfCheck),
    scope,
    backupMaxMB: num("backupMaxMB", 1, 100_000),
    fastWindow: normalizeFastWindow(d.fastWindow),
  }
}

function normalizeFastWindow(raw: unknown): NightConfig["fastWindow"] {
  const def = NIGHT_DEFAULTS.fastWindow
  if (raw === undefined) return { ...def }
  if (typeof raw !== "object" || raw === null) fail('"night.fastWindow"는 JSON 객체여야 합니다.')
  const f = raw as Record<string, unknown>
  const clock = (k: "start" | "end") => {
    const v = f[k] === undefined ? def[k] : String(f[k])
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) fail(`"night.fastWindow.${k}"은(는) HH:MM 형식이어야 합니다 (예: 01:00).`)
    return v
  }
  return { enabled: f.enabled === undefined ? def.enabled : Boolean(f.enabled), start: clock("start"), end: clock("end") }
}

function normalizeSafety(raw: unknown): SafetyConfig {
  if (raw === undefined) return { extraBlocked: [] }
  if (typeof raw !== "object" || raw === null) fail('"safety"는 JSON 객체여야 합니다.')
  const eb = (raw as Record<string, unknown>).extraBlocked
  if (eb === undefined) return { extraBlocked: [] }
  if (!Array.isArray(eb) || !eb.every((x) => typeof x === "string" && /^[A-Za-z0-9._-]+$/.test(x))) {
    fail('"safety.extraBlocked"는 명령 이름(영문·숫자·. _ -)의 문자열 배열이어야 합니다. 예: ["docker", "kubectl"]')
  }
  return { extraBlocked: [...new Set((eb as string[]).map((x) => x.toLowerCase()))] }
}

function normalizeAuto(raw: unknown): AutoConfig {
  const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const num = (key: keyof AutoConfig, min: number, max: number): number => {
    const v = d[key] === undefined ? AUTO_DEFAULTS[key] : Number(d[key])
    if (!Number.isFinite(v) || v < min || v > max) fail(`"auto.${key}"은(는) ${min} 이상 ${max} 이하의 숫자여야 합니다.`)
    return v
  }
  return {
    slowFirstTokenSeconds: num("slowFirstTokenSeconds", 0.1, 3600),
    slowTokensPerSec: num("slowTokensPerSec", 0.1, 10_000),
    recoverFactor: num("recoverFactor", 0.1, 1),
    lookbackHours: num("lookbackHours", 0.1, 24 * 14),
    minSamples: Math.floor(num("minSamples", 1, 1000)),
  }
}

/** 밤 모드 설정을 감독 실행 정책(DayConfig)으로 바꾼다 */
export function nightSupervisePolicy(n: NightConfig): DayConfig {
  return {
    attemptBudgetMinutes: n.attemptBudgetMinutes,
    streamIdleSeconds: n.streamIdleSeconds,
    firstTokenWaitSeconds: n.firstTokenWaitSeconds,
    maxAttempts: n.maxAttempts,
    contextRenewRatio: n.contextRenewRatio,
    loopThreshold: n.loopThreshold,
    lightBody: n.lightBody,
  }
}

export function loadConfig(path: string): OcxConfig {
  if (!existsSync(path)) fail(`설정 파일을 찾을 수 없습니다: ${path}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    fail(`설정 파일이 올바른 JSON이 아닙니다 (${path}): ${(e as Error).message}`)
  }
  return normalizeConfig(raw)
}

/** 모델 선택값("모델이름")을 원본 OpenCode의 "프로바이더/모델" 형식으로 변환 */
export function opencodeModelRef(cfg: OcxConfig, id: string): string {
  const m = cfg.models[id]
  if (!m) fail(`등록되지 않은 모델입니다: "${id}" (등록된 모델: ${Object.keys(cfg.models).join(", ")})`)
  return `${id}/${m.model}`
}

export interface OpencodeConfigExtras {
  /** 모델 이름 -> 대신 쓸 baseURL (측정 프록시 연결용) */
  baseURLOverrides?: Record<string, string>
  /** 원본 `agent` 설정 (에이전트 이름 -> 정의) */
  agents?: Record<string, unknown>
  /** 매 세션에 포함할 지침 파일 경로 (프로필의 AGENTS.md 등) */
  instructions?: string[]
  /** 원본 `permission` 설정 */
  permission?: Record<string, unknown>
}

/** 원본 OpenCode에 주입할 설정(JSON)을 만든다. 원본 설정 파일은 건드리지 않는다. */
export function buildOpencodeConfig(
  cfg: OcxConfig,
  selected: string,
  extras: OpencodeConfigExtras = {},
): Record<string, unknown> {
  const provider: Record<string, unknown> = {}
  for (const [id, m] of Object.entries(cfg.models)) {
    provider[id] = {
      npm: "@ai-sdk/openai-compatible",
      name: m.label ?? id,
      options: { baseURL: extras.baseURLOverrides?.[id] ?? m.baseURL, apiKey: m.apiKey },
      models: { [m.model]: { name: m.label ?? m.model, limit: { context: m.contextLimit, output: m.outputLimit } } },
    }
  }
  return {
    autoupdate: false,
    share: "disabled",
    provider,
    model: opencodeModelRef(cfg, selected),
    small_model: opencodeModelRef(cfg, cfg.smallModel ?? selected),
    ...(extras.agents ? { agent: extras.agents } : {}),
    ...(extras.instructions?.length ? { instructions: extras.instructions } : {}),
    ...(extras.permission ? { permission: extras.permission } : {}),
  }
}

/** 폐쇄망용 환경변수. 모델 목록 조회 차단이 가장 중요하다(실측으로 확인). */
export function closedNetworkEnv(): Record<string, string> {
  return {
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  }
}
