// ocx가 원본 OpenCode에 주입하는 전용 에이전트 정의
// 에이전트의 모델, 권한, 단계 수를 설정으로 지정한다 (원본 소스는 수정하지 않는다)

export const AGENT_ANALYZE = "ocx-analyze"
export const AGENT_PLAN = "ocx-plan"
export const AGENT_CHECK = "ocx-check"

/** .env 같은 비밀 파일은 읽지 않도록 막고 나머지 읽기만 허용 */
const READ_ONLY_PERMISSION = {
  read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
  glob: "allow",
  grep: "allow",
  list: "allow",
  edit: "deny",
  bash: "deny",
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
  question: "deny",
  todowrite: "deny",
  skill: "deny",
  external_directory: "deny",
} as const

export const ANALYZE_REQUIRED_HEADINGS = ["개요", "구성 요소", "핵심 흐름", "외부 의존", "주의점", "요약"] as const

const ANALYZE_PROMPT = `당신은 코드 분석가입니다.
- 지시받은 파일만 읽고 분석합니다. 파일을 수정하거나 명령을 실행하지 않습니다.
- 실제로 읽은 내용만 근거로 씁니다. 존재하지 않는 파일, 클래스, 함수 이름을 지어내지 않습니다.
- 파일 경로는 작업 폴더 기준 상대 경로로, 백틱(\`)으로 감싸서 씁니다.
- 한국어로 작성하고, 최종 응답에는 아래 형식의 마크다운 노트만 출력합니다 (다른 설명 금지).

# <모듈 이름>
## 개요
## 구성 요소
(파일별로 역할을 한두 줄씩)
## 핵심 흐름
## 외부 의존
## 주의점
## 요약
(한두 문장)`

const PLAN_PROMPT = `당신은 소프트웨어 작업 계획 작성자입니다.
- 코드를 수정하지 않습니다. 필요하면 참조 자료와 프로젝트 파일을 읽어 근거를 확인합니다.
- 사용자의 의도를 임의로 바꾸거나 넓히지 않습니다. 범위 밖의 일은 "비목표"에 적습니다.
- 모르거나 모호한 점은 추측하지 말고 "열린 질문" 항목에 질문으로 적습니다.
- 요구된 마크다운 형식을 정확히 지킵니다. 최종 응답에는 요구한 문서 본문만 출력합니다.
- 한국어로 작성합니다.`

const CHECK_PROMPT = `당신은 완료 기준 점검자입니다.
- 코드를 수정하지 않습니다. 필요한 파일을 직접 읽어서 확인합니다.
- 주어진 완료 기준을 하나씩, 실제 파일 내용을 근거로 충족 여부를 판단합니다. 읽지 않고 추측하지 않습니다.
- 어느 하나라도 충족하지 못했으면 미흡입니다.
- 응답의 마지막 줄은 반드시 아래 둘 중 하나의 형식이어야 합니다.
점검결과: 통과
점검결과: 미흡 - (충족하지 못한 기준과 이유를 한두 문장으로)`

export interface AgentDef {
  description: string
  mode: "primary"
  prompt: string
  steps: number
  permission: Record<string, unknown>
}

export function ocxAgents(): Record<string, AgentDef> {
  return {
    [AGENT_ANALYZE]: {
      description: "ocx 참조 자료 분석 (읽기 전용)",
      mode: "primary",
      prompt: ANALYZE_PROMPT,
      steps: 40,
      permission: { ...READ_ONLY_PERMISSION },
    },
    [AGENT_PLAN]: {
      description: "ocx 계획서 작성 (읽기 전용)",
      mode: "primary",
      prompt: PLAN_PROMPT,
      steps: 40,
      permission: { ...READ_ONLY_PERMISSION },
    },
    [AGENT_CHECK]: {
      description: "ocx 완료 기준 점검 (읽기 전용)",
      mode: "primary",
      prompt: CHECK_PROMPT,
      steps: 30,
      permission: { ...READ_ONLY_PERMISSION },
    },
  }
}
