import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collect, render } from "../scripts/gen-embedded"
import { EMBEDDED_PROFILES } from "../src/embedded-profiles.generated"
import { builtinProfilesDir, extractEmbeddedProfiles, listProfiles, loadProfile, ProfileError } from "../src/profile"

describe("프로필", () => {
  test("내장 프로필 4종을 읽는다 (지침·계획서 규칙·검증 명령)", () => {
    expect(listProfiles()).toEqual(["ai", "analysis", "java", "python"])
    const java = loadProfile("java")
    expect(java.description).toContain("Java")
    expect(java.instructions.some((f) => f.endsWith("AGENTS.md"))).toBe(true)
    expect(java.planningRules).toContain("작업 단위")
    expect(java.verify.test).toContain("mvn")
  })

  test("사용자 프로필이 같은 이름의 내장 프로필보다 우선하고, docs/*.md 는 지침으로 주입된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-pf-"))
    mkdirSync(join(dir, "java/docs"), { recursive: true })
    writeFileSync(join(dir, "java/profile.json"), JSON.stringify({ name: "java", description: "우리 회사 Java", verify: { test: "gradle test" } }))
    writeFileSync(join(dir, "java/AGENTS.md"), "# 사내 규약")
    writeFileSync(join(dir, "java/docs/b-spring.md"), "# 최신 기법 B")
    writeFileSync(join(dir, "java/docs/a-stack.md"), "# 스택 버전 A")
    writeFileSync(join(dir, "java/docs/memo.txt"), "무시")
    const p = loadProfile("java", dir)
    expect(p.description).toBe("우리 회사 Java")
    expect(p.instructions.map((f) => f.split(/[\\/]/).pop())).toEqual(["AGENTS.md", "a-stack.md", "b-spring.md"])
    expect(listProfiles(dir)).toContain("python") // 내장 프로필도 그대로 보임
  })

  test("없는 프로필과 깨진 profile.json 은 한글로 알린다", () => {
    expect(() => loadProfile("없음")).toThrow(ProfileError)
    expect(() => loadProfile("없음")).toThrow("찾을 수 없습니다")
    const dir = mkdtempSync(join(tmpdir(), "ocx-pf-"))
    mkdirSync(join(dir, "bad"), { recursive: true })
    writeFileSync(join(dir, "bad/profile.json"), "{깨짐")
    expect(() => loadProfile("bad", dir)).toThrow("올바른 JSON이 아닙니다")
    mkdirSync(join(dir, "noname"), { recursive: true })
    writeFileSync(join(dir, "noname/profile.json"), "{}")
    expect(() => loadProfile("noname", dir)).toThrow("name, description")
  })
})

describe("내장 프로필 (컴파일된 exe용)", () => {
  test("생성된 모듈이 profiles/ 폴더와 항상 일치한다 (프로필을 고치면 bun run scripts/gen-embedded.ts 를 다시 실행해야 한다)", () => {
    const disk = collect(join(import.meta.dir, "../profiles"))
    expect(EMBEDDED_PROFILES).toEqual(disk)
    expect(render(disk)).toContain("EMBEDDED_PROFILES")
  })

  test("캐시 폴더에 풀어 쓰고, 이미 풀려 있으면 다시 쓰지 않는다", () => {
    const base = mkdtempSync(join(tmpdir(), "ocx-emb-"))
    const dir = extractEmbeddedProfiles(base)
    expect(readFileSync(join(dir, "python/AGENTS.md"), "utf8")).toBe(EMBEDDED_PROFILES["python/AGENTS.md"]!)
    expect(existsSync(join(dir, ".complete"))).toBe(true)
    writeFileSync(join(dir, "python/AGENTS.md"), "수정됨")
    expect(extractEmbeddedProfiles(base)).toBe(dir) // 같은 경로
    expect(readFileSync(join(dir, "python/AGENTS.md"), "utf8")).toBe("수정됨") // 이미 풀려 있어 다시 쓰지 않음
  })

  test("OCX_FORCE_EMBEDDED 이면 소스 폴더가 있어도 내장본을 쓴다", () => {
    process.env.OCX_FORCE_EMBEDDED = "1"
    process.env.OCX_HOME = mkdtempSync(join(tmpdir(), "ocx-home-"))
    try {
      const dir = builtinProfilesDir()
      expect(dir.startsWith(process.env.OCX_HOME!)).toBe(true)
      expect(listProfiles()).toEqual(["ai", "analysis", "java", "python"])
      expect(loadProfile("ai").instructions[0]).toContain(process.env.OCX_HOME!)
    } finally {
      delete process.env.OCX_FORCE_EMBEDDED
      delete process.env.OCX_HOME
    }
  })
})
