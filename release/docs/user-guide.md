# ocx 사용 설명서

> 이 문서는 `manager/scripts/gen-docs.ts` 로 도움말에서 자동 생성됩니다. 직접 고치지 말고 `manager/src/help.ts` 를 고친 뒤 `bun run scripts/gen-docs.ts` 를 실행하세요.

## 이 프로그램이 하는 일

`ocx` 는 폐쇄망·사내 LLM 환경에서 OpenCode(AI 코딩 에이전트)를 쓸 때의 두 가지 어려움을 덜어 주는 관리 프로그램입니다.
- **낮**: 사용자가 몰려 서버가 느려지고 중간에 멈춰서, 사용자가 직접 중단하고 다시 시작해야 하는 문제 → 낮 모드가 정체·반복·시간 초과를 감지해 자동으로 이어서/새 세션으로 재시도합니다.
- **밤**: 퇴근 후 맡겨 놓고 아침에 완성된 결과를 받고 싶은데 작업이 끊기는 문제 → 밤 모드가 승인된 계획서의 작업을 순서대로, 검증하며, 끝까지 진행합니다.
원본 OpenCode는 수정하지 않고 `ocx` 가 감싸서 실행합니다. `ocx` 가 모르는 명령은 원본으로 그대로 전달됩니다.

## 개요 도움말 (`ocx --help`)

```text
ocx — OpenCode 확장 관리 프로그램 (폐쇄망·로컬 LLM용)

처음 쓰는 순서
  1. ocx config example > ocx.config.json   예시 설정 파일을 만들고 모델 주소를 고칩니다
  2. ocx config check --online              설정과 서버 연결을 점검합니다
  3. ocx plan --profile python "<지시>"     참조 분석 + 계획서 작성 + 승인 (코드는 수정하지 않음)
  4. ocx night                              퇴근 전에 걸어 두면 밤새 진행합니다
  5. ocx report                             아침에 결과를 봅니다

명령
  ocx plan      참조 자료 분석 → 계획서 작성 → 승인 (코드는 수정하지 않음)
  ocx day       낮 모드: 서버가 느리거나 멈춰도 사용자가 수동으로 중단·재시작하던 것을 자동으로 처리
  ocx night     밤 모드: 승인된 계획서를 퇴근 후 끝까지 진행하고 아침에 결과를 정리
  ocx auto      오토 모드: 시각·서버 속도·사람 유무를 보고 낮/밤 동작을 스스로 선택
  ocx report    마지막 밤 모드 실행의 아침 리포트 보기
  ocx stats     시간대별 응답 속도 요약 (첫 토큰 시간, 초당 토큰, 소요 시간)
  ocx run       원본 opencode run을 실행하고 속도를 기록 (모드 기능 없이 한 번 실행)
  ocx profiles  사용할 수 있는 프로필 목록
  ocx config    설정 확인: 현재 적용된 설정, 점검, 항목 설명, 예시
  ocx guide     상황별 사용 가이드
  ocx (그 외)     원본 opencode 명령으로 그대로 전달합니다 (예: ocx models)

하고 싶은 일 → 쓸 명령
  평소처럼 원본 opencode 쓰기
      opencode (그대로) 또는 ocx <원본 명령>
  작업 시작 전에 계획서부터 만들기
      ocx plan --profile <이름> "<지시>"
  퇴근 전에 맡겨 놓기
      ocx plan → (계획서 확인·승인) → ocx night
  낮에 느려도 안 끊기게 한 가지 작업 시키기
      ocx day "<지시>"
  낮에 원본 화면을 쓰되 멈춤에 대비하기
      ocx day (지시문 없이)
  계획서의 작업 하나만 해 보기
      ocx day --task T1
  중단된 작업 이어서 하기
      ocx day --resume  /  ocx night (자동 재개)
  어떤 모드가 좋을지 맡기기
      ocx auto
  아침에 결과 보기
      ocx report
  서버가 언제 느린지 보기
      ocx stats
  설정·서버 연결 점검
      ocx config check --online
  VS Code 터미널에서 매번 쓰려면 (PATH 등록, 설정 위치)
      ocx guide VSCode사용
  모델 바꿔서 실행
      아무 명령에나 --model <이름>

모드 비교
  plan   작업 전  계획서만 만들고 코드는 수정하지 않음 (사람이 질문에 답하고 승인)
  day    낮      느려도 멈추지 않게: 정체·반복·시간 초과를 감지해 자동 재시도
  night  퇴근 후  07:00까지 무정지: 검증·점검·보류·재개, 끝나면 리포트
  auto   —       시각·서버 속도·사람 유무를 보고 day/night 를 스스로 선택

모든 모드에 항상 적용되는 규칙
  - Git 명령은 전부 막습니다 (commit, push, branch 등). Git은 직접 하세요.
  - 빌드·테스트 명령은 허용합니다.
  - 권한 상승(sudo), 시스템 종료, 디스크 변경, 외부 네트워크·배포 명령은 막습니다 (같은 PC의 서버로 가는 curl localhost 는 허용).
  - 작업 폴더 밖의 파일 읽기·쓰기는 막습니다 (무인 실행에서는 --auto 를 줘도 막힘).
  - 웹 검색·웹 가져오기 도구와 자동 업데이트·공유·모델 목록 조회 같은 외부 호출은 끕니다 (폐쇄망).
  - 밤 모드는 작업 전에 파일을 백업하고, 보류하는 작업은 변경분을 보관한 뒤 원래대로 되돌립니다.
  - 한계: bash 명령 기준으로 막기 때문에 python -c 나 Makefile 안에서 git 을 부르는 식의 간접 실행까지는 막지 못합니다.

자세히: ocx <명령> --help   /   ocx guide   /   ocx config keys
```

## 사용 가이드

### 처음 시작하기  (`ocx guide 시작하기`)

```text
1. 설정 파일 만들기
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

작업 폴더 안에는 ocx가 .plan(계획서), .notes(참조 분석), .batch(진행 상태·속도 기록·백업·리포트) 폴더를 만듭니다.
```

### VS Code(또는 아무 터미널)에서 쓰기 — PATH 등록과 설정 위치  (`ocx guide VSCode사용`)

```text
ocx 는 원본 opencode 와 마찬가지로 프로젝트 폴더의 터미널에서 실행하는 프로그램입니다. 명령 이름은 `ocx` 입니다.

1. PATH 에 등록하기 (한 번만)
   - ocx.exe 와 opencode.exe 가 들어 있는 폴더(예: C:\tools\ocx)를 Windows PATH 에 추가합니다.
     시작 메뉴에서 "환경 변수" 검색 → "계정에 대한 환경 변수 편집" → 사용자 변수 Path → 편집 → 새로 만들기 → 폴더 경로 입력.
   - 등록한 뒤에는 VS Code 를 완전히 종료했다가 다시 실행해야 터미널에 반영됩니다.
   - 원본 opencode 를 이미 PATH 에 등록해 두셨다면 그대로 두세요. ocx 는 기본으로 ocx.exe 와 같은 폴더의 opencode.exe 를 쓰고, 없으면 PATH 의 opencode 를 씁니다.
     PATH 에 있는 기존 opencode 를 쓰고 싶으면 설정에 "opencode": { "command": ["opencode"] } 를 적으세요 (원본 버전이 달라지면 일부 기능이 다르게 동작할 수 있습니다).

2. 설정 파일은 한 곳에 두고 모든 프로젝트가 같이 쓰기 (권장)
   - ocx.config.example.json 을 ocx.config.json 으로 복사해 모델 주소를 고치고(예: C:\tools\ocx\ocx.config.json),
     사용자 환경 변수 OCX_CONFIG 를 그 파일의 전체 경로로 지정합니다. 그러면 어느 프로젝트에서든 설정을 찾습니다.
   - 프로젝트마다 다른 설정을 쓰려면 그 프로젝트 폴더에 ocx.config.json 을 두거나 --config 파일 을 지정하세요.
     (OCX_CONFIG 도 --config 도 없으면 현재 폴더의 ocx.config.json 을 찾습니다)

3. 프로젝트에서 쓰기
   - VS Code 로 프로젝트 폴더를 열고 터미널(Ctrl+`)에서 바로 실행합니다. 작업 폴더는 터미널의 현재 폴더입니다.
       ocx config check --online
       ocx day "한 가지 작업 지시"
       ocx plan --profile java "지시"      →   ocx night      →   (아침에) ocx report
   - 평소처럼 원본 화면을 쓰고 싶으면 `ocx day` (지시문 없이)를 쓰세요. 멈춤에 대비한 상태로 원본 화면이 열립니다.
     원본을 그대로 쓰는 `opencode` 명령도 그대로 쓸 수 있습니다 (이때는 ocx 의 기능이 적용되지 않습니다).

4. 기존 opencode 설정(opencode.json)과의 관계
   - 원본 opencode 는 사용자 폴더의 설정(예: C:\Users\<이름>\.config\opencode\opencode.json)을 읽습니다. ocx 는 그 파일을 수정하지 않고, 읽는 것도 막지 않습니다.
     그래서 ocx 로 실행해도 기존 설정의 MCP 서버, 테마, 키 설정, 다른 프로바이더 등은 그대로 적용됩니다.
   - 다만 ocx 가 실행할 때마다 주입하는 항목(ocx.config.json 의 models → 프로바이더·model·small_model, 자동 업데이트·공유 끄기, 권한 규칙, 계획/점검용 에이전트, 프로필 지침)은
     같은 항목이면 기존 설정보다 우선합니다. 즉 ocx 로 실행하는 동안 모델은 ocx.config.json 에 등록한 것만 선택됩니다.
   - 세션 기록은 원본과 같은 곳(사용자 폴더의 .local\share\opencode)에 저장됩니다. 원본 opencode 로 이어서 열어 볼 수도 있습니다.
   - 기존 opencode.json 에 이미 사내 LLM 서버를 설정해 두셨다면, 같은 주소·모델 ID 를 ocx.config.json 의 models 에 옮겨 적으세요. (ocx 는 속도 측정과 정체 감지를 위해 모델 서버 주소를 자기 설정에서 직접 읽습니다.)

5. 프로젝트 폴더에 생기는 것
   - .plan/(계획서), .notes/(참조 분석), .batch/(진행 상태·속도 기록·백업·리포트) 폴더가 만들어집니다.
     Git 에 올리지 않으려면 프로젝트의 .gitignore 에 `.plan/`, `.notes/`, `.batch/` 를 추가하세요.
```

### 퇴근 전에 맡겨 놓기 (밤 모드)  (`ocx guide 저녁에맡기기`)

```text
퇴근 전(약 17시)에 할 일
1. 참조 자료를 reference/ 폴더에 넣습니다 (참조 코드, 설계 문서 등).
2. 계획서 만들기:   ocx plan --profile <java|python|ai|analysis> "<몇 줄의 지시>"
   - 모델이 묻는 질문에 답합니다.
   - .plan/intent.md (의도·범위·비목표·완료 기준)와 .plan/tasks.md (작업 목록)를 열어서 확인합니다.
   - 특히 작업마다 '검증 명령'과 '완료 기준'이 있는지 보세요. 없으면 "검토 필요"로 표시되고, 아침에 직접 확인해야 합니다.
   - 고칠 곳은 직접 고치고 ocx plan --approve 로 승인합니다.
3. 점검:   ocx config check --online   /   ocx night --dry-run
4. PC 설정: 절전·화면 잠금·자동 업데이트 재부팅을 꺼 두세요.
5. 실행:   ocx night      (야간 창 19:00 전이면 열릴 때까지 기다립니다. 바로 시작하려면 --now)

아침에
- ocx report 로 완료/보류/건너뜀과 확인할 항목을 봅니다.
- 보류된 작업은 사유와 마지막 오류가 적혀 있고, 보류 직전 변경분은 .batch/held/<작업번호>/ 에 보관되어 있습니다 (작업 폴더는 작업 전 상태로 되돌려 둠).
- 고친 뒤 다시 돌리려면 ocx night --retry-held
- Git 커밋은 직접 하세요. ocx는 Git을 쓰지 않습니다.

밤새 일어나는 일
- 서버가 멈추면 기다렸다가 다시 시도합니다. 프로그램이나 PC가 꺼졌다 켜져도 같은 명령(ocx night)으로 이어서 합니다.
- 작업은 계획서의 의존 순서대로, 한 번에 하나씩 진행합니다. 한 작업이 막혀도 의존하지 않는 다른 작업은 계속합니다.
- 07:00가 되면 안전하게 멈추고 리포트를 씁니다.
```

### 낮에 쓰기 (낮 모드)  (`ocx guide 낮에쓰기`)

```text
낮에는 서버가 몰려 느려지고, 평소 2~3분 걸리던 일이 20~30분씩 걸리기도 합니다. 낮 모드는 사용자가 지켜보다가 직접 중단하고 다시 시작하던 것을 자동으로 합니다.

- ocx day "<지시>"        한 가지 일을 시키고 지켜봅니다. 멈추거나 같은 동작을 반복하면 이어서/새 세션으로 자동 재시도합니다.
- ocx day                  원본 화면을 그대로 쓰되, 정체된 요청은 끊어서 원본이 다시 시도하게 합니다. 알림은 .batch/day-notices.log 에 남습니다.
- ocx day --task T2        계획서의 작업 하나를 실행합니다.
- ocx stats                몇 시에 느린지 숫자로 봅니다.

설정으로 조정할 수 있는 것 (ocx config keys 의 day.*): 시도당 시간 예산(10분), 응답 정체 기준(120초), 첫 토큰 대기(300초), 최대 시도(4회).
서버가 느릴 때 가볍게 실행하려면 day.lightBody 에 사고 모드를 끄는 옵션(예: Qwen3 계열 {"chat_template_kwargs":{"enable_thinking":false}})을 넣어 두세요. 사내 서버가 받는 옵션인지는 직접 확인해야 합니다.

서버 자체의 속도는 바꿀 수 없습니다. 낮 모드는 낭비를 줄이고 멈추지 않게 하는 기능입니다.
```

### 계획서 형식과 쓰는 법  (`ocx guide 계획서`)

```text
ocx plan 이 만드는 두 문서를 직접 고쳐도 됩니다. 고친 뒤에는 ocx plan --approve 로 다시 승인하세요 (승인 후 바뀌면 무인 실행이 거부됩니다).

.plan/intent.md  — 의도·시나리오 계획서. 제목(##)은 아래 이름을 지켜야 합니다.
  ## 목적 / ## 범위 / ## 비목표 / ## 전체 완료 기준 / (## 배경, ## 참조 자료, ## 열린 질문)
  - 비목표는 '이번에 하지 않을 일'입니다. 작업 중 범위가 넓어지는 것을 막는 기준이라 꼭 적으세요.
  - 열린 질문에 답이 없는 항목이 남아 있으면 승인할 수 없습니다.

.plan/tasks.md  — 코드 작업 계획서. 작업 하나의 형식:
  ## 작업 T1: 제목
  - 유형: 구현        (구현 / 분석 / MCP 중 하나)
  - 설명: 무엇을 하는지 구체적으로
  - 대상 파일: `src/a.py`, `tests/test_a.py`     (작업 폴더 기준 상대 경로)
  - 의존: 없음        (먼저 끝나야 하는 작업 번호, 예: T1, T2)
  - 검증 명령: `python -m pytest tests/test_a.py`    (성공하면 종료 코드 0)
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
프로필: ocx profiles. 모델이 모르는 최신 기법은 프로필의 docs/ 폴더에 요약 문서를 넣어 알려 주세요.
```

### 설정 파일  (`ocx guide 설정`)

```text
설정은 JSON 파일(ocx.config.json)입니다. 위치는 --config 또는 환경변수 OCX_CONFIG 로 바꿀 수 있습니다.

- 예시 만들기:       ocx config example > ocx.config.json
- 모든 항목 설명:    ocx config keys
- 현재 적용값 보기:  ocx config
- 점검:              ocx config check --online

필수는 models 입니다. 나머지는 기본값이 있습니다.
모델은 이름을 붙여 여러 개 등록하고(예: qwen38, oss, qwen25coder), 실행할 때 --model <이름> 으로 고릅니다.
API 키가 필요 없는 서버는 apiKey 를 EMPTY 로 둡니다. 주소는 http:// 도 됩니다.

원본 opencode의 설정 파일(opencode.json)은 건드리지 않습니다. ocx가 실행할 때마다 필요한 설정을 환경변수로 주입합니다.
```

### 안전 규칙 (모든 모드 공통)  (`ocx guide 안전규칙`)

```text
- Git 명령은 전부 막습니다 (commit, push, branch 등). Git은 직접 하세요.
- 빌드·테스트 명령은 허용합니다.
- 권한 상승(sudo), 시스템 종료, 디스크 변경, 외부 네트워크·배포 명령은 막습니다 (같은 PC의 서버로 가는 curl localhost 는 허용).
- 작업 폴더 밖의 파일 읽기·쓰기는 막습니다 (무인 실행에서는 --auto 를 줘도 막힘).
- 웹 검색·웹 가져오기 도구와 자동 업데이트·공유·모델 목록 조회 같은 외부 호출은 끕니다 (폐쇄망).
- 밤 모드는 작업 전에 파일을 백업하고, 보류하는 작업은 변경분을 보관한 뒤 원래대로 되돌립니다.
- 한계: bash 명령 기준으로 막기 때문에 python -c 나 Makefile 안에서 git 을 부르는 식의 간접 실행까지는 막지 못합니다.
```

### 문제 해결  (`ocx guide 문제해결`)

```text
- "설정 오류"가 나옵니다           → ocx config check 로 어느 항목이 문제인지 확인하세요.
- 서버에 연결되지 않습니다           → ocx config check --online. 주소·포트·프록시 환경변수(HTTP_PROXY)가 사내 서버를 우회하도록 NO_PROXY 에 서버 주소를 넣어야 할 수 있습니다.
- night 가 시작하지 않습니다         → 승인된 계획서가 필요합니다. ocx plan --status 로 확인하고, 계획서를 고쳤다면 ocx plan --approve.
- 작업이 계속 보류됩니다             → ocx report 의 사유와 마지막 오류를 보세요. 검증 명령이 작업 폴더에서 직접 실행했을 때 통과하는지, 시간 제한(night.verifyTimeoutMinutes)이 충분한지 확인하세요.
- 검증 명령이 '허용되지 않은 명령'    → Git, sudo, 외부 네트워크, 배포 명령은 막혀 있습니다 (ocx guide 안전규칙).
- 서버가 느려서 낮에 자꾸 끊깁니다    → ocx stats 로 실제 속도를 보고 day.streamIdleSeconds, day.firstTokenWaitSeconds, day.attemptBudgetMinutes 를 조정하세요.
- 이전 실행의 프로세스가 남았습니다   → 다음 실행(ocx day / ocx night) 시작 때 자동으로 정리합니다.
- 상태 파일                          → .batch/ 폴더 (night-state.json, day-state.json, metrics.jsonl, report.md). 지우면 처음부터 다시 시작합니다.
```

## 명령 설명

### ocx plan

```text
ocx plan — 참조 자료 분석 → 계획서 작성 → 승인 (코드는 수정하지 않음)

사용법
  ocx plan --profile <프로필> "<몇 줄의 지시>"
  ocx plan --status
  ocx plan --approve

옵션
  --profile <이름>  작업 성격에 맞는 프로필 (ocx profiles 로 목록 확인). 필수
  --yes           확인 없이 승인합니다. 계획서를 직접 확인할 수 없을 때만 쓰세요 (승인은 무인 실행의 안전장치입니다)
  --no-analyze    참조 자료 분석을 건너뜀 (이미 분석했거나 참조 자료가 없을 때)
  --status        계획서가 승인된 상태인지, 승인 후 바뀌지 않았는지 확인
  --approve       계획서를 직접 고친 뒤 승인 기록을 남김 (오류가 있으면 사유를 알려 줌)
  --timeout <초>   계획서 작성 모델 호출 한 번의 제한 시간 (기본값: 1800)
  --config <파일>   ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)
  --dir <폴더>      작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)
  --model <이름>    설정 파일에 등록한 모델 중 이번 실행에 쓸 모델. 한 번 시작하면 끝까지 그 모델만 씀 (기본값: defaultModel)

예시
  ocx plan --profile java "주문 조회 API에 페이징을 추가해줘"
      참조 분석 후 의도 계획서와 작업 계획서를 만들고 승인 여부를 물음
  ocx plan --approve
      .plan/ 의 계획서를 직접 고친 뒤 승인

알아 둘 점
  - 참조 자료는 작업 폴더의 reference/ 폴더(설정 referenceDir)에 넣어 두세요. 바뀐 부분만 다시 분석합니다.
  - 모르는 점은 모델이 '열린 질문'으로 남기고 터미널에서 직접 물어봅니다. 터미널이 아니면 질문하지 않고 멈춥니다.
  - 생성된 계획서는 .plan/intent.md(의도·시나리오), .plan/tasks.md(작업 목록)입니다. 직접 고쳐도 되지만 고친 뒤에는 다시 승인해야 합니다.
  - 승인된 계획서가 있어야 ocx night(무인 실행)를 시작할 수 있습니다. 승인 후 계획서가 바뀌면 승인이 무효가 됩니다.

원본 opencode와의 관계: 원본 opencode의 plan 에이전트와는 별개입니다. 원본의 질문 도구는 비대화형 실행에서 막혀 있어, 질문은 ocx가 터미널에서 직접 합니다.

관련: ocx night, ocx day, ocx profiles, ocx guide 계획서
```

### ocx day

```text
ocx day — 낮 모드: 서버가 느리거나 멈춰도 사용자가 수동으로 중단·재시작하던 것을 자동으로 처리

사용법
  ocx day "<지시문>"
  ocx day --task <작업번호>
  ocx day --resume
  ocx day

옵션
  --task <번호>     승인된 계획서의 작업 하나를 실행 (의도·완료 기준·검증 명령이 지시문에 포함됨)
  --resume        중단(보류)된 이전 낮 모드 실행을 이어서 진행
  --light         처음부터 가볍게 실행 (day.lightBody를 요청에 덧붙임). 서버가 느릴 때 두 번째 시도부터는 자동 적용
  --profile <이름>  프로필의 스택 지침·최신 기법 문서를 세션에 주입
  --agent <이름>    원본 opencode의 에이전트 지정
  --auto          권한 요청을 자동 승인 (안전 규칙에서 거부한 항목과 작업 폴더 밖 접근은 계속 막힘)
  --continue      (지시문 없이 화면을 열 때) 마지막 세션을 이어서 열기
  --config <파일>   ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)
  --dir <폴더>      작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)
  --model <이름>    설정 파일에 등록한 모델 중 이번 실행에 쓸 모델. 한 번 시작하면 끝까지 그 모델만 씀 (기본값: defaultModel)

예시
  ocx day "UserService의 NPE를 고쳐줘"
      정체·반복·시간 초과를 감지해 같은 세션 이어하기 → 새 세션으로 자동 재시도
  ocx day --task T2
      계획서의 T2 작업만 낮 모드로 실행
  ocx day
      원본 화면(TUI)을 혼잡 대응과 함께 엽니다. 정체된 요청은 끊겨 원본이 다시 시도합니다

알아 둘 점
  - 감지 기준(설정 day.*): 첫 토큰 대기 300초, 응답 중간 정체 120초, 시도당 10분, 최대 4회. 이 값은 가정값이니 ocx stats 로 실제 속도를 본 뒤 조정하세요.
  - 첫 토큰을 기다리는 동안은 서버 대기열에서 줄을 서 있을 수 있어서 응답 중간 정체보다 길게 기다립니다 (끊고 다시 요청하면 줄 순서를 잃을 수 있음).
  - 끝내 못 하면 '보류'하고 바뀐 파일은 그대로 둡니다. 이어서 하려면 ocx day --resume.
  - 서버 자체의 느림은 해결할 수 없습니다. 낭비를 줄이고 멈추지 않게 하는 기능입니다.

원본 opencode와의 관계: 원본 opencode run을 감싸서 실행합니다. 지시문 없이 실행하면 원본 화면을 그대로 띄우되 측정 프록시를 거치게 합니다.

관련: ocx night, ocx auto, ocx stats, ocx guide 낮에쓰기
```

### ocx night

```text
ocx night — 밤 모드: 승인된 계획서를 퇴근 후 끝까지 진행하고 아침에 결과를 정리

사용법
  ocx night
  ocx night --now
  ocx night --until <HH:MM>
  ocx night --dry-run

옵션
  --now            야간 창(19:00)을 기다리지 않고 지금 시작
  --until <HH:MM>  종료 시각 지정 (다음에 오는 그 시각) (기본값: 07:00)
  --hours <N>      지금(또는 창이 열린 때)부터 N시간 뒤에 종료
  --retry-held     이전 실행에서 보류·건너뜀이 된 작업도 다시 시도
  --dry-run        실행하지 않고 일정과 작업 순서만 확인
  --profile <이름>   프로필의 스택 지침·최신 기법 문서를 세션에 주입
  --auto           권한 요청을 자동 승인 (안전 규칙에서 거부한 항목과 작업 폴더 밖 접근은 계속 막힘)
  --config <파일>    ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)
  --dir <폴더>       작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)
  --model <이름>     설정 파일에 등록한 모델 중 이번 실행에 쓸 모델. 한 번 시작하면 끝까지 그 모델만 씀 (기본값: defaultModel)

예시
  ocx night --dry-run
      퇴근 전에 일정과 작업 순서를 확인
  ocx night
      19:00가 되면 시작해 다음 날 07:00까지 진행 (창 안이면 바로 시작)
  ocx night --now --hours 3
      지금 시작해서 3시간만 진행

알아 둘 점
  - 승인된 계획서(.plan/)가 필수입니다. 없거나 승인 후 바뀌었으면 시작하지 않습니다.
  - 작업마다: 백업 → 구현 → 검증 명령 → 완료 기준 점검. 실패하면 문제를 알려 주며 고치게 하고(기본 3회), 끝내 안 되면 변경분을 .batch/held/ 에 보관한 뒤 작업 전 상태로 되돌리고 보류합니다.
  - 보류된 작업에 의존하는 작업은 건너뛰고, 독립적인 작업은 계속합니다.
  - 서버가 멈추면 30초부터 두 배씩 늘려(상한 10분) 기다렸다가 다시 시도합니다.
  - 도중에 프로그램이나 PC가 꺼져도 다시 실행하면 이어서 합니다 (계획서가 같을 때). 완료된 작업은 다시 하지 않습니다.
  - Ctrl-C를 한 번 누르면 현재 작업을 마친 뒤 멈추고, 한 번 더 누르면 즉시 종료합니다.
  - 종료 조건: 모두 완료 / 종료 시각(07:00) / 남은 작업이 모두 보류·건너뜀 / 사용자 중단. 어느 경우든 .batch/report.md 를 씁니다.
  - 퇴근 전에: ① ocx config check --online 으로 서버 연결 확인 ② 절전·잠금·자동 업데이트 재부팅을 꺼 두세요.

원본 opencode와의 관계: 낮 모드의 감독 실행(이어하기·새 세션·루프 감지)을 야간용 느긋한 기준으로 재사용합니다.

관련: ocx plan, ocx report, ocx auto, ocx guide 저녁에맡기기
```

### ocx auto

```text
ocx auto — 오토 모드: 시각·서버 속도·사람 유무를 보고 낮/밤 동작을 스스로 선택

사용법
  ocx auto ["<지시문>"]
  ocx auto --status
  ocx auto --mode <day|night>

옵션
  --status            판단 결과와 근거만 보여 주고 실행하지 않음
  --mode <day|night>  모드를 직접 지정 (무인 시작의 안전 조건은 그대로 확인)
  (그 밖의 옵션)           선택된 동작(day 또는 night)의 옵션을 그대로 쓸 수 있습니다 (--now, --until, --profile, --auto 등)
  --config <파일>       ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)
  --dir <폴더>          작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)
  --model <이름>        설정 파일에 등록한 모델 중 이번 실행에 쓸 모델. 한 번 시작하면 끝까지 그 모델만 씀 (기본값: defaultModel)

예시
  ocx auto "로그 포맷을 정리해줘"
      사람이 직접 지시 → 낮 동작, 서버가 느리면 가볍게
  ocx auto
      승인된 계획서가 있고 무인이면 밤 동작, 낮이면 원본 화면
  ocx auto --status
      지금 어떤 동작을 고를지와 이유만 확인

알아 둘 점
  - 판단 근거: 현재 시각(야간 창 안/밖), 최근 호출 속도(ocx 측정 기록), 사람이 터미널에서 직접 실행했는지.
  - 속도 기준: 첫 토큰 20초 초과 또는 초당 8토큰 미만이면 느림 (설정 auto.*). 느림에서 빠름으로 돌아가려면 기준의 70% 이하여야 합니다(완충).
  - 최근 6시간의 측정 기록이 3건 미만이면 속도를 '알 수 없음'으로 보고 보수적으로(낮 동작, 가볍게 하지 않음) 판단합니다.
  - 무인(터미널이 아님)으로 시작하려면 승인된 계획서가 반드시 있어야 합니다. 지시문이 있어도 마찬가지입니다.
  - 판단은 실행을 시작할 때 한 번 합니다. 실행 도중에 모드를 바꾸지는 않습니다. 판단 기록은 .batch/auto-log.jsonl 에 남습니다.

원본 opencode와의 관계: 선택된 동작에 따라 ocx day 또는 ocx night 로 넘깁니다.

관련: ocx day, ocx night, ocx stats
```

### ocx report

```text
ocx report — 마지막 밤 모드 실행의 아침 리포트 보기

사용법
  ocx report

옵션
  --dir <폴더>  작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)

예시
  ocx report
      완료·보류·건너뜀 작업, 보류 사유, 확인할 항목을 정리해서 출력

알아 둘 점
  - 같은 내용이 .batch/report.md 에 저장됩니다. 작업이 끝날 때마다 갱신되므로 밤새 도중에도 볼 수 있습니다.
  - 리포트에는 '검증 통과'와 '검증 명령 없음(미검증)'이 구분되어 표시됩니다. 미검증 작업은 직접 확인하세요.
  - 보류된 작업의 변경분은 .batch/held/<작업번호>/ 에 보관되어 있습니다.

원본 opencode와의 관계: ocx 전용 기능입니다.

관련: ocx night, ocx stats
```

### ocx stats

```text
ocx stats — 시간대별 응답 속도 요약 (첫 토큰 시간, 초당 토큰, 소요 시간)

사용법
  ocx stats
  ocx stats --model <이름>

옵션
  --model <이름>  해당 모델의 기록만 집계
  --dir <폴더>    작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)

예시
  ocx stats
      몇 시에 서버가 느린지, 야간에 얼마나 빨라지는지 숫자로 확인

알아 둘 점
  - ocx로 실행한 작업의 측정 기록(.batch/metrics.jsonl)을 집계합니다. 며칠 쌓이면 낮/밤 설정값을 정하는 근거가 됩니다.
  - 빠른 시간대 활용(night.fastWindow)과 오토 모드의 속도 기준도 이 값을 보고 정하세요.

원본 opencode와의 관계: 원본의 stats(토큰·비용 통계)와는 별개입니다. 원본 것을 보려면 opencode stats.

관련: ocx auto, ocx day
```

### ocx run

```text
ocx run — 원본 opencode run을 실행하고 속도를 기록 (모드 기능 없이 한 번 실행)

사용법
  ocx run "<지시문>"

옵션
  --continue           마지막 세션을 이어서
  --auto               권한 요청을 자동 승인
  --timeout <초>        전체 실행 제한 시간
  --stall-timeout <초>  이 시간 동안 출력이 없으면 종료
  --no-proxy           측정 프록시를 쓰지 않음 (토큰 단위 속도 기록 없음)
  --config <파일>        ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)
  --dir <폴더>           작업 폴더 (모든 상태 파일은 이 폴더의 .plan/.notes/.batch 에 저장) (기본값: 현재 폴더)
  --model <이름>         설정 파일에 등록한 모델 중 이번 실행에 쓸 모델. 한 번 시작하면 끝까지 그 모델만 씀 (기본값: defaultModel)

예시
  ocx run "README를 요약해줘"
      한 번 실행하고 결과를 출력

알아 둘 점
  - 재시도·이어하기 같은 보호 기능이 필요하면 ocx day 를 쓰세요.

원본 opencode와의 관계: 원본 opencode run 입니다. ocx가 설정 주입, 폐쇄망 설정, 속도 기록을 더합니다.

관련: ocx day
```

### ocx profiles

```text
ocx profiles — 사용할 수 있는 프로필 목록

사용법
  ocx profiles

옵션
  --config <파일>  ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)

예시
  ocx profiles
      java, python, ai, analysis 등

알아 둘 점
  - 프로필은 스택 지침(AGENTS.md), 계획서 작성 규칙(planning.md), 기본 검증 명령, 최신 기법 문서(docs/*.md)의 묶음입니다.
  - 모델이 모르는 최신 기법은 프로필의 docs/ 폴더에 요약 문서를 넣어 알려 주세요. 사용자 프로필 폴더는 설정 profilesDir 로 지정합니다.

원본 opencode와의 관계: ocx 전용 기능입니다.

관련: ocx plan, ocx guide 계획서
```

### ocx config

```text
ocx config — 설정 확인: 현재 적용된 설정, 점검, 항목 설명, 예시

사용법
  ocx config
  ocx config check [--online]
  ocx config keys
  ocx config example

옵션
  --online       check에서 각 모델 서버에 실제로 접속해 봄
  --config <파일>  ocx 설정 파일(JSON) 경로. 환경변수 OCX_CONFIG로도 지정 가능 (기본값: ./ocx.config.json)

예시
  ocx config check --online
      퇴근 전 점검: 설정·원본 opencode·모델 서버 연결·쓰기 권한
  ocx config example > ocx.config.json
      처음 쓸 때 예시 설정 파일 만들기
  ocx config keys
      모든 설정 항목의 의미와 기본값

알아 둘 점
  - 설정 파일은 JSON입니다. 모델 3개를 등록해 두고 --model 로 실행할 때 하나를 고릅니다.
  - API 키는 화면에 그대로 출력하지 않습니다 (EMPTY 제외).

원본 opencode와의 관계: 원본 opencode의 설정(opencode.json)은 건드리지 않습니다. ocx가 실행할 때마다 환경변수로 주입합니다.

관련: ocx guide 설정
```

### ocx guide

```text
ocx guide — 상황별 사용 가이드

사용법
  ocx guide
  ocx guide <주제>

예시
  ocx guide 저녁에맡기기
      퇴근 전에 하는 일을 순서대로

원본 opencode와의 관계: ocx 전용 기능입니다.
```

## 설정 항목 (`ocx config keys`)

```text
opencode.command              원본 OpenCode 실행 명령(문자열 배열). 예: ["opencode"] 또는 ["C:/tools/opencode.exe"]. './opencode.exe' 처럼 상대 경로는 설정 파일이 있는 폴더 기준입니다
                              기본값: 생략하면 ocx 실행 파일과 같은 폴더의 opencode(.exe), 없으면 PATH 의 opencode
models.<이름>.baseURL           모델 서버 주소 (http:// 또는 https://). OpenAI 호환 API의 /v1 까지
models.<이름>.model             서버에 보낼 모델 ID
models.<이름>.apiKey            API 키 (키가 필요 없는 서버는 EMPTY)
                              기본값: "EMPTY"
models.<이름>.contextLimit      모델 컨텍스트 길이(토큰). 참조 분석 단위 크기와 컨텍스트 사용량 판단에 쓰임
                              기본값: 32768
models.<이름>.outputLimit       한 번에 낼 수 있는 최대 출력 토큰
                              기본값: 4096
models.<이름>.extraBody         이 모델로 가는 모든 요청 본문에 덧붙일 JSON 필드 (서버별 옵션)
defaultModel                  --model을 주지 않을 때 쓸 모델 이름
                              기본값: models의 첫 번째
smallModel                    제목 생성 같은 보조 호출에 쓸 모델 (가벼운 모델을 지정하면 본 모델의 부하가 줄어듦)
                              기본값: 본 모델과 같음
closedNetwork                 폐쇄망 설정(외부 호출 차단 플래그, 웹 도구 차단) 적용 여부
                              기본값: true
profilesDir                   사용자 정의 프로필 폴더 (같은 이름이면 내장 프로필보다 우선)
referenceDir                  참조 자료 폴더 이름 (작업 폴더 기준)
                              기본값: "reference"
day.attemptBudgetMinutes      낮 모드: 한 번의 시도에 허용하는 시간(분). 평소 2~3분 걸리는 작업이면 10분 정도
                              기본값: 10
day.streamIdleSeconds         낮 모드: 응답이 나오기 시작한 뒤 이 시간(초) 동안 멈추면 정체로 판단
                              기본값: 120
day.firstTokenWaitSeconds     낮 모드: 첫 토큰을 기다리는 최대 시간(초). 서버 대기열 순서를 잃지 않도록 길게
                              기본값: 300
day.maxAttempts               낮 모드: 이어하기·새 세션으로 재시도하는 최대 횟수
                              기본값: 4
day.contextRenewRatio         낮 모드: 프롬프트가 컨텍스트 한도의 이 비율을 넘으면 새 세션으로 이어감 (0~1)
                              기본값: 0.7
day.loopThreshold             낮 모드: 같은 도구 호출/오류가 연속 이 횟수 반복되면 루프로 판단
                              기본값: 3
day.lightBody                 가볍게 실행할 때 요청 본문에 덧붙일 JSON (예: Qwen3 사고 모드 해제 {"chat_template_kwargs":{"enable_thinking":false}})
                              기본값: {}
night.windowStart             밤 모드: 야간 창 시작 시각. 이 전에 시작하면 열릴 때까지 대기 (--now로 건너뜀)
                              기본값: "19:00"
night.endTime                 밤 모드: 종료 시각. 이 시각이 되면 안전하게 멈추고 리포트를 씀
                              기본값: "07:00"
night.attemptBudgetMinutes    밤 모드: 작업 하나를 구현하는 한 번의 시도에 허용하는 시간(분)
                              기본값: 30
night.streamIdleSeconds       밤 모드: 응답 중간 정체로 볼 시간(초)
                              기본값: 600
night.firstTokenWaitSeconds   밤 모드: 첫 토큰을 기다리는 최대 시간(초)
                              기본값: 1800
night.maxAttempts             밤 모드: 한 번의 감독 실행 안에서 재시도하는 최대 횟수
                              기본값: 6
night.contextRenewRatio       밤 모드: 프롬프트가 컨텍스트 한도의 이 비율을 넘으면 새 세션으로 이어감 (0~1)
                              기본값: 0.7
night.loopThreshold           밤 모드: 같은 도구 호출/오류가 연속 이 횟수 반복되면 루프로 판단
                              기본값: 3
night.lightBody               밤 모드: 가볍게 재시도할 때 요청 본문에 덧붙일 JSON (day.lightBody와 같은 형식)
                              기본값: {}
night.maxFixRounds            밤 모드: 검증·점검 실패 후 다시 고치게 하는 최대 횟수
                              기본값: 3
night.verifyTimeoutMinutes    밤 모드: 검증 명령 하나당 시간 제한(분). Java 빌드가 느리면 늘리세요
                              기본값: 30
night.taskBudgetMinutes       밤 모드: 작업 하나에 쓸 수 있는 총 시간(분). 넘으면 보류
                              기본값: 180
night.patienceInitialSeconds  밤 모드: 서버 문제로 멈췄을 때 처음 기다리는 시간(초). 이후 두 배씩 늘어남
                              기본값: 30
night.patienceMaxSeconds      밤 모드: 기다리는 시간의 상한(초)
                              기본값: 600
night.selfCheck               밤 모드: 검증 통과 후 완료 기준을 한 번 더 대조 점검할지
                              기본값: true
night.scope                   밤 모드: 계획서 범위 밖 변경 처리. warn(리포트에 표시) / strict(되돌림)
                              기본값: "warn"
night.backupMaxMB             밤 모드: 작업 전 백업 용량 상한(MB). 넘으면 대상 파일만 백업
                              기본값: 500
night.fastWindow              밤 모드: 빠른 시간대 활용 {enabled,start,end}. 켜면 빠른 시간대에 무거운 작업을 먼저
                              기본값: {"enabled":false,"start":"01:00","end":"07:00"}
safety.extraBlocked           추가로 금지할 명령 이름 목록(첫 단어 기준). Git 금지, 권한 상승·시스템·외부 네트워크·배포 명령 차단은 항상 적용됩니다. 예: ["docker", "kubectl"]
                              기본값: []
auto.slowFirstTokenSeconds    오토 모드: 최근 첫 토큰 중앙값이 이 시간(초)을 넘으면 서버가 느리다고 판단
                              기본값: 20
auto.slowTokensPerSec         오토 모드: 최근 초당 토큰 중앙값이 이보다 낮으면 느리다고 판단
                              기본값: 8
auto.recoverFactor            오토 모드: 느림에서 빠름으로 돌아가려면 기준의 이 비율 이하여야 함 (모드가 오락가락하지 않게 하는 완충)
                              기본값: 0.7
auto.lookbackHours            오토 모드: 속도를 볼 최근 기간(시간)
                              기본값: 6
auto.minSamples               오토 모드: 판단에 필요한 최소 측정 기록 수. 모자라면 '알 수 없음'으로 보고 보수적으로 판단
                              기본값: 3
```

## 만드는 방법과 배포 (개발자용)

```text
cd manager
bun install
bun test                                   # 전체 테스트 (원본 opencode 소스가 있으면 end-to-end 포함)

# 1) ocx 실행 파일
bun run scripts/build-ocx.ts --target windows-x64         # 구형 CPU(AVX2 없음): windows-x64-baseline

# 2) 원본 opencode 실행 파일 (업스트림 소스를 먼저 받아 두세요)
bun run scripts/build-opencode.ts --src <업스트림 폴더> --target windows-x64
   - 모델 목록 스냅샷은 빈 JSON(build/models-empty.json)을 내장합니다. 빌드할 때 외부 접속(models.dev)이 필요 없습니다.
   - 폐쇄망 빌드 PC에서는 대상 플랫폼용 네이티브 패키지(@opentui/core-*, @ff-labs/fff-bin-*, @parcel/watcher)를 미리 설치하고 --skip-install 을 쓰세요.

# 3) 배포 폴더
bun run scripts/package.ts --ocx dist/ocx-windows-x64.exe --opencode dist/opencode-windows-x64.exe --target windows-x64
   → dist/ocx-windows-x64-package/ (ocx.exe, opencode.exe, 예시 설정, 먼저읽어주세요.txt, MANIFEST.txt)
```

프로필(`manager/profiles/`)을 고치면 `bun run scripts/gen-embedded.ts` 로 실행 파일에 내장되는 사본을 갱신하세요 (테스트가 어긋남을 알려 줍니다).

## 알려진 한계

- **Windows 실제 실행은 아직 검증하지 못했습니다.** 개발과 검증은 Linux에서 했고, Windows용 실행 파일은 빌드까지만 확인했습니다. 프로세스 종료(`taskkill`), 고아 프로세스 정리(`tasklist`), Windows Terminal에서의 화면, 경로 처리는 처음 쓰실 때 확인이 필요합니다.
- 서버 자체의 느림은 해결할 수 없습니다. 낮 모드는 낭비를 줄이고 멈추지 않게 하는 기능입니다.
- 낮·오토 모드의 기준값(대기 시간, 느림 판단 기준 등)은 실측 전의 가정값입니다. `ocx stats` 로 실제 속도를 본 뒤 설정으로 조정하세요.
- 밤새 완성도는 모델의 도구 호출 품질과 계획서의 완료 기준·검증 명령에 달려 있습니다. 소프트웨어가 보장하는 것은 '끊기지 않고 이어가기', '검증으로 완료 판정', '막힌 작업은 보류하고 계속', '아침 리포트'까지입니다.
- Git 금지는 bash 명령 기준입니다. `python -c` 로 git을 부르거나 Makefile 안에서 git을 부르는 식의 간접 실행은 막지 못합니다.
- 사고(thinking) 모드를 끄는 등 서버별 옵션은 `day.lightBody` / `night.lightBody` / `models.<이름>.extraBody` 로 직접 지정해야 하고, 사내 서버가 그 필드를 받는지는 확인이 필요합니다.
- 오토 모드는 실행을 시작할 때 한 번 판단하며, 실행 도중에 모드를 바꾸지 않습니다.
- 계획 모드의 '열린 질문' 대화는 터미널에서만 됩니다 (원본의 질문 도구는 비대화형 실행에서 막혀 있어 ocx가 직접 묻습니다).
- 밤 모드는 작업을 한 번에 하나씩 순서대로 실행합니다 (서버 부하를 고려한 선택). 병렬 실행은 하지 않습니다.
- 검증 명령이 띄운 서버가 사용하던 포트가 이미 점유된 경우를 사전에 점검하지 않습니다.
