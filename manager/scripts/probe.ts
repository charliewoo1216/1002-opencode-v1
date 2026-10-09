// 진단용 프로그램 (ocx-probe.exe). ocx.exe 가 아무 출력 없이 끝날 때 어디서 막히는지 단계별로 확인한다.
// 각 단계 결과를 화면과 같은 폴더의 ocx-probe.log 에 즉시 기록하므로, 도중에 프로세스가 죽어도 마지막 기록이 남는다.
import { appendFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"

const logFile = join(dirname(process.execPath), "ocx-probe.log")
try {
  writeFileSync(logFile, "")
} catch {
  // 쓰기 권한이 없으면 화면 출력만 한다
}
const step = (msg: string) => {
  try {
    appendFileSync(logFile, msg + "\n")
  } catch {}
  process.stdout.write(msg + "\n")
}

step(`[1] 시작됨 (이 줄이 안 보이면 프로세스가 시작 직후 외부에서 막힌 것입니다)`)
step(`[2] 실행 파일: ${process.execPath} / ${process.platform} ${process.arch} / Bun ${Bun.version}`)
step(`[3] 한글 출력 시험: 가나다 ABC 123`)

const opencode = join(dirname(process.execPath), process.platform === "win32" ? "opencode.exe" : "opencode")
try {
  const r = spawnSync(opencode, ["--version"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] })
  step(`[4] opencode --version: 종료코드=${r.status} 출력=${(r.stdout ?? "").trim()} 오류=${r.error?.message ?? (r.stderr ?? "").trim()}`)
} catch (e) {
  step(`[4] opencode 실행 실패: ${e instanceof Error ? e.message : String(e)}`)
}

try {
  step(`[5] ocx 코드를 불러오는 중...`)
  const cli = await import("../src/cli")
  step(`[6] 불러오기 성공`)
  step(cli.versionText())
  step(`[7] 모든 단계 정상 — ocx.exe 코드 자체는 이 환경에서 동작합니다`)
} catch (e) {
  step(`[X] ocx 코드 불러오기/실행 실패: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
}
step(`로그 파일: ${logFile}`)
