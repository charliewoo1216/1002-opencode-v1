// 사용 설명서(docs/user-guide.md)를 도움말·설정 설명에서 생성한다. 도움말을 고치면 이 스크립트를 다시 실행한다.
// 사용: bun run scripts/gen-docs.ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { renderConfigKeys } from "../src/config-doc"
import { COMMANDS, GUIDES, GUIDE_TOPICS, renderCommandHelp, renderOverview } from "../src/help"

const fence = (s: string) => "```text\n" + s + "\n```"

export function renderUserGuide(): string {
  const parts: string[] = []
  parts.push("# ocx 사용 설명서", "")
  parts.push("> 이 문서는 `manager/scripts/gen-docs.ts` 로 도움말에서 자동 생성됩니다. 직접 고치지 말고 `manager/src/help.ts` 를 고친 뒤 `bun run scripts/gen-docs.ts` 를 실행하세요.", "")
  parts.push("## 이 프로그램이 하는 일", "")
  parts.push("`ocx` 는 폐쇄망·사내 LLM 환경에서 OpenCode(AI 코딩 에이전트)를 쓸 때의 두 가지 어려움을 덜어 주는 관리 프로그램입니다.")
  parts.push("- **낮**: 사용자가 몰려 서버가 느려지고 중간에 멈춰서, 사용자가 직접 중단하고 다시 시작해야 하는 문제 → 낮 모드가 정체·반복·시간 초과를 감지해 자동으로 이어서/새 세션으로 재시도합니다.")
  parts.push("- **밤**: 퇴근 후 맡겨 놓고 아침에 완성된 결과를 받고 싶은데 작업이 끊기는 문제 → 밤 모드가 승인된 계획서의 작업을 순서대로, 검증하며, 끝까지 진행합니다.")
  parts.push("원본 OpenCode는 수정하지 않고 `ocx` 가 감싸서 실행합니다. `ocx` 가 모르는 명령은 원본으로 그대로 전달됩니다.", "")

  parts.push("## 개요 도움말 (`ocx --help`)", "", fence(renderOverview()), "")

  parts.push("## 사용 가이드", "")
  for (const t of GUIDE_TOPICS) {
    parts.push(`### ${GUIDES[t]!.title}  (\`ocx guide ${t}\`)`, "", fence(GUIDES[t]!.body), "")
  }

  parts.push("## 명령 설명", "")
  for (const c of COMMANDS) parts.push(`### ocx ${c.name}`, "", fence(renderCommandHelp(c.name)!), "")

  parts.push("## 설정 항목 (`ocx config keys`)", "", fence(renderConfigKeys()), "")

  parts.push("## 만드는 방법과 배포 (개발자용)", "")
  parts.push("```text")
  parts.push("cd manager")
  parts.push("bun install")
  parts.push("bun test                                   # 전체 테스트 (원본 opencode 소스가 있으면 end-to-end 포함)")
  parts.push("")
  parts.push("# 1) ocx 실행 파일")
  parts.push("bun run scripts/build-ocx.ts --target windows-x64         # 구형 CPU(AVX2 없음): windows-x64-baseline")
  parts.push("")
  parts.push("# 2) 원본 opencode 실행 파일 (업스트림 소스를 먼저 받아 두세요)")
  parts.push("bun run scripts/build-opencode.ts --src <업스트림 폴더> --target windows-x64")
  parts.push("   - 모델 목록 스냅샷은 빈 JSON(build/models-empty.json)을 내장합니다. 빌드할 때 외부 접속(models.dev)이 필요 없습니다.")
  parts.push("   - 폐쇄망 빌드 PC에서는 대상 플랫폼용 네이티브 패키지(@opentui/core-*, @ff-labs/fff-bin-*, @parcel/watcher)를 미리 설치하고 --skip-install 을 쓰세요.")
  parts.push("")
  parts.push("# 3) 배포 폴더")
  parts.push("bun run scripts/package.ts --ocx dist/ocx-windows-x64.exe --opencode dist/opencode-windows-x64.exe --target windows-x64")
  parts.push("   → dist/ocx-windows-x64-package/ (ocx.exe, opencode.exe, 예시 설정, 먼저읽어주세요.txt, MANIFEST.txt)")
  parts.push("```", "")
  parts.push("프로필(`manager/profiles/`)을 고치면 `bun run scripts/gen-embedded.ts` 로 실행 파일에 내장되는 사본을 갱신하세요 (테스트가 어긋남을 알려 줍니다).", "")

  parts.push("## 알려진 한계", "")
  parts.push("- **Windows 실제 실행은 아직 검증하지 못했습니다.** 개발과 검증은 Linux에서 했고, Windows용 실행 파일은 빌드까지만 확인했습니다. 프로세스 종료(`taskkill`), 고아 프로세스 정리(`tasklist`), Windows Terminal에서의 화면, 경로 처리는 처음 쓰실 때 확인이 필요합니다.")
  parts.push("- 서버 자체의 느림은 해결할 수 없습니다. 낮 모드는 낭비를 줄이고 멈추지 않게 하는 기능입니다.")
  parts.push("- 낮·오토 모드의 기준값(대기 시간, 느림 판단 기준 등)은 실측 전의 가정값입니다. `ocx stats` 로 실제 속도를 본 뒤 설정으로 조정하세요.")
  parts.push("- 밤새 완성도는 모델의 도구 호출 품질과 계획서의 완료 기준·검증 명령에 달려 있습니다. 소프트웨어가 보장하는 것은 '끊기지 않고 이어가기', '검증으로 완료 판정', '막힌 작업은 보류하고 계속', '아침 리포트'까지입니다.")
  parts.push("- Git 금지는 bash 명령 기준입니다. `python -c` 로 git을 부르거나 Makefile 안에서 git을 부르는 식의 간접 실행은 막지 못합니다.")
  parts.push("- 사고(thinking) 모드를 끄는 등 서버별 옵션은 `day.lightBody` / `night.lightBody` / `models.<이름>.extraBody` 로 직접 지정해야 하고, 사내 서버가 그 필드를 받는지는 확인이 필요합니다.")
  parts.push("- 오토 모드는 실행을 시작할 때 한 번 판단하며, 실행 도중에 모드를 바꾸지 않습니다.")
  parts.push("- 계획 모드의 '열린 질문' 대화는 터미널에서만 됩니다 (원본의 질문 도구는 비대화형 실행에서 막혀 있어 ocx가 직접 묻습니다).")
  parts.push("- 밤 모드는 작업을 한 번에 하나씩 순서대로 실행합니다 (서버 부하를 고려한 선택). 병렬 실행은 하지 않습니다.")
  parts.push("- 검증 명령이 띄운 서버가 사용하던 포트가 이미 점유된 경우를 사전에 점검하지 않습니다.", "")
  return parts.join("\n")
}

if (import.meta.main) {
  writeFileSync(join(import.meta.dir, "../../docs/user-guide.md"), renderUserGuide())
  console.log("docs/user-guide.md 를 생성했습니다.")
}
