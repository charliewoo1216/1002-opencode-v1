# ocx 최종 결과물 (Windows x64)

이 폴더에 **바로 쓸 수 있는 실행 파일과 설정 예시, 설명서**가 있습니다. (만든 날: 2026-10-07)

## 이게 뭔가요?

| 파일 | 정체 |
|---|---|
| **`ocx.exe`** | **우리가 개발한 프로그램.** 계획서 만들기, 낮에 멈춤 감지·자동 재시도, 퇴근 후 밤새 진행, 아침 리포트를 합니다. 이것만 직접 실행합니다. |
| `opencode.exe` | 원본 OpenCode (소스 수정 없음, 폐쇄망용으로 Windows 빌드만 함). `ocx.exe`가 내부에서 부릅니다. |

둘 다 필요하고, 같은 폴더에 두면 됩니다. 자세한 설명은 `docs/user-guide.md`.

## 1. 내려받기 (파일이 커서 4조각으로 나눠 놓았습니다)

GitHub은 파일 하나가 100MB를 넘으면 올릴 수 없어서, 실행 파일 묶음(zip, 약 87MB)을 23MB 조각 4개로 나눴습니다.

1. `windows-x64/` 폴더의 파일을 **모두** 한 폴더에 받습니다.
   - `ocx-package.zip.part00` ~ `part03` (4개), `join-parts.bat`, `SHA256SUMS.txt`
   - GitHub에서 각 파일을 열고 **Download raw file** 버튼을 누르거나, 저장소 전체를 clone/ZIP으로 받아도 됩니다.
2. `join-parts.bat` 을 더블클릭합니다. → `ocx-windows-x64-package.zip` 이 만들어집니다.
   (직접 하려면 명령 프롬프트에서: `copy /b ocx-package.zip.part00 + ocx-package.zip.part01 + ocx-package.zip.part02 + ocx-package.zip.part03 ocx-windows-x64-package.zip`)
3. 화면에 나오는 해시(SHA-256)의 앞 16자리가 `SHA256SUMS.txt` 의 마지막 줄과 같은지 확인합니다 (`644bbcce10446fbe...`).
4. zip의 압축을 풉니다. 안에 `ocx.exe`, `opencode.exe`, `ocx.config.example.json`, `README.txt`, `docs\user-guide.md`, `profiles-example\`, `MANIFEST.txt` 가 있습니다.

## 2. 설정 (JSON 파일)

1. 압축을 푼 폴더에서 `ocx.config.example.json` 을 **`ocx.config.json`** 으로 복사합니다.
2. 메모장으로 열어 `models` 의 `baseURL` 과 `model` 을 사내 LLM 서버에 맞게 고칩니다.
   - 주소는 `http://서버주소:포트/v1` 형식이고 http도 됩니다.
   - API 키가 필요 없는 서버는 `"apiKey": "EMPTY"` 를 그대로 둡니다.
   - 모델 3개(`qwen38`, `oss`, `qwen25coder`)를 등록해 두고, 실행할 때 `--model 이름` 으로 하나를 고릅니다. 안 고르면 `defaultModel` 이 쓰입니다.
3. `opencode.command` 는 같은 폴더의 `opencode.exe` 를 가리키도록 이미 되어 있습니다.
4. 모든 설정 항목의 설명: `ocx.exe config keys`

## 3. 처음 써 보기

Windows Terminal(또는 명령 프롬프트)에서 압축을 푼 폴더로 이동한 뒤:

```
ocx.exe config check --online       설정과 모델 서버 연결 점검
ocx.exe --help                      전체 도움말 (명령별: ocx.exe <명령> --help, 가이드: ocx.exe guide)
ocx.exe day "한 가지 작업 지시"        낮: 멈추면 자동으로 이어서/새 세션으로 재시도
ocx.exe plan --profile python "지시"  계획서 만들기 (참조 자료는 작업 폴더의 reference\ 에)
ocx.exe night                        퇴근 전에 걸어 두면 밤새 진행 (기본 07:00 종료)
ocx.exe report                       아침에 결과 보기
```

`--dir 작업폴더` 로 작업할 폴더를 지정할 수 있고, 지정하지 않으면 현재 폴더를 씁니다.

## 4. 알아 둘 점

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
└─ windows-x64/                실행 파일 묶음(4조각), join-parts.bat, SHA256SUMS.txt, MANIFEST.txt
```

## 6. 이 파일들을 만든 방법

| 항목 | 값 |
|---|---|
| 원본 OpenCode | `sst/opencode` 커밋 `ecc4916` (2026-10-06), 소스 수정 없음 |
| 만든 곳 | 이 저장소 `manager/` (Bun + TypeScript). `manager/scripts/` 의 빌드·배포 스크립트로 생성 |
| 다시 만들기 | `docs/user-guide.md` 의 "만드는 방법과 배포" |
| 개발 기록 | 저장소 `docs/dev-checklist.md`, `docs/phase0-findings.md` |
