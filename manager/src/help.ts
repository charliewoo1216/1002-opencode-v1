// 도움말: 개요(--help) / 명령별 상세(<명령> --help) / 사용 가이드(ocx guide)
// 기본값은 코드의 실제 기본값(DAY_DEFAULTS 등)에서 가져와 문서와 동작이 어긋나지 않게 한다.
import { AUTO_DEFAULTS, DAY_DEFAULTS, NIGHT_DEFAULTS } from "./config"

export interface CmdHelp {
  name: string
  summary: string
  usage: string[]
  options: Array<{ flag: string; desc: string; def?: string }>
  examples: Array<{ cmd: string; desc: string }>
  notes: string[]
  related: string[]
  /** 원본 opencode와의 관계 */
  origin: string
}

const COMMON = [
  { flag: "--config <파일>", desc: "ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능", def: "./ocx.config.json" },
  { flag: "--dir <폴더>", desc: "작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장)", def: "현재 폴더" },
  { flag: "--model <이름>", desc: "설정 파일에 등록한 모델 중 이번 실행에 쓸 모델. 한 번 시작하면 끝까지 그 모델만 씀", def: "defaultModel" },
]

export const COMMANDS: CmdHelp[] = [
  {
    name: "plan",
    summary: "참조 자료 분석 → 계획서 작성 → 승인 (코드는 수정하지 않음)",
    usage: ['ocx plan --profile <프로필> "<몇 줄의 지시>"', "ocx plan --status", "ocx plan --approve"],
    options: [
      { flag: "--profile <이름>", desc: "작업 성격에 맞는 프로필 (ocx profiles 로 목록 확인). 필수" },
      { flag: "--yes", desc: "확인 없이 승인합니다. 계획서를 직접 확인할 수 없을 때만 쓰세요 (승인은 무인 실행의 안전장치입니다)" },
      { flag: "--no-analyze", desc: "참조 자료 분석을 건너뜀 (이미 분석했거나 참조 자료가 없을 때)" },
      { flag: "--status", desc: "계획서가 승인된 상태인지, 승인 후 바뀌지 않았는지 확인" },
      { flag: "--approve", desc: "계획서를 직접 고친 뒤 승인 기록을 남김 (오류가 있으면 사유를 알려 줌)" },
      { flag: "--timeout <초>", desc: "계획서 작성 모델 호출 한 번의 제한 시간", def: "1800" },
      ...COMMON,
    ],
    examples: [
      { cmd: 'ocx plan --profile java "주문 조회 API에 페이징을 추가해줘"', desc: "참조 분석 후 의도 계획서와 작업 계획서를 만들고 승인 여부를 물음" },
      { cmd: "ocx plan --approve", desc: ".plan/ 의 계획서를 직접 고친 뒤 승인" },
    ],
    notes: [
      "참조 자료는 작업 폴더의 reference/ 폴더(설정 referenceDir)에 넣어 두세요. 바뀐 부분만 다시 분석합니다.",
      "모르는 점은 모델이 '열린 질문'으로 남기고 터미널에서 직접 물어봅니다. 터미널이 아니면 질문하지 않고 멈춥니다.",
      "생성된 계획서는 .plan/intent.md(의도·시나리오), .plan/tasks.md(작업 목록)입니다. 직접 고쳐도 되지만 고친 뒤에는 다시 승인해야 합니다.",
      "승인된 계획서가 있어야 ocx night(무인 실행)를 시작할 수 있습니다. 승인 후 계획서가 바뀌면 승인이 무효가 됩니다.",
    ],
    related: ["night", "day", "profiles", "guide 계획서"],
    origin: "원본 opencode의 plan 에이전트와는 별개입니다. 원본의 질문 도구는 비대화형 실행에서 막혀 있어, 질문은 ocx가 터미널에서 직접 합니다.",
  },
  {
    name: "day",
    summary: "낮 모드: 서버가 느리거나 멈춰도 사용자가 수동으로 중단·재시작하던 것을 자동으로 처리",
    usage: ['ocx day "<지시문>"', "ocx day --task <작업번호>", "ocx day --resume", "ocx day"],
    options: [
      { flag: "--task <번호>", desc: "승인된 계획서의 작업 하나를 실행 (의도·완료 기준·검증 명령이 지시문에 포함됨)" },
      { flag: "--resume", desc: "중단(보류)된 이전 낮 모드 실행을 이어서 진행" },
      { flag: "--light", desc: "처음부터 가볍게 실행 (day.lightBody를 요청에 덧붙임). 서버가 느릴 때 두 번째 시도부터는 자동 적용" },
      { flag: "--profile <이름>", desc: "프로필의 스택 지침·최신 기법 문서를 세션에 주입" },
      { flag: "--agent <이름>", desc: "원본 opencode의 에이전트 지정" },
      { flag: "--auto", desc: "권한 요청을 자동 승인 (안전 규칙에서 거부한 항목과 작업 폴더 밖 접근은 계속 막힘)" },
      { flag: "--continue", desc: "(지시문 없이 화면을 열 때) 마지막 세션을 이어서 열기" },
      ...COMMON,
    ],
    examples: [
      { cmd: 'ocx day "UserService의 NPE를 고쳐줘"', desc: "정체·반복·시간 초과를 감지해 같은 세션 이어하기 → 새 세션으로 자동 재시도" },
      { cmd: "ocx day --task T2", desc: "계획서의 T2 작업만 낮 모드로 실행" },
      { cmd: "ocx day", desc: "원본 화면(TUI)을 혼잡 대응과 함께 엽니다. 정체된 요청은 끊겨 원본이 다시 시도합니다" },
    ],
    notes: [
      `감지 기준(설정 day.*): 첫 토큰 대기 ${DAY_DEFAULTS.firstTokenWaitSeconds}초, 응답 중간 정체 ${DAY_DEFAULTS.streamIdleSeconds}초, 시도당 ${DAY_DEFAULTS.attemptBudgetMinutes}분, 최대 ${DAY_DEFAULTS.maxAttempts}회. 이 값은 가정값이니 ocx stats 로 실제 속도를 본 뒤 조정하세요.`,
      "첫 토큰을 기다리는 동안은 서버 대기열에서 줄을 서 있을 수 있어서 응답 중간 정체보다 길게 기다립니다 (끊고 다시 요청하면 줄 순서를 잃을 수 있음).",
      "끝내 못 하면 '보류'하고 바뀐 파일은 그대로 둡니다. 이어서 하려면 ocx day --resume.",
      "서버 자체의 느림은 해결할 수 없습니다. 낭비를 줄이고 멈추지 않게 하는 기능입니다.",
    ],
    related: ["night", "auto", "stats", "guide 낮에쓰기"],
    origin: "원본 opencode run을 감싸서 실행합니다. 지시문 없이 실행하면 원본 화면을 그대로 띄우되 측정 프록시를 거치게 합니다.",
  },
  {
    name: "night",
    summary: "밤 모드: 승인된 계획서를 퇴근 후 끝까지 진행하고 아침에 결과를 정리",
    usage: ["ocx night", "ocx night --now", "ocx night --until <HH:MM>", "ocx night --dry-run"],
    options: [
      { flag: "--now", desc: `야간 창(${NIGHT_DEFAULTS.windowStart})을 기다리지 않고 지금 시작` },
      { flag: "--until <HH:MM>", desc: "종료 시각 지정 (다음에 오는 그 시각)", def: NIGHT_DEFAULTS.endTime },
      { flag: "--hours <N>", desc: "지금(또는 창이 열린 때)부터 N시간 뒤에 종료" },
      { flag: "--retry-held", desc: "이전 실행에서 보류·건너뜀이 된 작업도 다시 시도" },
      { flag: "--dry-run", desc: "실행하지 않고 일정과 작업 순서만 확인" },
      { flag: "--profile <이름>", desc: "프로필의 스택 지침·최신 기법 문서를 세션에 주입" },
      { flag: "--auto", desc: "권한 요청을 자동 승인 (안전 규칙에서 거부한 항목과 작업 폴더 밖 접근은 계속 막힘)" },
      ...COMMON,
    ],
    examples: [
      { cmd: "ocx night --dry-run", desc: "퇴근 전에 일정과 작업 순서를 확인" },
      { cmd: "ocx night", desc: `${NIGHT_DEFAULTS.windowStart}가 되면 시작해 다음 날 ${NIGHT_DEFAULTS.endTime}까지 진행 (창 안이면 바로 시작)` },
      { cmd: "ocx night --now --hours 3", desc: "지금 시작해서 3시간만 진행" },
    ],
    notes: [
      "승인된 계획서(.plan/)가 필수입니다. 없거나 승인 후 바뀌었으면 시작하지 않습니다.",
      "작업마다: 백업 → 구현 → 검증 명령 → 완료 기준 점검. 실패하면 문제를 알려 주며 고치게 하고(기본 3회), 끝내 안 되면 변경분을 .batch/held/ 에 보관한 뒤 작업 전 상태로 되돌리고 보류합니다.",
      "보류된 작업에 의존하는 작업은 건너뛰고, 독립적인 작업은 계속합니다.",
      "서버가 멈추면 30초부터 두 배씩 늘려(상한 10분) 기다렸다가 다시 시도합니다.",
      "도중에 프로그램이나 PC가 꺼져도 다시 실행하면 이어서 합니다 (계획서가 같을 때). 완료된 작업은 다시 하지 않습니다.",
      "Ctrl-C를 한 번 누르면 현재 작업을 마친 뒤 멈추고, 한 번 더 누르면 즉시 종료합니다.",
      `종료 조건: 모두 완료 / 종료 시각(${NIGHT_DEFAULTS.endTime}) / 남은 작업이 모두 보류·건너뜀 / 사용자 중단. 어느 경우든 .batch/report.md 를 씁니다.`,
      "퇴근 전에: ① ocx config check --online 으로 서버 연결 확인 ② 절전·잠금·자동 업데이트 재부팅을 꺼 두세요.",
    ],
    related: ["plan", "report", "auto", "guide 저녁에맡기기"],
    origin: "낮 모드의 감독 실행(이어하기·새 세션·루프 감지)을 야간용 느긋한 기준으로 재사용합니다.",
  },
  {
    name: "auto",
    summary: "오토 모드: 시각·서버 속도·사람 유무를 보고 낮/밤 동작을 스스로 선택",
    usage: ['ocx auto ["<지시문>"]', "ocx auto --status", "ocx auto --mode <day|night>"],
    options: [
      { flag: "--status", desc: "판단 결과와 근거만 보여 주고 실행하지 않음" },
      { flag: "--mode <day|night>", desc: "모드를 직접 지정 (무인 시작의 안전 조건은 그대로 확인)" },
      { flag: "(그 밖의 옵션)", desc: "선택된 동작(day 또는 night)의 옵션을 그대로 쓸 수 있습니다 (--now, --until, --profile, --auto 등)" },
      ...COMMON,
    ],
    examples: [
      { cmd: 'ocx auto "로그 포맷을 정리해줘"', desc: "사람이 직접 지시 → 낮 동작, 서버가 느리면 가볍게" },
      { cmd: "ocx auto", desc: "승인된 계획서가 있고 무인이면 밤 동작, 낮이면 원본 화면" },
      { cmd: "ocx auto --status", desc: "지금 어떤 동작을 고를지와 이유만 확인" },
    ],
    notes: [
      "판단 근거: 현재 시각(야간 창 안/밖), 최근 호출 속도(ocx 측정 기록), 사람이 터미널에서 직접 실행했는지.",
      `속도 기준: 첫 토큰 ${AUTO_DEFAULTS.slowFirstTokenSeconds}초 초과 또는 초당 ${AUTO_DEFAULTS.slowTokensPerSec}토큰 미만이면 느림 (설정 auto.*). 느림에서 빠름으로 돌아가려면 기준의 ${AUTO_DEFAULTS.recoverFactor * 100}% 이하여야 합니다(완충).`,
      `최근 ${AUTO_DEFAULTS.lookbackHours}시간의 측정 기록이 ${AUTO_DEFAULTS.minSamples}건 미만이면 속도를 '알 수 없음'으로 보고 보수적으로(낮 동작, 가볍게 하지 않음) 판단합니다.`,
      "무인(터미널이 아님)으로 시작하려면 승인된 계획서가 반드시 있어야 합니다. 지시문이 있어도 마찬가지입니다.",
      "판단은 실행을 시작할 때 한 번 합니다. 실행 도중에 모드를 바꾸지는 않습니다. 판단 기록은 .batch/auto-log.jsonl 에 남습니다.",
    ],
    related: ["day", "night", "stats"],
    origin: "선택된 동작에 따라 ocx day 또는 ocx night 로 넘깁니다.",
  },
  {
    name: "report",
    summary: "마지막 밤 모드 실행의 아침 리포트 보기",
    usage: ["ocx report"],
    options: [COMMON[1]!],
    examples: [{ cmd: "ocx report", desc: "완료·보류·건너뜀 작업, 보류 사유, 확인할 항목을 정리해서 출력" }],
    notes: [
      "같은 내용이 .batch/report.md 에 저장됩니다. 작업이 끝날 때마다 갱신되므로 밤새 도중에도 볼 수 있습니다.",
      "리포트에는 '검증 통과'와 '검증 명령 없음(미검증)'이 구분되어 표시됩니다. 미검증 작업은 직접 확인하세요.",
      "보류된 작업의 변경분은 .batch/held/<작업번호>/ 에 보관되어 있습니다.",
    ],
    related: ["night", "stats"],
    origin: "ocx 전용 기능입니다.",
  },
  {
    name: "stats",
    summary: "시간대별 응답 속도 요약 (첫 토큰 시간, 초당 토큰, 소요 시간)",
    usage: ["ocx stats", "ocx stats --model <이름>"],
    options: [{ flag: "--model <이름>", desc: "해당 모델의 기록만 집계" }, COMMON[1]!],
    examples: [{ cmd: "ocx stats", desc: "몇 시에 서버가 느린지, 야간에 얼마나 빨라지는지 숫자로 확인" }],
    notes: [
      "ocx로 실행한 작업의 측정 기록(.batch/metrics.jsonl)을 집계합니다. 며칠 쌓이면 낮/밤 설정값을 정하는 근거가 됩니다.",
      "빠른 시간대 활용(night.fastWindow)과 오토 모드의 속도 기준도 이 값을 보고 정하세요.",
    ],
    related: ["auto", "day"],
    origin: "원본의 stats(토큰·비용 통계)와는 별개입니다. 원본 것을 보려면 opencode stats.",
  },
  {
    name: "run",
    summary: "원본 opencode run을 실행하고 속도를 기록 (모드 기능 없이 한 번 실행)",
    usage: ['ocx run "<지시문>"'],
    options: [
      { flag: "--continue", desc: "마지막 세션을 이어서" },
      { flag: "--auto", desc: "권한 요청을 자동 승인" },
      { flag: "--timeout <초>", desc: "전체 실행 제한 시간" },
      { flag: "--stall-timeout <초>", desc: "이 시간 동안 출력이 없으면 종료" },
      { flag: "--no-proxy", desc: "측정 프록시를 쓰지 않음 (토큰 단위 속도 기록 없음)" },
      ...COMMON,
    ],
    examples: [{ cmd: 'ocx run "README를 요약해줘"', desc: "한 번 실행하고 결과를 출력" }],
    notes: ["재시도·이어하기 같은 보호 기능이 필요하면 ocx day 를 쓰세요."],
    related: ["day"],
    origin: "원본 opencode run 입니다. ocx가 설정 주입, 폐쇄망 설정, 속도 기록을 더합니다.",
  },
  {
    name: "profiles",
    summary: "사용할 수 있는 프로필 목록",
    usage: ["ocx profiles"],
    options: [COMMON[0]!],
    examples: [{ cmd: "ocx profiles", desc: "java, python, ai, analysis 등" }],
    notes: [
      "프로필은 스택 지침(AGENTS.md), 계획서 작성 규칙(planning.md), 기본 검증 명령, 최신 기법 문서(docs/*.md)의 묶음입니다.",
      "모델이 모르는 최신 기법은 프로필의 docs/ 폴더에 요약 문서를 넣어 알려 주세요. 사용자 프로필 폴더는 설정 profilesDir 로 지정합니다.",
    ],
    related: ["plan", "guide 계획서"],
    origin: "ocx 전용 기능입니다.",
  },
  {
    name: "config",
    summary: "설정 확인: 현재 적용된 설정, 점검, 항목 설명, 예시",
    usage: ["ocx config", "ocx config check [--online]", "ocx config keys", "ocx config example"],
    options: [{ flag: "--online", desc: "check에서 각 모델 서버에 실제로 접속해 봄" }, COMMON[0]!],
    examples: [
      { cmd: "ocx config check --online", desc: "퇴근 전 점검: 설정·원본 opencode·모델 서버 연결·쓰기 권한" },
      { cmd: "ocx config example > ocx.config.json", desc: "처음 쓸 때 예시 설정 파일 만들기" },
      { cmd: "ocx config keys", desc: "모든 설정 항목의 의미와 기본값" },
    ],
    notes: ["설정 파일은 JSON입니다. 모델 3개를 등록해 두고 --model 로 실행할 때 하나를 고릅니다.", "API 키는 화면에 그대로 출력하지 않습니다 (EMPTY 제외)."],
    related: ["guide 설정"],
    origin: "원본 opencode의 설정(opencode.json)은 건드리지 않습니다. ocx가 실행할 때마다 환경변수로 주입합니다.",
  },
  {
    name: "guide",
    summary: "상황별 사용 가이드",
    usage: ["ocx guide", "ocx guide <주제>"],
    options: [],
    examples: [{ cmd: "ocx guide 저녁에맡기기", desc: "퇴근 전에 하는 일을 순서대로" }],
    notes: [],
    related: [],
    origin: "ocx 전용 기능입니다.",
  },
]

export const COMMAND_HELP_NAMES = COMMANDS.map((c) => c.name)

const SAFETY_RULES = [
  "Git 명령은 전부 막습니다 (commit, push, branch 등). Git은 직접 하세요.",
  "빌드·테스트 명령은 허용합니다.",
  "권한 상승(sudo), 시스템 종료, 디스크 변경, 외부 네트워크·배포 명령은 막습니다 (같은 PC의 서버로 가는 curl localhost 는 허용).",
  "작업 폴더 밖의 파일 읽기·쓰기는 막습니다 (무인 실행에서는 --auto 를 줘도 막힘).",
  "웹 검색·웹 가져오기 도구와 자동 업데이트·공유·모델 목록 조회 같은 외부 호출은 끕니다 (폐쇄망).",
  "밤 모드는 작업 전에 파일을 백업하고, 보류하는 작업은 변경분을 보관한 뒤 원래대로 되돌립니다.",
  "한계: bash 명령 기준으로 막기 때문에 python -c 나 Makefile 안에서 git 을 부르는 식의 간접 실행까지는 막지 못합니다.",
]

const WHAT_TO_USE: Array<[string, string]> = [
  ["평소처럼 원본 opencode 쓰기", "opencode (그대로) 또는 ocx <원본 명령>"],
  ["작업 시작 전에 계획서부터 만들기", "ocx plan --profile <이름> \"<지시>\""],
  ["퇴근 전에 맡겨 놓기", "ocx plan → (계획서 확인·승인) → ocx night"],
  ["낮에 느려도 안 끊기게 한 가지 작업 시키기", "ocx day \"<지시>\""],
  ["낮에 원본 화면을 쓰되 멈춤에 대비하기", "ocx day (지시문 없이)"],
  ["계획서의 작업 하나만 해 보기", "ocx day --task T1"],
  ["중단된 작업 이어서 하기", "ocx day --resume  /  ocx night (자동 재개)"],
  ["어떤 모드가 좋을지 맡기기", "ocx auto"],
  ["아침에 결과 보기", "ocx report"],
  ["서버가 언제 느린지 보기", "ocx stats"],
  ["설정·서버 연결 점검", "ocx config check --online"],
  ["VS Code 터미널에서 매번 쓰려면 (PATH 등록, 설정 위치)", "ocx guide VSCode사용"],
  ["모델 바꿔서 실행", "아무 명령에나 --model <이름>"],
]

export function renderOverview(): string {
  const w = Math.max(...COMMANDS.map((c) => c.name.length))
  const lines: string[] = []
  lines.push("ocx — OpenCode 확장 관리 프로그램 (폐쇄망·로컬 LLM용)", "")
  lines.push("처음 쓰는 순서")
  lines.push("  1. ocx config example > ocx.config.json   예시 설정 파일을 만들고 모델 주소를 고칩니다")
  lines.push("  2. ocx config check --online              설정과 서버 연결을 점검합니다")
  lines.push('  3. ocx plan --profile python "<지시>"     참조 분석 + 계획서 작성 + 승인 (코드는 수정하지 않음)')
  lines.push("  4. ocx night                              퇴근 전에 걸어 두면 밤새 진행합니다")
  lines.push("  5. ocx report                             아침에 결과를 봅니다", "")
  lines.push("명령")
  for (const c of COMMANDS) lines.push(`  ocx ${c.name.padEnd(w)}  ${c.summary}`)
  lines.push(`  ocx ${"(그 외)".padEnd(w)}  원본 opencode 명령으로 그대로 전달합니다 (예: ocx models)`, "")
  lines.push("하고 싶은 일 → 쓸 명령")
  for (const [a, b] of WHAT_TO_USE) lines.push(`  ${a}\n      ${b}`)
  lines.push("", "모드 비교")
  lines.push("  plan   작업 전  계획서만 만들고 코드는 수정하지 않음 (사람이 질문에 답하고 승인)")
  lines.push("  day    낮      느려도 멈추지 않게: 정체·반복·시간 초과를 감지해 자동 재시도")
  lines.push(`  night  퇴근 후  ${NIGHT_DEFAULTS.endTime}까지 무정지: 검증·점검·보류·재개, 끝나면 리포트`)
  lines.push("  auto   —       시각·서버 속도·사람 유무를 보고 day/night 를 스스로 선택", "")
  lines.push("모든 모드에 항상 적용되는 규칙")
  for (const r of SAFETY_RULES) lines.push(`  - ${r}`)
  lines.push("", "자세히: ocx <명령> --help   /   ocx guide   /   ocx config keys")
  return lines.join("\n")
}

export function renderCommandHelp(name: string): string | null {
  const c = COMMANDS.find((x) => x.name === name)
  if (!c) return null
  const lines: string[] = [`ocx ${c.name} — ${c.summary}`, "", "사용법"]
  for (const u of c.usage) lines.push(`  ${u}`)
  if (c.options.length) {
    lines.push("", "옵션")
    const w = Math.max(...c.options.map((o) => o.flag.length))
    for (const o of c.options) lines.push(`  ${o.flag.padEnd(w)}  ${o.desc}${o.def !== undefined ? ` (기본값: ${o.def})` : ""}`)
  }
  if (c.examples.length) {
    lines.push("", "예시")
    for (const e of c.examples) lines.push(`  ${e.cmd}\n      ${e.desc}`)
  }
  if (c.notes.length) {
    lines.push("", "알아 둘 점")
    for (const n of c.notes) lines.push(`  - ${n}`)
  }
  lines.push("", `원본 opencode와의 관계: ${c.origin}`)
  if (c.related.length) lines.push("", `관련: ${c.related.map((r) => (r.startsWith("guide ") ? `ocx ${r}` : `ocx ${r}`)).join(", ")}`)
  return lines.join("\n")
}

// ---------- 사용 가이드 ----------

export const GUIDES: Record<string, { title: string; body: string }> = {
  시작하기: {
    title: "처음 시작하기",
    body: `1. 설정 파일 만들기
   ocx config example > ocx.config.json
   파일을 열어 models 의 baseURL 과 model 을 사내 LLM 서버에 맞게 고칩니다.
   모델은 최대 3개까지(원하면 더) 등록해 두고, 실행할 때 --model 로 하나를 고릅니다. 한 번 시작한 작업은 그 모델 하나로 끝까지 갑니다.

2. 점검
   ocx config check --online
   원본 opencode 실행 파일, 각 모델 서버 연결, 작업 폴더 쓰기 권한을 확인합니다.

3. 첫 작업
   - 한 가지 일을 바로 시키기:   ocx day "<지시>"
   - 계획부터 세우고 맡기기:     ocx plan --profile python "<지시>" → ocx night

VS Code 터미널에서 매번 쓰려면 ocx 폴더를 PATH 에 등록하세요: ocx guide VSCode사용

작업 폴더 안에는 ocx가 .plan(계획서), .notes(참조 분석), .batch(진행 상태·속도 기록·백업·리포트) 폴더를 만듭니다.`,
  },
  VSCode사용: {
    title: "VS Code(또는 아무 터미널)에서 쓰기 — PATH 등록과 설정 위치",
    body: `ocx 는 원본 opencode 와 마찬가지로 프로젝트 폴더의 터미널에서 실행하는 프로그램입니다. 명령 이름은 \`ocx\` 입니다.

1. PATH 에 등록하기 (한 번만)
   - ocx.exe 와 opencode.exe 가 들어 있는 폴더(예: C:\\tools\\ocx)를 Windows PATH 에 추가합니다.
     시작 메뉴에서 "환경 변수" 검색 → "계정에 대한 환경 변수 편집" → 사용자 변수 Path → 편집 → 새로 만들기 → 폴더 경로 입력.
   - 등록한 뒤에는 VS Code 를 완전히 종료했다가 다시 실행해야 터미널에 반영됩니다.
   - 원본 opencode 를 이미 PATH 에 등록해 두셨다면 그대로 두세요. ocx 는 기본으로 ocx.exe 와 같은 폴더의 opencode.exe 를 쓰고, 없으면 PATH 의 opencode 를 씁니다.
     PATH 에 있는 기존 opencode 를 쓰고 싶으면 설정에 "opencode": { "command": ["opencode"] } 를 적으세요 (원본 버전이 달라지면 일부 기능이 다르게 동작할 수 있습니다).

2. 설정 파일은 한 곳에 두고 모든 프로젝트가 같이 쓰기 (권장)
   - ocx.config.example.json 을 ocx.config.json 으로 복사해 모델 주소를 고치고(예: C:\\tools\\ocx\\ocx.config.json),
     사용자 환경 변수 OCX_CONFIG 를 그 파일의 전체 경로로 지정합니다. 그러면 어느 프로젝트에서든 설정을 찾습니다.
   - 프로젝트마다 다른 설정을 쓰려면 그 프로젝트 폴더에 ocx.config.json 을 두거나 --config 파일 을 지정하세요.
     (OCX_CONFIG 도 --config 도 없으면 현재 폴더의 ocx.config.json 을 찾습니다)

3. 프로젝트에서 쓰기
   - VS Code 로 프로젝트 폴더를 열고 터미널(Ctrl+\`)에서 바로 실행합니다. 작업 폴더는 터미널의 현재 폴더입니다.
       ocx config check --online
       ocx day "한 가지 작업 지시"
       ocx plan --profile java "지시"      →   ocx night      →   (아침에) ocx report
   - 평소처럼 원본 화면을 쓰고 싶으면 \`ocx day\` (지시문 없이)를 쓰세요. 멈춤에 대비한 상태로 원본 화면이 열립니다.
     원본을 그대로 쓰는 \`opencode\` 명령도 그대로 쓸 수 있습니다 (이때는 ocx 의 기능이 적용되지 않습니다).

4. 프로젝트 폴더에 생기는 것
   - .plan/(계획서), .notes/(참조 분석), .batch/(진행 상태·속도 기록·백업·리포트) 폴더가 만들어집니다.
     Git 에 올리지 않으려면 프로젝트의 .gitignore 에 \`.plan/\`, \`.notes/\`, \`.batch/\` 를 추가하세요.`,
  },
  저녁에맡기기: {
    title: "퇴근 전에 맡겨 놓기 (밤 모드)",
    body: `퇴근 전(약 17시)에 할 일
1. 참조 자료를 reference/ 폴더에 넣습니다 (참조 코드, 설계 문서 등).
2. 계획서 만들기:   ocx plan --profile <java|python|ai|analysis> "<몇 줄의 지시>"
   - 모델이 묻는 질문에 답합니다.
   - .plan/intent.md (의도·범위·비목표·완료 기준)와 .plan/tasks.md (작업 목록)를 열어서 확인합니다.
   - 특히 작업마다 '검증 명령'과 '완료 기준'이 있는지 보세요. 없으면 "검토 필요"로 표시되고, 아침에 직접 확인해야 합니다.
   - 고칠 곳은 직접 고치고 ocx plan --approve 로 승인합니다.
3. 점검:   ocx config check --online   /   ocx night --dry-run
4. PC 설정: 절전·화면 잠금·자동 업데이트 재부팅을 꺼 두세요.
5. 실행:   ocx night      (야간 창 ${NIGHT_DEFAULTS.windowStart} 전이면 열릴 때까지 기다립니다. 바로 시작하려면 --now)

아침에
- ocx report 로 완료/보류/건너뜀과 확인할 항목을 봅니다.
- 보류된 작업은 사유와 마지막 오류가 적혀 있고, 보류 직전 변경분은 .batch/held/<작업번호>/ 에 보관되어 있습니다 (작업 폴더는 작업 전 상태로 되돌려 둠).
- 고친 뒤 다시 돌리려면 ocx night --retry-held
- Git 커밋은 직접 하세요. ocx는 Git을 쓰지 않습니다.

밤새 일어나는 일
- 서버가 멈추면 기다렸다가 다시 시도합니다. 프로그램이나 PC가 꺼졌다 켜져도 같은 명령(ocx night)으로 이어서 합니다.
- 작업은 계획서의 의존 순서대로, 한 번에 하나씩 진행합니다. 한 작업이 막혀도 의존하지 않는 다른 작업은 계속합니다.
- ${NIGHT_DEFAULTS.endTime}가 되면 안전하게 멈추고 리포트를 씁니다.`,
  },
  낮에쓰기: {
    title: "낮에 쓰기 (낮 모드)",
    body: `낮에는 서버가 몰려 느려지고, 평소 2~3분 걸리던 일이 20~30분씩 걸리기도 합니다. 낮 모드는 사용자가 지켜보다가 직접 중단하고 다시 시작하던 것을 자동으로 합니다.

- ocx day "<지시>"        한 가지 일을 시키고 지켜봅니다. 멈추거나 같은 동작을 반복하면 이어서/새 세션으로 자동 재시도합니다.
- ocx day                  원본 화면을 그대로 쓰되, 정체된 요청은 끊어서 원본이 다시 시도하게 합니다. 알림은 .batch/day-notices.log 에 남습니다.
- ocx day --task T2        계획서의 작업 하나를 실행합니다.
- ocx stats                몇 시에 느린지 숫자로 봅니다.

설정으로 조정할 수 있는 것 (ocx config keys 의 day.*): 시도당 시간 예산(${DAY_DEFAULTS.attemptBudgetMinutes}분), 응답 정체 기준(${DAY_DEFAULTS.streamIdleSeconds}초), 첫 토큰 대기(${DAY_DEFAULTS.firstTokenWaitSeconds}초), 최대 시도(${DAY_DEFAULTS.maxAttempts}회).
서버가 느릴 때 가볍게 실행하려면 day.lightBody 에 사고 모드를 끄는 옵션(예: Qwen3 계열 {"chat_template_kwargs":{"enable_thinking":false}})을 넣어 두세요. 사내 서버가 받는 옵션인지는 직접 확인해야 합니다.

서버 자체의 속도는 바꿀 수 없습니다. 낮 모드는 낭비를 줄이고 멈추지 않게 하는 기능입니다.`,
  },
  계획서: {
    title: "계획서 형식과 쓰는 법",
    body: `ocx plan 이 만드는 두 문서를 직접 고쳐도 됩니다. 고친 뒤에는 ocx plan --approve 로 다시 승인하세요 (승인 후 바뀌면 무인 실행이 거부됩니다).

.plan/intent.md  — 의도·시나리오 계획서. 제목(##)은 아래 이름을 지켜야 합니다.
  ## 목적 / ## 범위 / ## 비목표 / ## 전체 완료 기준 / (## 배경, ## 참조 자료, ## 열린 질문)
  - 비목표는 '이번에 하지 않을 일'입니다. 작업 중 범위가 넓어지는 것을 막는 기준이라 꼭 적으세요.
  - 열린 질문에 답이 없는 항목이 남아 있으면 승인할 수 없습니다.

.plan/tasks.md  — 코드 작업 계획서. 작업 하나의 형식:
  ## 작업 T1: 제목
  - 유형: 구현        (구현 / 분석 / MCP 중 하나)
  - 설명: 무엇을 하는지 구체적으로
  - 대상 파일: \`src/a.py\`, \`tests/test_a.py\`     (작업 폴더 기준 상대 경로)
  - 의존: 없음        (먼저 끝나야 하는 작업 번호, 예: T1, T2)
  - 검증 명령: \`python -m pytest tests/test_a.py\`    (성공하면 종료 코드 0)
  - 완료 기준:
    - 확인 가능한 기준 1
    - 확인 가능한 기준 2

잘 쓰는 요령 (무인 실행의 성공률을 가장 크게 좌우합니다)
- 작업은 작게: 한 작업은 한 가지 일만. 클래스 하나, 함수 하나, 도구 하나 정도.
- 구현·MCP 작업에는 반드시 검증 명령을 적습니다. 없으면 자동으로 완료를 판정할 수 없어 '검증 없음'으로 표시됩니다.
- 완료 기준은 파일을 읽어서 확인할 수 있게 구체적으로.
- 대상 파일은 가능한 한 정확히. 같은 폴더의 새 파일은 범위 안으로 보지만, 그 밖의 파일을 바꾸면 리포트에 '범위 이탈'로 표시됩니다 (night.scope 가 strict 면 되돌림).
- 분석 작업은 유형을 '분석'으로, 완료 기준에 '대상 파일을 모두 다뤘다', '존재하지 않는 이름을 쓰지 않았다'를 넣으세요.
- MCP 서버를 만드는 작업은 검증 명령에 서버 기동 확인과 도구별 호출 테스트를 넣고, 테스트가 띄운 서버는 끝에 종료하도록 하세요.

참조 자료: reference/ 폴더에 넣으면 ocx plan 이 모듈 단위로 분석해 .notes/ 에 노트와 색인(INDEX.md)을 만듭니다. 바뀐 부분만 다시 분석합니다.
프로필: ocx profiles. 모델이 모르는 최신 기법은 프로필의 docs/ 폴더에 요약 문서를 넣어 알려 주세요.`,
  },
  설정: {
    title: "설정 파일",
    body: `설정은 JSON 파일(ocx.config.json)입니다. 위치는 --config 또는 환경변수 OCX_CONFIG 로 바꿀 수 있습니다.

- 예시 만들기:       ocx config example > ocx.config.json
- 모든 항목 설명:    ocx config keys
- 현재 적용값 보기:  ocx config
- 점검:              ocx config check --online

필수는 models 입니다. 나머지는 기본값이 있습니다.
모델은 이름을 붙여 여러 개 등록하고(예: qwen38, oss, qwen25coder), 실행할 때 --model <이름> 으로 고릅니다.
API 키가 필요 없는 서버는 apiKey 를 EMPTY 로 둡니다. 주소는 http:// 도 됩니다.

원본 opencode의 설정 파일(opencode.json)은 건드리지 않습니다. ocx가 실행할 때마다 필요한 설정을 환경변수로 주입합니다.`,
  },
  안전규칙: {
    title: "안전 규칙 (모든 모드 공통)",
    body: SAFETY_RULES.map((r) => `- ${r}`).join("\n"),
  },
  문제해결: {
    title: "문제 해결",
    body: `- "설정 오류"가 나옵니다           → ocx config check 로 어느 항목이 문제인지 확인하세요.
- 서버에 연결되지 않습니다           → ocx config check --online. 주소·포트·프록시 환경변수(HTTP_PROXY)가 사내 서버를 우회하도록 NO_PROXY 에 서버 주소를 넣어야 할 수 있습니다.
- night 가 시작하지 않습니다         → 승인된 계획서가 필요합니다. ocx plan --status 로 확인하고, 계획서를 고쳤다면 ocx plan --approve.
- 작업이 계속 보류됩니다             → ocx report 의 사유와 마지막 오류를 보세요. 검증 명령이 작업 폴더에서 직접 실행했을 때 통과하는지, 시간 제한(night.verifyTimeoutMinutes)이 충분한지 확인하세요.
- 검증 명령이 '허용되지 않은 명령'    → Git, sudo, 외부 네트워크, 배포 명령은 막혀 있습니다 (ocx guide 안전규칙).
- 서버가 느려서 낮에 자꾸 끊깁니다    → ocx stats 로 실제 속도를 보고 day.streamIdleSeconds, day.firstTokenWaitSeconds, day.attemptBudgetMinutes 를 조정하세요.
- 이전 실행의 프로세스가 남았습니다   → 다음 실행(ocx day / ocx night) 시작 때 자동으로 정리합니다.
- 상태 파일                          → .batch/ 폴더 (night-state.json, day-state.json, metrics.jsonl, report.md). 지우면 처음부터 다시 시작합니다.`,
  },
}

export const GUIDE_TOPICS = Object.keys(GUIDES)

export function renderGuide(topic?: string): string {
  if (!topic) {
    return ["ocx 사용 가이드 — 주제를 골라 보세요: ocx guide <주제>", "", ...GUIDE_TOPICS.map((t) => `  ${t.padEnd(8)}  ${GUIDES[t]!.title}`)].join("\n")
  }
  const q = topic.replace(/\s+/g, "").toLowerCase()
  const key = GUIDE_TOPICS.find((t) => t.toLowerCase() === q) ?? GUIDE_TOPICS.find((t) => t.toLowerCase().includes(q))
  if (!key) return `알 수 없는 주제입니다: "${topic}"\n\n${renderGuide()}`
  const g = GUIDES[key]!
  return `${g.title}\n${"=".repeat(Math.min(60, g.title.length * 2))}\n\n${g.body}`
}
