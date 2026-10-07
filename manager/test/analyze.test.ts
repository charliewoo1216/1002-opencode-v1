import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  analyzeReference, checkNoteFormat, extractPathMentions, extractSummary, maxBytesForContext,
  readIndex, scanSourceFiles, splitIntoUnits, verifyAllNotes, verifyNote, type AnalysisUnit,
} from "../src/analyze"
import { createLogger } from "../src/logger"
import { layoutFor } from "../src/paths"
import { fakeConfig } from "./helpers"

const quiet = createLogger("error")

function makeWork() {
  const root = mkdtempSync(join(tmpdir(), "ocx-an-"))
  const ref = join(root, "reference")
  mkdirSync(join(ref, "api"), { recursive: true })
  mkdirSync(join(ref, "core"), { recursive: true })
  mkdirSync(join(ref, "node_modules/x"), { recursive: true })
  writeFileSync(join(ref, "api/Controller.java"), "class Controller {}")
  writeFileSync(join(ref, "api/Dto.java"), "class Dto {}")
  writeFileSync(join(ref, "core/service.py"), "def run(): pass")
  writeFileSync(join(ref, "README.md"), "# readme")
  writeFileSync(join(ref, "image.png"), "binary")
  writeFileSync(join(ref, "empty.py"), "")
  writeFileSync(join(ref, "node_modules/x/skip.js"), "skip")
  return { root, ref }
}

const goodNote = (title: string, files: string[]) =>
  `# ${title}\n## 개요\n설명\n## 구성 요소\n${files.map((f) => `- \`reference/${f}\`: 역할`).join("\n")}\n## 핵심 흐름\n흐름\n## 외부 의존\n없음\n## 주의점\n없음\n## 요약\n${title} 모듈 요약입니다.\n`

describe("파일 목록과 단위 분할", () => {
  test("텍스트 파일만, 제외 폴더·빈 파일 없이 정렬해서 뽑는다", () => {
    const { ref } = makeWork()
    const files = scanSourceFiles(ref)
    expect(files.map((f) => f.path)).toEqual(["README.md", "api/Controller.java", "api/Dto.java", "core/service.py"])
  })

  test("최상위 폴더별로 묶고 크기 상한을 넘으면 쪼갠다", () => {
    const f = (path: string, bytes: number) => ({ path, bytes, hash: path })
    const units = splitIntoUnits([f("a/1.py", 60), f("a/2.py", 60), f("a/3.py", 10), f("b/1.py", 10), f("top.md", 5)], 100)
    expect(units.map((u) => u.id)).toEqual(["루트", "a-1", "a-2", "b"])
    expect(units[1]!.files.map((x) => x.path)).toEqual(["a/1.py"])
    expect(units[2]!.files.map((x) => x.path)).toEqual(["a/2.py", "a/3.py"])
  })

  test("컨텍스트에서 단위 크기 상한을 추정한다", () => {
    expect(maxBytesForContext(32768)).toBe(Math.floor(32768 * 0.35 * 3))
    expect(maxBytesForContext(1000)).toBe(8000)
  })

  test("같은 입력은 같은 해시", () => {
    const { ref } = makeWork()
    const a = splitIntoUnits(scanSourceFiles(ref), 10000)
    const b = splitIntoUnits(scanSourceFiles(ref), 10000)
    expect(a.map((u) => u.hash)).toEqual(b.map((u) => u.hash))
  })
})

describe("노트 형식·경로 검증", () => {
  test("필수 제목 검사", () => {
    expect(checkNoteFormat(goodNote("m", ["a.py"]))).toEqual([])
    expect(checkNoteFormat("# m\n## 개요\n")).toContain('"## 요약" 항목이 없습니다')
  })

  test("요약 추출", () => {
    expect(extractSummary(goodNote("m", ["a.py"]))).toBe("m 모듈 요약입니다.")
  })

  test("백틱 경로 후보 추출", () => {
    expect(extractPathMentions("`src/A.java` 와 `B.py` 그리고 `1.2.3`, `foo bar.txt`, `함수()`")).toEqual(["src/A.java", "B.py"])
  })

  test("누락 파일과 존재하지 않는 경로를 잡아낸다", () => {
    const { root } = makeWork()
    const entry = { id: "api", hash: "h", files: ["api/Controller.java", "api/Dto.java"], status: "done" as const, noteFile: "api.md", summary: "", analyzedAt: "" }
    const note = goodNote("api", ["api/Controller.java"]) + "\n또한 `reference/api/Ghost.java` 를 쓴다.\n"
    const v = verifyNote(entry, note, { workRoot: root, referenceDir: "reference" })
    expect(v.uncoveredFiles).toEqual(["api/Dto.java"])
    expect(v.missingPaths).toEqual(["reference/api/Ghost.java"])
    expect(v.ok).toBe(false)
    const good = verifyNote(entry, goodNote("api", entry.files), { workRoot: root, referenceDir: "reference" })
    expect(good.ok).toBe(true)
  })
})

describe("분석 실행 (가짜 에이전트)", () => {
  const setup = () => {
    const { root, ref } = makeWork()
    const layout = layoutFor(root)
    const cfg = fakeConfig()
    const calls: string[] = []
    const runUnit = async (u: AnalysisUnit) => {
      calls.push(u.id)
      return { text: goodNote(u.id, u.files.map((f) => f.path)), endedBy: "exit" as const, exitCode: 0 }
    }
    const base = { cfg, layout, referenceRoot: ref, model: "a", log: quiet, runUnit, maxBytesPerUnit: 1_000_000 }
    return { root, ref, layout, calls, base }
  }

  test("전부 분석하고 노트와 색인을 저장한다", async () => {
    const { layout, calls, base } = setup()
    const rep = await analyzeReference(base)
    expect(rep.total).toBe(3) // (루트), api, core
    expect(rep.analyzed.length).toBe(3)
    expect(calls.length).toBe(3)
    const idx = readIndex(layout)!
    expect(Object.values(idx.units).every((u) => u.status === "done")).toBe(true)
    expect(existsSync(join(layout.notes, "INDEX.md"))).toBe(true)
    expect(readFileSync(join(layout.notes, "INDEX.md"), "utf8")).toContain("api")
  })

  test("바뀌지 않은 단위는 건너뛰고, 바뀐 단위만 다시 분석한다", async () => {
    const { ref, calls, base } = setup()
    await analyzeReference(base)
    calls.length = 0
    const again = await analyzeReference(base)
    expect(again.skipped.length).toBe(3)
    expect(calls.length).toBe(0)

    writeFileSync(join(ref, "core/service.py"), "def run():\n    return 1\n")
    const changed = await analyzeReference(base)
    expect(changed.analyzed).toEqual(["core"])
    expect(changed.skipped.length).toBe(2)
  })

  test("형식이 틀리면 문제를 알려 주며 재시도하고, 끝내 실패하면 실패로 기록한다", async () => {
    const { layout, base } = setup()
    const prompts: string[] = []
    let n = 0
    const rep = await analyzeReference({
      ...base,
      retries: 1,
      runUnit: async (u, prompt) => {
        prompts.push(prompt)
        n++
        // api 단위: 첫 시도는 형식 오류, 두 번째는 성공 / core 단위: 계속 실패
        if (u.id === "api" && n > 0 && prompts.filter((p) => p.includes("모듈 이름: api")).length >= 2) {
          return { text: goodNote(u.id, u.files.map((f) => f.path)), endedBy: "exit" as const, exitCode: 0 }
        }
        if (u.id === "core") return { text: "", endedBy: "stall" as const, exitCode: null }
        return u.id === "api"
          ? { text: "# api\n## 개요\n짧음", endedBy: "exit" as const, exitCode: 0 }
          : { text: goodNote(u.id, u.files.map((f) => f.path)), endedBy: "exit" as const, exitCode: 0 }
      },
    })
    expect(rep.failed.map((f) => f.id)).toEqual(["core"])
    expect(rep.analyzed).toContain("api")
    expect(prompts.some((p) => p.includes("이전 시도의 문제") && p.includes("## 요약"))).toBe(true)
    expect(readIndex(layout)!.units.core!.status).toBe("failed")
  })

  test("참조에서 사라진 단위는 색인에서 제거되고, 전체 검증이 동작한다", async () => {
    const { root, ref, layout, base } = setup()
    await analyzeReference(base)
    const { rmSync } = await import("node:fs")
    rmSync(join(ref, "core"), { recursive: true })
    const rep = await analyzeReference(base)
    expect(rep.removed).toEqual(["core"])
    const v = verifyAllNotes(layout, { workRoot: root, referenceDir: "reference" })
    expect(v.every((x) => x.ok)).toBe(true)
  })
})
