import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, parseArgs } from "../src/cli"

describe("인자 파싱", () => {
  test("명령, 옵션, 위치 인자를 나눈다", () => {
    const p = parseArgs(["run", "--model", "oss", "--continue", "고쳐줘", "버그를"])
    expect(p.command).toBe("run")
    expect(p.flags).toEqual({ model: "oss", continue: true })
    expect(p.positionals).toEqual(["고쳐줘", "버그를"])
  })

  test("-- 이후는 전부 위치 인자", () => {
    const p = parseArgs(["run", "--", "--model", "x"])
    expect(p.positionals).toEqual(["--model", "x"])
  })
})

describe("명령 처리", () => {
  test("등록되지 않은 모델은 한글 안내와 종료코드 2", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cli-"))
    const cfgFile = join(dir, "ocx.config.json")
    writeFileSync(cfgFile, JSON.stringify({ models: { a: { baseURL: "http://127.0.0.1:1/v1", model: "m" } } }))
    const errors: string[] = []
    const orig = console.error
    console.error = (m: string) => void errors.push(String(m))
    try {
      const code = await main(["run", "--config", cfgFile, "--dir", dir, "--model", "none", "지시"])
      expect(code).toBe(2)
    } finally {
      console.error = orig
    }
    expect(errors.join("\n")).toContain("등록되지 않은 모델")
  })

  test("설정 파일이 없으면 종료코드 2", async () => {
    const orig = console.error
    console.error = () => {}
    try {
      expect(await main(["run", "--config", "/없는/경로.json", "지시"])).toBe(2)
    } finally {
      console.error = orig
    }
  })

  test("stats는 기록이 없으면 안내 문구", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cli-"))
    const lines: string[] = []
    const orig = console.log
    console.log = (m: string) => void lines.push(String(m))
    try {
      expect(await main(["stats", "--dir", dir])).toBe(0)
    } finally {
      console.log = orig
    }
    expect(lines.join("\n")).toBe("기록이 없습니다.")
  })
})
