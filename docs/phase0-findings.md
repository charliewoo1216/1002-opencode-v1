# 단계 0 기반 확인 결과

기준: 업스트림 `sst/opencode` 커밋 `ecc4916`(2026-10-06), Bun 1.4.2(저장소 요구 1.3.14), 테스트 환경 Linux x64. LLM은 `manager/test/mock-llm.ts`의 모의 서버 사용.

## 1. 요약

| 항목 | 결과 |
|---|---|
| 의존성 설치 | 성공. 웹/터미널 패키지 2개(`@solidjs/start`, `ghostty-web`)만 403 실패 → CLI와 무관 |
| 소스 실행 | 성공 (`bun run ./src/index.ts --help`) |
| Windows x64 exe 빌드 | **성공**: `opencode.exe` PE32+ x64, 약 122MB |
| 모의 LLM 연결 | 성공. 스트리밍, 도구 호출, 세션 이어하기 동작 |
| 모델 3종 등록·선택 | 성공 (`-m 프로바이더/모델`) |
| 외부 호출 | `OPENCODE_DISABLE_MODELS_FETCH=1`이 없으면 `models.opencode.ai:443`으로 접속 시도(6회), 설정하면 0건 (`run` 경로) |

## 2. 빌드

- 업스트림 `build.ts`에는 타깃 선택 옵션이 없다. `--single`은 **현재 플랫폼만** 빌드한다. Windows exe를 만들려면 타깃 목록을 Windows x64로 줄인 사본 스크립트가 필요하다(실험에서는 `targets`를 `win32/x64/avx2 없음`으로 필터링).
- 웹 UI 임베드는 `--skip-embed-web-ui`로 생략한다(웹 UI 빌드에는 위의 실패 패키지가 필요).
- 빌드 중 `bun install --os="*" --cpu="*"`로 타 플랫폼용 네이티브 패키지(`@opentui/core`, `@parcel/watcher`, `@ff-labs/fff-bun`)를 받는다 → **폐쇄망 빌드 환경에서는 이 패키지를 사전 확보**해야 한다. 없으면 `Could not resolve "@opentui/core-win32-x64"` 오류로 실패(실험에서 확인).
- baseline(AVX2 없는 CPU) 타깃도 같은 방식으로 빌드 가능할 것으로 보이나 이번에는 시도하지 않았다.
- 빌드 시 모델 목록 스냅샷을 exe에 내장한다(`Loaded models.dev snapshot`).

## 3. `opencode run` 동작 (관리 프로그램 설계에 영향)

1. **stdin을 닫고 실행해야 한다.** `run.ts:416`에서 stdin이 TTY가 아니면 `Bun.stdin.text()`로 EOF까지 읽는다. stdin이 열려 있으면 **영원히 대기**한다(실험에서 120초/60초 정체 재현). 관리 프로그램은 항상 stdin을 `ignore`(또는 즉시 닫힘)로 실행한다.
2. **`--format json` 이벤트 스트림**(줄 단위 JSON): `step_start`, `text`, `tool_use`(도구명·입력·출력·상태·종료 코드), `step_finish`(`reason`: `stop`/`tool-calls`, 토큰 수). → 진행·정체·반복 감지와 첫 응답 시간·속도 측정의 근거로 사용 가능.
3. **요청이 2개로 나뉜다**: 제목 생성(`agent=title`, 도구 없음, `small_model` 사용)과 본 작업. `small_model`을 별도 모델로 지정하면 본 모델과 분리된다(실험에서 제목 요청이 `small_model` 쪽으로 감을 확인).
4. **`--continue`**로 마지막 세션을 이어서 실행할 수 있다(`-s <id>`로 지정도 가능). 재개 시 대화가 이어지는지는 모의 서버로 요청 수까지만 확인했고, 실제 모델 맥락 이어짐은 실서버에서 확인 필요.
5. **프로세스를 종료하면 서버 쪽에서 연결 취소가 감지된다**(모의 서버 기준). 실제 vLLM이 취소를 처리하는지는 미확인 `[가정]`.
6. **권한**: `--auto`(`--yolo`, `--dangerously-skip-permissions`)가 없으면 권한 요청은 자동 거부된다. 실험의 `bash echo` 명령은 옵션 없이도 실행됐다(기본 권한이 허용). 위험 명령 차단은 설정/`OPENCODE_PERMISSION`으로 별도 지정이 필요하다.
7. **질문 도구는 `run`(비대화형)에서 사용할 수 없다**: 비대화형이면 `question`, `plan_enter`, `plan_exit` 권한이 거부로 고정된다. → 계획 모드의 "대화형 질문"은 **대화형 세션(TUI/mini)** 에서만 가능하다. 설계 반영: 계획 모드는 대화형 세션을 띄우거나, 관리 프로그램이 질문을 직접 처리하는 방식 중 선택해야 한다.

## 4. 설정

- 설정 주입 수단: `OPENCODE_CONFIG_CONTENT`(JSON 문자열), `OPENCODE_CONFIG`(파일), `OPENCODE_CONFIG_DIR`, `OPENCODE_PERMISSION`(권한 JSON), `OPENCODE_TEST_HOME`(홈 격리). 관리 프로그램이 **환경변수로 설정을 주입**해 원본 설정 파일을 건드리지 않을 수 있다.
- 프로바이더: `npm: "@ai-sdk/openai-compatible"` + `options.baseURL`/`apiKey` + `models.<id>.limit` 형식으로 3종을 등록하고 `-m provider/model`로 선택하는 것이 동작한다.
- 에이전트 설정 키(`agent.<이름>`): `model`, `prompt`(시스템 프롬프트), `steps`, `permission`, `mode`, `description` 등을 지원한다. 에이전트는 설정 디렉터리의 마크다운 파일로도 정의할 수 있다.

## 5. 폐쇄망

- 외부 호출 확인 방법: `HTTP(S)_PROXY`를 싱크 프록시(`manager/test/net-sink.ts`)로 지정해 나가려는 모든 연결을 기록.
- 결과(`run` 경로, 헤드리스): 플래그 없음 → `models.opencode.ai:443` 6회 시도. 아래 플래그 적용 → **0건**.
  `OPENCODE_DISABLE_MODELS_FETCH`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_SHARE`, `OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`
- 이 중 모델 목록 조회만 이번 실험에서 실제 호출이 관측됐고, 나머지 플래그는 예방 목적이다.
- **미검증**: TUI 경로(업데이트 확인 등), 플러그인·MCP, 도구 실행 시 LSP 다운로드, 웹 검색·웹 가져오기 도구. 단계 6의 폐쇄망 검증에서 다시 확인한다.

## 6. 확인된 환경 제약

- 이 환경은 Linux이며 Windows 실행·실제 LLM이 없다. exe는 **빌드까지만** 확인했고 Windows 실행 확인은 사용자 확인 과제다.
- 업스트림 클론에서 `bun install`/빌드 시 `package.json`과 락 파일이 변경됐을 수 있다(실험용 클론이며 이 저장소에는 포함하지 않는다).

## 7. 계획서에 미치는 영향

| 항목 | 반영 |
|---|---|
| 관리 프로그램의 `run` 실행 | 항상 stdin 닫기, `--format json`으로 이벤트 감시 |
| 설정 주입 | 환경변수 방식 채택 가능 |
| 폐쇄망 | `OPENCODE_DISABLE_MODELS_FETCH=1`을 기본 적용에 필수로 포함 |
| 계획 모드 질문 | 비대화형 `run`에서는 불가 → 대화형 방식 별도 설계 필요 (결정 필요) |
| 폐쇄망 빌드 | 타 플랫폼 네이티브 패키지와 모델 데이터 사전 확보 필수 |
| 빌드 스크립트 | Windows x64 전용 사본 스크립트 필요(원본 `build.ts` 최소 변경) |

## 8. 단계 1 개발 중 추가 발견

1. **작업 폴더는 `process.env.PWD`로 결정된다** (`run.ts:333`). 자식 프로세스를 `cwd` 옵션만 주고 실행하면 부모의 `PWD`가 상속되어 **다른 폴더에 파일이 생성**된다(실제로 재현: 테스트용 `out.txt`가 관리 프로그램 폴더에 생성됨). 관리 프로그램은 항상 `PWD`를 대상 폴더로 지정한다. 무인 실행의 작업 폴더 한정 규칙(6단계)의 전제 조건이다.
2. **`text`/`reasoning` 이벤트는 해당 파트가 완료된 뒤(`time.end`)에만 발행된다** (`run.ts:753`, `766`). 한 번의 긴 생성 동안에는 이벤트가 전혀 없으므로, 이벤트 간격만으로는 "느리지만 정상 생성 중"과 "멈춤"을 구분할 수 없다. → LLM 앞단에 **로컬 측정 프록시**를 두어 SSE 청크 단위로 첫 토큰 시간, 속도, 정체를 판단한다(`manager/src/proxy.ts`).
3. **프록시가 정체 요청의 상류 연결을 끊으면 원본이 이를 오류로 보고 자체 재시도한다**(통합 테스트에서 호출 수 증가로 확인). 낮 모드의 "정체 시 자동 재요청"을 원본 내장 재시도에 얹어 구현할 수 있다. 단 재시도 횟수는 원본 한도(5회)를 따르므로 그 이후는 관리 프로그램이 처리해야 한다.
4. 프로세스 종료 시 프로세스 트리를 함께 종료해야 서버 쪽 연결이 닫힌다(모의 서버 기준). Windows에서는 `taskkill /T /F` 경로를 쓰며 **Windows 실기 검증 필요**.

## 9. 빌드 결함 발견: 모델 목록 스냅샷 (중요)

- 업스트림 `packages/opencode/script/generate.ts`는 빌드 때 `https://models.dev/api.json`을 **상태 코드를 확인하지 않고** 내려받아 그 텍스트를 실행 파일에 내장한다(`OPENCODE_MODELS_DEV`). 접속이 막히거나 오류 응답이 오면 **오류 본문이 그대로 내장**된다.
- 그렇게 만든 **컴파일된 바이너리는 실행 시 `TypeError: Object.entries requires that input parameter not be null or undefined`로 모든 실행이 실패**한다. 소스로 실행(`bun run`)할 때는 이 스냅샷을 쓰지 않아 증상이 나타나지 않으므로, 컴파일 결과물을 따로 시험하지 않으면 발견하기 어렵다. (이 문서의 앞쪽 4단계에서 만든 Windows exe도 같은 문제를 가진다 — 다시 빌드해야 한다.)
- 해결: 환경변수 `MODELS_DEV_API_JSON`에 유효한 JSON 파일을 지정하면 `generate.ts`가 외부 접속 없이 그 파일을 쓴다. ocx는 프로바이더를 직접 정의하므로 **빈 객체 `{}`** 로 충분하며(`manager/build/models-empty.json`), 이렇게 하면 **폐쇄망 빌드 환경에서 모델 데이터를 사전에 확보할 필요도 없어진다**. 빈 스냅샷으로 다시 빌드한 Linux 바이너리로 end-to-end 테스트 전체(통합·계획·낮·밤·`kill -9` 복구·오토)가 통과함을 확인했다.
- 또 `--skip-install`을 쓰면 빌드 중 타 플랫폼 네이티브 패키지를 받는 단계(`bun install --os="*"`)를 건너뛸 수 있으나, 대상 플랫폼용 네이티브 패키지(`@opentui/core-win32-x64`, `@ff-labs/fff-bin-win32-x64`, `@parcel/watcher` 등)가 이미 설치되어 있어야 한다. 폐쇄망 빌드 환경에서는 이 패키지들을 사전에 확보해야 한다.
- TUI 경로의 외부 호출 검증(컴파일된 Linux 바이너리, 가상 터미널 15초): 폐쇄망 환경변수를 주면 외부 접속 0건, 주지 않으면 `models.opencode.ai:443`로 1건 시도. 플러그인·MCP·LSP 실제 사용 중의 호출은 검증하지 못했다.
