# ocx 최종 결과물 (Windows x64)

이 폴더에 **바로 쓸 수 있는 실행 파일과 설정 예시, 설명서**가 있습니다. (만든 날: 2026-10-07)

## 이게 뭔가요?

| 파일 | 정체 |
|---|---|
| **`ocx.exe`** | **우리가 개발한 프로그램.** 계획서 만들기, 낮에 멈춤 감지·자동 재시도, 퇴근 후 밤새 진행, 아침 리포트를 합니다. 이것만 직접 실행합니다. |
| `opencode.exe` | 원본 OpenCode (소스 수정 없음, 폐쇄망용으로 Windows 빌드만 함). `ocx.exe`가 내부에서 부릅니다. |

둘 다 필요하고, 같은 폴더에 두면 됩니다. 자세한 설명은 `docs/user-guide.md`.

## 1. 내려받기

실행 파일 묶음은 **`windows-x64/ocx-windows-x64-package.zip` 파일 하나**입니다 (약 87MB). AVX2가 없는 CPU(가상머신·구형 PC)에서도 도는 **baseline 빌드**입니다.

1. 저장소 전체를 내려받으면(clone 또는 ZIP) 이 파일이 들어 있습니다. 이 파일만 받으려면 GitHub에서 파일을 열고 **Download raw file** 을 누르세요.
2. (선택) 해시 확인: `certutil -hashfile ocx-windows-x64-package.zip SHA256` 의 결과가 `windows-x64/SHA256SUMS.txt` 와 같은지 봅니다.
3. zip의 압축을 풉니다. 안에 `ocx.exe`, `opencode.exe`, `ocx.config.example.json`, `README.txt`, `docs\user-guide.md`, `profiles-example\`, `MANIFEST.txt` 가 있습니다.

> 소스 코드는 저장소의 `manager/` 에 있고, 실행 파일은 `manager/scripts/` 의 스크립트로 다시 만들 수 있습니다 (`docs/user-guide.md` 의 "만드는 방법과 배포").

## 2. VS Code(또는 아무 터미널)에서 쓰려면 — PATH 등록과 설정 위치

`ocx`는 원본 `opencode`처럼 **프로젝트 폴더의 터미널에서 실행**하는 프로그램입니다. 명령 이름은 **`ocx`** 입니다 (`ocx.exe`).

**① PATH 등록 (한 번만)**
- 압축을 푼 폴더(`ocx.exe`와 `opencode.exe`가 있는 폴더, 예: `C:\tools\ocx`)를 Windows PATH에 추가합니다.
  시작 메뉴에서 "환경 변수" 검색 → "계정에 대한 환경 변수 편집" → 사용자 변수 `Path` → 편집 → 새로 만들기 → 폴더 경로.
- **VS Code를 완전히 종료했다가 다시 실행**해야 터미널에 반영됩니다.
- 원본 `opencode`를 이미 PATH에 등록해 두셨다면 그대로 두세요. `ocx`는 기본으로 `ocx.exe`와 **같은 폴더의 `opencode.exe`** 를 쓰고, 없으면 PATH의 `opencode`를 씁니다. PATH의 기존 `opencode`를 쓰고 싶으면 설정에 `"opencode": { "command": ["opencode"] }` 를 적으세요 (원본 버전이 다르면 일부 기능이 다르게 동작할 수 있습니다).

**② 설정 파일 (JSON) — 한 곳에 두고 모든 프로젝트가 같이 쓰기 (권장)**
1. `ocx.config.example.json` 을 **`ocx.config.json`** 으로 복사합니다 (예: `C:\tools\ocx\ocx.config.json`).
2. 메모장으로 열어 `models` 의 `baseURL` 과 `model` 을 사내 LLM 서버에 맞게 고칩니다.
   - 주소는 `http://서버주소:포트/v1` 형식이고 http도 됩니다.
   - API 키가 필요 없는 서버는 `"apiKey": "EMPTY"` 를 그대로 둡니다.
   - 모델 3개(`qwen38`, `oss`, `qwen25coder`)를 등록해 두고, 실행할 때 `--model 이름` 으로 하나를 고릅니다. 안 고르면 `defaultModel` 이 쓰입니다.
3. 사용자 환경 변수 **`OCX_CONFIG`** 를 그 파일의 전체 경로로 지정합니다. 그러면 어느 프로젝트 폴더에서 실행해도 설정을 찾습니다.
   - 프로젝트마다 다르게 쓰려면 그 프로젝트 폴더에 `ocx.config.json` 을 두거나 `--config 파일` 을 지정하세요. (`OCX_CONFIG` 도 `--config` 도 없으면 **현재 폴더**의 `ocx.config.json` 을 찾습니다.)
4. 모든 설정 항목의 설명: `ocx config keys`

## 3. 프로젝트에서 쓰기

VS Code로 프로젝트 폴더를 열고 **터미널(Ctrl+`)** 에서 바로 실행합니다. 작업 폴더는 터미널의 현재 폴더입니다.

```
ocx config check --online            설정과 모델 서버 연결 점검 (처음에 꼭 해 보세요)
ocx --help                            전체 도움말 (명령별: ocx <명령> --help,  가이드: ocx guide)
ocx day "한 가지 작업 지시"             낮: 멈추면 자동으로 이어서/새 세션으로 재시도
ocx day                               원본 화면을 멈춤에 대비한 상태로 열기 (평소 opencode 쓰듯이)
ocx plan --profile python "지시"       계획서 만들기 (참조 자료는 프로젝트의 reference\ 폴더에)
ocx night                             퇴근 전에 걸어 두면 밤새 진행 (기본 07:00 종료)
ocx report                            아침에 결과 보기
```

- 프로젝트 폴더에 `.plan/`(계획서), `.notes/`(참조 분석), `.batch/`(진행 상태·속도 기록·백업·리포트) 폴더가 만들어집니다. Git에 올리지 않으려면 `.gitignore`에 추가하세요.
- 평소처럼 원본 `opencode`를 그대로 쓰는 것도 가능합니다 (이때는 ocx의 기능이 적용되지 않습니다).

## 4. 알아 둘 점

- **도움말이 안 나오거나 실행이 안 될 때**: `ocx.exe version` 이 출력되는지 먼저 보세요. 안 되면 `docs/user-guide.md` 의 "문제 해결" 맨 위 5단계(PATH 확인, 종료 코드, 반입 파일 차단 해제 `Unblock-File`, 백신·AppLocker, 한글 깨짐)를 따라 확인하세요.

- **Windows 10/11에서 실제로 실행해 본 적은 없습니다.** Linux에서 개발·검증했고 Windows 실행 파일은 빌드까지만 확인했습니다. 처음 쓰실 때 `ocx.exe config check --online` 부터 해 보시고, 문제가 있으면 알려 주세요.
- 서명되지 않은 실행 파일이라 SmartScreen/백신 경고가 나올 수 있습니다.
- 낮·오토 모드의 기준값(대기 시간, 느림 판단 기준)은 실측 전 가정값입니다. 며칠 쓴 뒤 `ocx.exe stats` 로 실제 속도를 보고 설정으로 조정하세요.
- 사내 Qwen 서버가 사고(thinking) 모드를 끄는 옵션을 받는지는 확인하지 못했습니다 (`day.lightBody` 로 지정).
- Git 명령은 `ocx` 가 실행하지 않습니다. 커밋은 직접 하세요.
- 전체 한계 목록: `docs/user-guide.md` 의 "알려진 한계".

## 5. 폴더 구성

```
release/
├─ README.md                  (이 문서)
├─ ocx.config.example.json    설정 예시 (바로 열어볼 수 있게 따로 둠)
├─ docs/                       user-guide.md (사용 설명서), README-package.txt (zip 안에 들어 있는 안내문과 같음)
├─ profiles-example/           프로필 예시 (java, python, ai, analysis) — 직접 고쳐 쓰는 용도
└─ windows-x64/                ocx-windows-x64-package.zip (실행 파일 묶음), SHA256SUMS.txt, MANIFEST.txt
```

## 6. 이 파일들을 만든 방법

| 항목 | 값 |
|---|---|
| 원본 OpenCode | `sst/opencode` 커밋 `ecc4916` (2026-10-06), 소스 수정 없음 |
| 만든 곳 | 이 저장소 `manager/` (Bun + TypeScript). `manager/scripts/` 의 빌드·배포 스크립트로 생성 |
| 다시 만들기 | `docs/user-guide.md` 의 "만드는 방법과 배포" |
| 개발 기록 | 저장소 `docs/dev-checklist.md`, `docs/phase0-findings.md` |
