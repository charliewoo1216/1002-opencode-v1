// 설정 항목 설명 (ocx config keys / example 이 사용). 기본값은 코드의 실제 기본값에서 가져온다.
import { AUTO_DEFAULTS, DAY_DEFAULTS, NIGHT_DEFAULTS } from "./config"

export interface ConfigKeyDoc {
  key: string
  desc: string
  /** 기본값을 문자열로 (없으면 필수 또는 생략 가능) */
  def?: string
}

const j = (v: unknown) => JSON.stringify(v)

export const CONFIG_DOCS: ConfigKeyDoc[] = [
  { key: "opencode.command", desc: "원본 OpenCode 실행 명령(문자열 배열). 예: [\"opencode\"] 또는 [\"C:/tools/opencode.exe\"]. './opencode.exe' 처럼 상대 경로는 설정 파일이 있는 폴더 기준입니다", def: "생략하면 ocx 실행 파일과 같은 폴더의 opencode(.exe), 없으면 PATH 의 opencode" },
  { key: "models.<이름>.baseURL", desc: "모델 서버 주소 (http:// 또는 https://). OpenAI 호환 API의 /v1 까지" },
  { key: "models.<이름>.model", desc: "서버에 보낼 모델 ID" },
  { key: "models.<이름>.apiKey", desc: "API 키 (키가 필요 없는 서버는 EMPTY)", def: j("EMPTY") },
  { key: "models.<이름>.contextLimit", desc: "모델 컨텍스트 길이(토큰). 참조 분석 단위 크기와 컨텍스트 사용량 판단에 쓰임", def: "32768" },
  { key: "models.<이름>.outputLimit", desc: "한 번에 낼 수 있는 최대 출력 토큰", def: "4096" },
  { key: "models.<이름>.extraBody", desc: "이 모델로 가는 모든 요청 본문에 덧붙일 JSON 필드 (서버별 옵션)" },
  { key: "defaultModel", desc: "--model을 주지 않을 때 쓸 모델 이름", def: "models의 첫 번째" },
  { key: "smallModel", desc: "제목 생성 같은 보조 호출에 쓸 모델 (가벼운 모델을 지정하면 본 모델의 부하가 줄어듦)", def: "본 모델과 같음" },
  { key: "closedNetwork", desc: "폐쇄망 설정(외부 호출 차단 플래그, 웹 도구 차단) 적용 여부", def: "true" },
  { key: "profilesDir", desc: "사용자 정의 프로필 폴더 (같은 이름이면 내장 프로필보다 우선)" },
  { key: "referenceDir", desc: "참조 자료 폴더 이름 (작업 폴더 기준)", def: j("reference") },
  { key: "day.attemptBudgetMinutes", desc: "낮 모드: 한 번의 시도에 허용하는 시간(분). 평소 2~3분 걸리는 작업이면 10분 정도", def: String(DAY_DEFAULTS.attemptBudgetMinutes) },
  { key: "day.streamIdleSeconds", desc: "낮 모드: 응답이 나오기 시작한 뒤 이 시간(초) 동안 멈추면 정체로 판단", def: String(DAY_DEFAULTS.streamIdleSeconds) },
  { key: "day.firstTokenWaitSeconds", desc: "낮 모드: 첫 토큰을 기다리는 최대 시간(초). 서버 대기열 순서를 잃지 않도록 길게", def: String(DAY_DEFAULTS.firstTokenWaitSeconds) },
  { key: "day.maxAttempts", desc: "낮 모드: 이어하기·새 세션으로 재시도하는 최대 횟수", def: String(DAY_DEFAULTS.maxAttempts) },
  { key: "day.contextRenewRatio", desc: "낮 모드: 프롬프트가 컨텍스트 한도의 이 비율을 넘으면 새 세션으로 이어감 (0~1)", def: String(DAY_DEFAULTS.contextRenewRatio) },
  { key: "day.loopThreshold", desc: "낮 모드: 같은 도구 호출/오류가 연속 이 횟수 반복되면 루프로 판단", def: String(DAY_DEFAULTS.loopThreshold) },
  { key: "day.lightBody", desc: "가볍게 실행할 때 요청 본문에 덧붙일 JSON (예: Qwen3 사고 모드 해제 {\"chat_template_kwargs\":{\"enable_thinking\":false}})", def: j(DAY_DEFAULTS.lightBody) },
  { key: "night.windowStart", desc: "밤 모드: 야간 창 시작 시각. 이 전에 시작하면 열릴 때까지 대기 (--now로 건너뜀)", def: j(NIGHT_DEFAULTS.windowStart) },
  { key: "night.endTime", desc: "밤 모드: 종료 시각. 이 시각이 되면 안전하게 멈추고 리포트를 씀", def: j(NIGHT_DEFAULTS.endTime) },
  { key: "night.attemptBudgetMinutes", desc: "밤 모드: 작업 하나를 구현하는 한 번의 시도에 허용하는 시간(분)", def: String(NIGHT_DEFAULTS.attemptBudgetMinutes) },
  { key: "night.streamIdleSeconds", desc: "밤 모드: 응답 중간 정체로 볼 시간(초)", def: String(NIGHT_DEFAULTS.streamIdleSeconds) },
  { key: "night.firstTokenWaitSeconds", desc: "밤 모드: 첫 토큰을 기다리는 최대 시간(초)", def: String(NIGHT_DEFAULTS.firstTokenWaitSeconds) },
  { key: "night.maxAttempts", desc: "밤 모드: 한 번의 감독 실행 안에서 재시도하는 최대 횟수", def: String(NIGHT_DEFAULTS.maxAttempts) },
  { key: "night.contextRenewRatio", desc: "밤 모드: 프롬프트가 컨텍스트 한도의 이 비율을 넘으면 새 세션으로 이어감 (0~1)", def: String(NIGHT_DEFAULTS.contextRenewRatio) },
  { key: "night.loopThreshold", desc: "밤 모드: 같은 도구 호출/오류가 연속 이 횟수 반복되면 루프로 판단", def: String(NIGHT_DEFAULTS.loopThreshold) },
  { key: "night.lightBody", desc: "밤 모드: 가볍게 재시도할 때 요청 본문에 덧붙일 JSON (day.lightBody와 같은 형식)", def: j(NIGHT_DEFAULTS.lightBody) },
  { key: "night.maxFixRounds", desc: "밤 모드: 검증·점검 실패 후 다시 고치게 하는 최대 횟수", def: String(NIGHT_DEFAULTS.maxFixRounds) },
  { key: "night.verifyTimeoutMinutes", desc: "밤 모드: 검증 명령 하나당 시간 제한(분). Java 빌드가 느리면 늘리세요", def: String(NIGHT_DEFAULTS.verifyTimeoutMinutes) },
  { key: "night.taskBudgetMinutes", desc: "밤 모드: 작업 하나에 쓸 수 있는 총 시간(분). 넘으면 보류", def: String(NIGHT_DEFAULTS.taskBudgetMinutes) },
  { key: "night.patienceInitialSeconds", desc: "밤 모드: 서버 문제로 멈췄을 때 처음 기다리는 시간(초). 이후 두 배씩 늘어남", def: String(NIGHT_DEFAULTS.patienceInitialSeconds) },
  { key: "night.patienceMaxSeconds", desc: "밤 모드: 기다리는 시간의 상한(초)", def: String(NIGHT_DEFAULTS.patienceMaxSeconds) },
  { key: "night.selfCheck", desc: "밤 모드: 검증 통과 후 완료 기준을 한 번 더 대조 점검할지", def: String(NIGHT_DEFAULTS.selfCheck) },
  { key: "night.scope", desc: "밤 모드: 계획서 범위 밖 변경 처리. warn(리포트에 표시) / strict(되돌림)", def: j(NIGHT_DEFAULTS.scope) },
  { key: "night.backupMaxMB", desc: "밤 모드: 작업 전 백업 용량 상한(MB). 넘으면 대상 파일만 백업", def: String(NIGHT_DEFAULTS.backupMaxMB) },
  { key: "night.fastWindow", desc: "밤 모드: 빠른 시간대 활용 {enabled,start,end}. 켜면 빠른 시간대에 무거운 작업을 먼저", def: j(NIGHT_DEFAULTS.fastWindow) },
  { key: "safety.extraBlocked", desc: "추가로 금지할 명령 이름 목록(첫 단어 기준). Git 금지, 권한 상승·시스템·외부 네트워크·배포 명령 차단은 항상 적용됩니다. 예: [\"docker\", \"kubectl\"]", def: j([]) },
  { key: "auto.slowFirstTokenSeconds", desc: "오토 모드: 최근 첫 토큰 중앙값이 이 시간(초)을 넘으면 서버가 느리다고 판단", def: String(AUTO_DEFAULTS.slowFirstTokenSeconds) },
  { key: "auto.slowTokensPerSec", desc: "오토 모드: 최근 초당 토큰 중앙값이 이보다 낮으면 느리다고 판단", def: String(AUTO_DEFAULTS.slowTokensPerSec) },
  { key: "auto.recoverFactor", desc: "오토 모드: 느림에서 빠름으로 돌아가려면 기준의 이 비율 이하여야 함 (모드가 오락가락하지 않게 하는 완충)", def: String(AUTO_DEFAULTS.recoverFactor) },
  { key: "auto.lookbackHours", desc: "오토 모드: 속도를 볼 최근 기간(시간)", def: String(AUTO_DEFAULTS.lookbackHours) },
  { key: "auto.minSamples", desc: "오토 모드: 판단에 필요한 최소 측정 기록 수. 모자라면 '알 수 없음'으로 보고 보수적으로 판단", def: String(AUTO_DEFAULTS.minSamples) },
]

export function renderConfigKeys(): string {
  const w = Math.max(...CONFIG_DOCS.map((d) => d.key.length))
  return CONFIG_DOCS.map((d) => `${d.key.padEnd(w)}  ${d.desc}${d.def !== undefined ? `\n${" ".repeat(w + 2)}기본값: ${d.def}` : ""}`).join("\n")
}

/** 처음 쓰는 사람을 위한 설정 파일 예시 (필수 항목 위주) */
export function exampleConfig(): string {
  return JSON.stringify(
    {
      // opencode.command 는 생략하면 ocx 와 같은 폴더의 opencode.exe, 없으면 PATH 의 opencode 를 씁니다
      models: {
        qwen38: { label: "Qwen 3.8 27B", baseURL: "http://llm-a.internal:8000/v1", model: "qwen3.8-27b", apiKey: "EMPTY", contextLimit: 32768, outputLimit: 4096 },
        oss: { label: "GPT-OSS", baseURL: "http://llm-b.internal:8001/v1", model: "gpt-oss", apiKey: "EMPTY", contextLimit: 32768, outputLimit: 4096 },
        qwen25coder: { label: "Qwen 2.5 Coder", baseURL: "http://llm-c.internal:8002/v1", model: "qwen2.5-coder", apiKey: "EMPTY", contextLimit: 16384, outputLimit: 4096 },
      },
      defaultModel: "qwen38",
      smallModel: "qwen25coder",
      day: { lightBody: { chat_template_kwargs: { enable_thinking: false } } },
      night: { endTime: NIGHT_DEFAULTS.endTime, verifyTimeoutMinutes: NIGHT_DEFAULTS.verifyTimeoutMinutes },
    },
    null,
    2,
  )
}
