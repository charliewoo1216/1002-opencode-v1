import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMAND_NAMES, main } from "../src/cli"
import { maskedConfig, runChecks } from "../src/cli-config"
import { parseArgs } from "../src/args"
import { AUTO_DEFAULTS, DAY_DEFAULTS, NIGHT_DEFAULTS, normalizeConfig } from "../src/config"
import { CONFIG_DOCS, exampleConfig, renderConfigKeys } from "../src/config-doc"
import { COMMANDS, COMMAND_HELP_NAMES, GUIDE_TOPICS, renderCommandHelp, renderGuide, renderOverview } from "../src/help"
import { startMockLlm } from "./mock-llm"

async function run(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const ol = console.log
  const oe = console.error
  console.log = (m: string) => void out.push(String(m))
  console.error = (m: string) => void err.push(String(m))
  try {
    return { code: await main(args), out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = ol
    console.error = oe
  }
}

describe("개요 도움말", () => {
  const text = renderOverview()

  test("처음 쓰는 순서, 모든 명령, 하고 싶은 일 표, 모드 비교, 공통 규칙이 들어 있다", () => {
    expect(text).toContain("처음 쓰는 순서")
    for (const c of COMMAND_HELP_NAMES) expect(text).toContain(`ocx ${c}`)
    expect(text).toContain("하고 싶은 일 → 쓸 명령")
    expect(text).toContain("모드 비교")
    expect(text).toContain("항상 적용되는 규칙")
    expect(text).toContain("Git 명령은 전부 막습니다")
    expect(text).toContain("원본 opencode 명령으로 그대로 전달")
  })

  test("인자 없이 실행하거나 --help 를 주면 개요를 보여 준다", async () => {
    expect((await run([])).out).toContain("처음 쓰는 순서")
    expect((await run(["--help"])).out).toContain("처음 쓰는 순서")
    expect((await run(["help"])).code).toBe(0)
  })
})

describe("명령별 도움말", () => {
  test("ocx가 처리하는 명령과 도움말 항목이 정확히 일치한다 (누락·유령 명령 방지)", () => {
    expect([...COMMAND_HELP_NAMES].sort()).toEqual(COMMAND_NAMES.filter((n) => n !== "help").sort())
  })

  test("모든 명령에 사용법·예시·원본과의 관계가 있고 예시는 ocx로 시작한다", () => {
    for (const c of COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(5)
      expect(c.usage.length).toBeGreaterThan(0)
      for (const u of c.usage) expect(u.startsWith("ocx")).toBe(true)
      for (const e of c.examples) expect(e.cmd.startsWith("ocx")).toBe(true)
      expect(c.origin.length).toBeGreaterThan(5)
      const h = renderCommandHelp(c.name)!
      expect(h).toContain("사용법")
      expect(h).toContain("원본 opencode와의 관계")
    }
    expect(renderCommandHelp("없는명령")).toBeNull()
  })

  test("도움말에 적힌 기본값은 코드의 실제 기본값에서 가져온다", () => {
    const day = renderCommandHelp("day")!
    expect(day).toContain(`첫 토큰 대기 ${DAY_DEFAULTS.firstTokenWaitSeconds}초`)
    expect(day).toContain(`응답 중간 정체 ${DAY_DEFAULTS.streamIdleSeconds}초`)
    expect(day).toContain(`최대 ${DAY_DEFAULTS.maxAttempts}회`)
    const night = renderCommandHelp("night")!
    expect(night).toContain(NIGHT_DEFAULTS.endTime)
    expect(night).toContain(NIGHT_DEFAULTS.windowStart)
    const auto = renderCommandHelp("auto")!
    expect(auto).toContain(`${AUTO_DEFAULTS.slowFirstTokenSeconds}초`)
    expect(auto).toContain(`${AUTO_DEFAULTS.minSamples}건`)
  })

  test("도움말에 적힌 옵션은 실제로 그 명령의 코드가 읽는 옵션이다 (문서와 동작 일치)", () => {
    const src = (f: string) => readFileSync(join(import.meta.dir, "../src", f), "utf8")
    const files: Record<string, string[]> = {
      plan: ["cli-plan.ts"], day: ["cli-day.ts"], night: ["cli-night.ts"], auto: ["cli-auto.ts"], report: ["cli-night.ts"],
      stats: ["cli.ts"], run: ["cli.ts"], profiles: ["cli-plan.ts"], config: ["cli-config.ts"], guide: [],
    }
    const common = src("cli-common.ts") + src("cli.ts")
    for (const c of COMMANDS) {
      const text = (files[c.name] ?? []).map(src).join("\n") + common
      for (const o of c.options) {
        const m = o.flag.match(/^--([a-z-]+)/)
        if (!m) continue
        const name = m[1]!
        const found = new RegExp(`flags\\.${name.replace("-", "\\-")}\\b|flags\\["${name}"\\]`).test(text) || new RegExp(`["']${name}["']`).test(text)
        expect({ cmd: c.name, flag: name, found }).toEqual({ cmd: c.name, flag: name, found: true })
      }
    }
  })

  test("ocx <명령> --help 와 ocx help <명령> 이 상세 도움말을 보여 준다", async () => {
    expect((await run(["plan", "--help"])).out).toContain("ocx plan —")
    expect((await run(["night", "--help"])).out).toContain("--dry-run")
    const h = await run(["help", "day"])
    expect(h.code).toBe(0)
    expect(h.out).toContain("ocx day —")
    const bad = await run(["help", "없는명령"])
    expect(bad.code).toBe(2)
    expect(bad.err).toContain("알 수 없는 명령")
  })
})

describe("사용 가이드", () => {
  test("주제 목록과 내용", () => {
    expect(renderGuide()).toContain("저녁에맡기기")
    for (const t of GUIDE_TOPICS) expect(renderGuide(t).length).toBeGreaterThan(100)
    expect(renderGuide("저녁에맡기기")).toContain(NIGHT_DEFAULTS.windowStart)
    expect(renderGuide("저녁")).toContain("퇴근 전")
    expect(renderGuide("계획서")).toContain("## 작업 T1: 제목")
    expect(renderGuide("없음없음")).toContain("알 수 없는 주제")
  })

  test("ocx guide 명령", async () => {
    expect((await run(["guide"])).out).toContain("주제를 골라")
    expect((await run(["guide", "안전규칙"])).out).toContain("Git")
  })
})

describe("설정 도움말", () => {
  test("모든 설정 항목에 설명이 있다 (설정 항목이 늘어나면 설명도 추가해야 한다)", () => {
    const eff = normalizeConfig({ models: { a: { baseURL: "http://h/v1", model: "m", extraBody: { x: 1 } } }, profilesDir: "p", smallModel: "a", day: {}, night: {}, auto: {} }) as unknown as Record<string, unknown>
    const documented = new Set(CONFIG_DOCS.map((d) => d.key))
    const missing: string[] = []
    for (const [k, v] of Object.entries(eff)) {
      if (k === "models") continue
      if (v && typeof v === "object" && !Array.isArray(v) && ["day", "night", "auto", "opencode", "safety"].includes(k)) {
        for (const sub of Object.keys(v as object)) if (!documented.has(`${k}.${sub}`)) missing.push(`${k}.${sub}`)
      } else if (!documented.has(k)) missing.push(k)
    }
    expect(missing).toEqual([])
    for (const k of ["baseURL", "model", "apiKey", "contextLimit", "outputLimit", "extraBody"]) expect(documented.has(`models.<이름>.${k}`)).toBe(true)
  })

  test("항목 설명의 기본값은 코드의 기본값과 같다", () => {
    const keys = renderConfigKeys()
    expect(keys).toContain(`기본값: ${NIGHT_DEFAULTS.verifyTimeoutMinutes}`)
    expect(keys).toContain("night.endTime")
    expect(CONFIG_DOCS.find((d) => d.key === "day.streamIdleSeconds")!.def).toBe(String(DAY_DEFAULTS.streamIdleSeconds))
  })

  test("예시 설정은 그대로 유효한 설정이다", () => {
    const cfg = normalizeConfig(JSON.parse(exampleConfig()))
    expect(Object.keys(cfg.models)).toEqual(["qwen38", "oss", "qwen25coder"])
    expect(cfg.day.lightBody).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })

  test("API 키는 화면에 가려서 보여 준다 (EMPTY 제외)", () => {
    const cfg = normalizeConfig({ models: { a: { baseURL: "http://h/v1", model: "m", apiKey: "secret-key" }, b: { baseURL: "http://h/v1", model: "m" } } })
    const m = maskedConfig(cfg) as any
    expect(m.models.a.apiKey).toBe("********")
    expect(m.models.b.apiKey).toBe("EMPTY")
    expect(JSON.stringify(m)).not.toContain("secret-key")
  })
})

describe("ocx config 명령과 점검", () => {
  const mock = startMockLlm(0)
  afterAll(() => mock.stop())
  const fake = join(import.meta.dir, "fake-opencode.ts")
  const setup = (models: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cfg-"))
    const file = join(dir, "ocx.config.json")
    writeFileSync(file, JSON.stringify({ opencode: { command: ["bun", "run", fake] }, models, ...extra }))
    return { dir, file }
  }

  test("config keys / example / show", async () => {
    expect((await run(["config", "keys"])).out).toContain("models.<이름>.baseURL")
    expect(JSON.parse((await run(["config", "example"])).out).defaultModel).toBe("qwen38")
    const { file } = setup({ a: { baseURL: "http://h/v1", model: "m", apiKey: "비밀" } })
    const shown = await run(["config", "show", "--config", file])
    expect(shown.out).not.toContain("비밀")
    expect(shown.out).toContain('"defaultModel": "a"')
    expect((await run(["config", "foo"])).code).toBe(2)
  })

  test("check: 모든 항목이 정상이면 통과, --online이면 모델 서버에 접속한다", async () => {
    const { dir, file } = setup({ a: { baseURL: `${mock.url}/v1`, model: "m" } })
    const before = mock.logs.length
    const offline = await run(["config", "check", "--config", file, "--dir", dir])
    expect(offline.code).toBe(0)
    expect(offline.out).toContain("점검을 통과했습니다")
    expect(offline.out).toContain("접속 확인은 --online")
    const online = await run(["config", "check", "--online", "--config", file, "--dir", dir])
    expect(online.code).toBe(0)
    expect(online.out).toContain("응답 정상")
    expect(online.out).toContain("작업 폴더 쓰기 가능")
    void before
  })

  test("check: 접속할 수 없는 서버, 없는 설정 파일, 잘못된 설정을 한글로 알린다", async () => {
    const { dir, file } = setup({ a: { baseURL: "http://127.0.0.1:1/v1", model: "m" } })
    const down = await run(["config", "check", "--online", "--config", file, "--dir", dir])
    expect(down.code).toBe(1)
    expect(down.out).toContain("✗ 모델 a")
    expect(down.out).toContain("접속할 수 없습니다")

    const missing = await run(["config", "check", "--config", join(dir, "없음.json")])
    expect(missing.code).toBe(1)
    expect(missing.out).toContain("설정 파일을 찾을 수 없습니다")

    const bad = setup({ a: { baseURL: "ftp://x", model: "m" } })
    const r = await run(["config", "check", "--config", bad.file, "--dir", bad.dir])
    expect(r.code).toBe(1)
    expect(r.out).toContain("baseURL")
  })

  test("check: 원본 opencode를 실행할 수 없으면 알린다", async () => {
    const { dir, file } = setup({ a: { baseURL: "http://h/v1", model: "m" } }, { opencode: { command: ["없는-프로그램-xyz"] } })
    const lines = await runChecks(parseArgs(["config", "--config", file, "--dir", dir]), false)
    expect(lines.some((l) => l.ok === false && l.text.includes("원본 opencode를 실행할 수 없습니다"))).toBe(true)
  })
})

describe("원본 opencode 전달", () => {
  test("ocx가 모르는 명령은 원본 opencode로 그대로 전달한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-pt-"))
    const file = join(dir, "ocx.config.json")
    writeFileSync(file, JSON.stringify({ opencode: { command: ["bun", "run", join(import.meta.dir, "fake-opencode.ts")] }, models: { a: { baseURL: "http://h/v1", model: "m" } } }))
    const argsFile = join(dir, "args.json")
    process.env.OCX_CONFIG = file
    process.env.FAKE_ARGS_FILE = argsFile
    try {
      const r = await run(["models", "--verbose", "x"])
      expect(r.code).toBe(0)
    } finally {
      delete process.env.OCX_CONFIG
      delete process.env.FAKE_ARGS_FILE
    }
    expect(JSON.parse(readFileSync(argsFile, "utf8")).args).toEqual(["models", "--verbose", "x"])
  })
})

describe("사용 설명서", () => {
  test("docs/user-guide.md 는 도움말에서 생성한 내용과 항상 같다 (도움말을 고치면 bun run scripts/gen-docs.ts 를 다시 실행해야 한다)", async () => {
    const { renderUserGuide } = await import("../scripts/gen-docs")
    const onDisk = readFileSync(join(import.meta.dir, "../../docs/user-guide.md"), "utf8")
    expect(onDisk).toBe(renderUserGuide())
  })

  test("설명서에 모든 명령과 가이드 주제, 알려진 한계가 들어 있다", async () => {
    const { renderUserGuide } = await import("../scripts/gen-docs")
    const doc = renderUserGuide()
    for (const c of COMMAND_HELP_NAMES) expect(doc).toContain(`### ocx ${c}`)
    for (const t of GUIDE_TOPICS) expect(doc).toContain(`ocx guide ${t}`)
    expect(doc).toContain("## 알려진 한계")
    expect(doc).toContain("Windows 실제 실행은 아직 검증하지 못했습니다")
  })
})
