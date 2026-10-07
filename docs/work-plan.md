# OpenCode CLI 커스터마이징 작업 계획서 (초안 v0.2)

> 상태: 초안. 소스를 아직 가져오지 않았으므로 OpenCode 내부 구조·설정 키에 대한 내용은
> 확인 전 가정이며, 소스 확보 후 검증한다. 코드·설정은 모두 **예시(설계 스케치)** 이다.

## 1. 목적과 범위

- **목적**: OpenCode(`sst/opencode`, MIT)의 **CLI 패키지**를 가져와, 폐쇄망 + 로컬 LLM 환경에 맞게 수정한 Windows용 exe를 만든다.
- **포함**: CLI 패키지(`packages/opencode`)와 CLI가 의존하는 내부 패키지
- **제외**: 데스크톱 앱, 웹/문서 사이트, IDE 확장 (삭제하지 않고 빌드·CI 대상에서만 제외 — 업스트림 동기화 비용 최소화)
- **확정 사항**

| 항목 | 내용 |
|---|---|
| 실행 환경 | Windows 10 / 11 x64 전용 (exe) |
| 설정 | JSON 파일 기반 |
| 네트워크 | 폐쇄망, 외부 호출 없음 |
| LLM API | OpenAI 호환(추정), HTTP 전용, API 키는 고정 문자열 `EMPTY` |
| 모델 | Qwen 3.8 27B(최상), GPT-OSS(중간), Qwen 2.5 Coder(경량/코드) — 모델마다 접속 주소가 다름 |

## 2. 사전 점검

| 항목 | 내용 |
|---|---|
| 라이선스 | MIT: 수정·재배포 가능, 저작권 고지와 라이선스 사본 유지 필수 |
| 상표·브랜드 | 이름/로고 사용 가능 여부 확인, 필요 시 개명 |
| 업스트림 정책 | 독자 포크 vs 원본 기여 결정 |
| 의존성 | 사용 패키지 라이선스 확인 |
| 보안 | HTTP 평문 통신(소스 코드 포함 전송) → 폐쇄망 한정 사용 전제를 보안 담당자와 확인 |

## 3. 기능 정의

### 기능 1. 다중 모델 오케스트레이션

세 모델을 역할에 따라 복합적으로 사용한다. 장애 전환(failover)이 아니라 **역할 분담**이 핵심이다.

#### 3.1 구조 (3개 층)

| 층 | 역할 | 소스 수정 |
|---|---|---|
| 1. 모델 레지스트리 | 모델별 주소·ID·강점·컨텍스트 한도·도구 호출 가능 여부를 JSON에 정의 | 없음 (설정) |
| 2. 역할별 에이전트 | 에이전트마다 사용할 모델을 지정 (설계=Qwen 3.8, 구현=Qwen 2.5 Coder, 검토=GPT-OSS) | 거의 없음 (설정·프롬프트) |
| 3. 오케스트레이터 | 요청을 분석해 모델을 고르고 시나리오를 단계별로 실행 | **신규 모듈** |

#### 3.2 동작 모드

1. **자동 모드**: 요청 복잡도를 판단해 모델 선택. 규칙 기반으로 시작하고, 부족하면 경량 모델 분류 호출을 추가. 애매하면 상위 모델.
2. **지정 모드**: 프롬프트 접두 문법으로 모델 직접 지정. 예) `@qwen38 ...`, `@oss ...`
3. **시나리오 모드**: 저장된 파이프라인 실행. 예) `/scenario code-review`

#### 3.3 핵심 난제와 대응

| 난제 | 대응 |
|---|---|
| 모델 간 맥락 전달 (컨텍스트 길이·도구 호출 형식 차이) | 단계 간에는 전체 이력이 아니라 **산출물(요약·계획·변경 내용)만** 전달 |
| 자동 분배 정확도 | 보수적 분배, 분배 결과 로그로 규칙 개선 |
| 도구 호출 능력 차이 | 모델별 허용 도구 제한 |
| 지연·비용 증가 | 단순 요청은 단일 모델 직행 경로 유지 |
| 프롬프트 지시 오인식 | 명확한 접두 문법(`@모델`, `/scenario`)만 지시로 인식 |

#### 3.4 설정 예시: 모델 레지스트리 (`models.json`)

```json
{
  "models": {
    "qwen38": {
      "label": "Qwen 3.8 27B",
      "baseURL": "http://llm-a.internal:8000/v1",
      "model": "qwen3.8-27b",
      "apiKey": "EMPTY",
      "tier": "high",
      "contextLimit": 32768,
      "toolCalling": true,
      "strengths": ["설계", "추론", "복잡한 수정"]
    },
    "oss": {
      "label": "GPT-OSS",
      "baseURL": "http://llm-b.internal:8001/v1",
      "model": "gpt-oss",
      "apiKey": "EMPTY",
      "tier": "mid",
      "contextLimit": 32768,
      "toolCalling": true,
      "strengths": ["검토", "요약"]
    },
    "qwen25coder": {
      "label": "Qwen 2.5 Coder",
      "baseURL": "http://llm-c.internal:8002/v1",
      "model": "qwen2.5-coder",
      "apiKey": "EMPTY",
      "tier": "light",
      "contextLimit": 16384,
      "toolCalling": false,
      "strengths": ["코드 생성", "단순 질문"]
    }
  },
  "routing": {
    "default": "qwen38",
    "auto": {
      "enabled": true,
      "rules": [
        { "when": { "maxPromptChars": 200, "needsFileEdit": false }, "use": "qwen25coder" },
        { "when": { "keywords": ["설계", "아키텍처", "원인 분석"] }, "use": "qwen38" },
        { "when": { "keywords": ["검토", "리뷰", "요약"] }, "use": "oss" }
      ]
    }
  }
}
```

> 위 값(주소, 모델 ID, 한도, `toolCalling`)은 모두 **가정값**이다. 실제 서버에서 확인 후 채운다.

#### 3.5 설정 예시: 시나리오 (`scenarios/code-review.json`)

```json
{
  "name": "code-review",
  "description": "설계 → 구현 → 검토 3단계",
  "steps": [
    {
      "id": "design",
      "model": "qwen38",
      "prompt": "다음 요구사항의 구현 계획을 단계별로 작성하라:\n{{input}}",
      "tools": ["read"]
    },
    {
      "id": "implement",
      "model": "qwen25coder",
      "prompt": "다음 계획대로 코드를 작성하라:\n{{steps.design.output}}",
      "tools": []
    },
    {
      "id": "review",
      "model": "oss",
      "prompt": "계획과 코드를 비교해 문제점을 검토하라.\n계획:\n{{steps.design.output}}\n코드:\n{{steps.implement.output}}",
      "tools": ["read"],
      "approval": true
    }
  ],
  "onStepFailure": "stop"
}
```

#### 3.6 코드 예시: 오케스트레이터 핵심 (TypeScript 스케치)

```ts
// 모델 설정 타입
interface ModelConfig {
  baseURL: string;
  model: string;
  apiKey: string;
  tier: "high" | "mid" | "light";
  contextLimit: number;
  toolCalling: boolean;
}

// 요청에서 모델 지정 접두어(@모델명)를 추출한다
function parseDirective(prompt: string, models: Record<string, ModelConfig>) {
  const m = prompt.match(/^@(\w+)\s+([\s\S]*)$/);
  if (m && m[1] in models) {
    return { modelId: m[1], prompt: m[2] };
  }
  return { modelId: null, prompt };
}

// 자동 모드: 규칙 기반으로 모델을 선택한다 (애매하면 상위 모델)
function pickModel(prompt: string, rules: Rule[], fallback: string): string {
  for (const rule of rules) {
    if (matches(prompt, rule.when)) return rule.use;
  }
  return fallback;
}

// OpenAI 호환 API 호출 (HTTP, 키는 EMPTY)
async function chat(cfg: ModelConfig, messages: Message[]) {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, messages }),
  });
  if (!res.ok) throw new Error(`LLM 호출 실패: ${res.status}`);
  const data = await res.json();
  // 사고(thinking) 블록이 섞여 있으면 제거한다
  return stripThink(data.choices[0].message.content);
}

// 시나리오 실행: 단계 사이에는 산출물(output)만 전달한다
async function runScenario(sc: Scenario, input: string, models: Record<string, ModelConfig>) {
  const outputs: Record<string, string> = {};
  for (const step of sc.steps) {
    const prompt = render(step.prompt, { input, steps: outputs });
    const out = await chat(models[step.model], [{ role: "user", content: prompt }]);
    outputs[step.id] = out;
    if (step.approval && !(await askUser(`'${step.id}' 단계 결과를 승인하시겠습니까?`))) break;
  }
  return outputs;
}
```

#### 3.7 검증 시나리오

- 짧은 단순 질문 → 경량 모델로 분배되는지
- "설계/원인 분석" 요청 → Qwen 3.8로 분배되는지
- `@oss ...` 지정 시 해당 모델로만 호출되는지
- `/scenario code-review` 3단계가 끝까지 실행되고, 승인 단계에서 멈추는지
- 단계 간 전달된 산출물이 다음 모델의 컨텍스트 한도를 넘지 않는지
- 모델 하나를 꺼 두었을 때 오류 메시지가 명확한지

### 기능 2. 폐쇄망 대응 (외부 호출 제거)

| 항목 | 우려 | 대응 |
|---|---|---|
| 모델 목록 조회(models.dev 등) | 외부 호출 실패·지연 | 내장 JSON으로 대체 또는 차단 |
| 자동 업데이트 확인 | 외부 호출 | 비활성화 |
| 공유(share)·텔레메트리 | 외부 전송 | 제거 또는 비활성화 |
| 런타임 패키지 설치 | 프로바이더 SDK를 npm에서 받으려 할 수 있음 | exe에 번들 |
| 웹 검색·웹 가져오기 도구 | 폐쇄망에서 무의미, 보안 위험 | 비활성화 |
| LSP·MCP 자동 다운로드 | 외부 다운로드 | 비활성화 또는 사전 배포 |
| 프록시 환경변수 | 내부 API 호출이 프록시로 우회될 수 있음 | 내부 주소 예외 처리 |

**검증**: 외부 네트워크를 차단한 상태에서 실행하고, 패킷 캡처로 외부 호출이 0건인지 확인한다.

### 기능 3. JSON 설정 체계

- 설정 파일 위치(exe 옆 / `%USERPROFILE%` / 환경변수) 결정
- 원본의 다른 설정 경로 허용 여부 결정
- 프로바이더·외부 URL을 사용자가 임의로 바꾸지 못하게 잠글지 결정

## 4. 작업 단계

1. **소스 확보**: 업스트림 가져오기, 기준 버전(태그/커밋) 고정, 히스토리 유지 방식 결정
2. **빌드 환경 재현**: Bun 버전 고정, 원본 상태로 Windows exe 빌드 확인 (기준선)
3. **구조 파악**: CLI가 의존하는 내부 패키지 목록, 에이전트별 모델 지정 동작, 설정 로딩 경로 문서화
4. **설계 확정**: 기능 1~3의 설계 확정, 업스트림 수정 최소화 원칙 적용
5. **구현**: 기능 단위 브랜치, 커밋 분리 (1층·2층 설정 → 3층 오케스트레이터 → 폐쇄망 대응)
6. **테스트·검증**: 기존 테스트 통과, 기능별 검증 시나리오, Windows 10/11 실기 테스트
7. **패키징**: Windows x64 exe 빌드(필요 시 baseline), 버전 규칙, (선택) 코드 서명·인스톨러
8. **업스트림 동기화 체계**: 주기적 머지, 충돌 처리 규칙

### exe 빌드 정리

- Bun의 단일 실행 파일 컴파일(`bun build --compile`) 사용, 타깃은 Windows x64
- 구형 CPU(AVX2 없음) 대비 baseline 타깃 검토
- Windows 10은 1809 이상 필요(추정) — 사내 PC 빌드 버전 확인
- Windows Terminal 기준으로 TUI 동작 검증
- 코드 서명이 없으면 Defender/SmartScreen 경고 가능

## 5. 일정 (가안)

| 단계 | 기간 |
|---|---|
| 사전 점검·소스 확보 | 0.5주 |
| 빌드 재현·구조 파악 | 1주 |
| 설계 확정 | 1주 |
| 구현 (기능 1~3) | 3~5주 |
| 테스트·패키징 | 1~2주 |

## 6. 위험과 대응

| 위험 | 대응 |
|---|---|
| 업스트림 변경이 빨라 충돌 잦음 | 원본 수정 최소화, 신규 기능은 별도 모듈로 분리 |
| 27B급 모델의 도구 호출 불안정 | 도구 수 축소, 모델별 허용 도구 제한 |
| 컨텍스트 한계 | 시스템 프롬프트 축소, 단계 간 산출물만 전달 |
| 자동 분배 오판 | 보수적 규칙, 로그 기반 개선 |
| HTTP 평문 통신 | 폐쇄망 한정 사용 전제 문서화 |
| 라이선스·상표 | 사전 점검 단계에서 확인 |
| Windows 환경 차이 | Windows 10/11 실기 테스트 |

## 7. 미확정·확인 과제

1. 3개 모델 각각의 접속 주소, 모델 ID, 컨텍스트 길이, 도구 호출 지원 여부
2. API가 OpenAI 호환인지, 서버 종류(vLLM 등), 서버의 tool-call 파서 설정
3. 모델 사고(thinking) 모드 사용 여부
4. 역할 분담안(모델별 담당)과 자동 분배 기준
5. 시나리오 입력 방식(프롬프트 즉석 입력 / JSON 저장 호출) — 둘 다 지원 권장
6. 시나리오 단계별 사용자 승인 필요 여부
7. TUI 유지 여부(비대화형 명령만 남길지)
8. 업스트림 관계(독자 포크 / 기여), 배포 대상 범위, 코드 서명 여부
9. 기준 버전(최신 / 고정)
10. 사내 PC의 Windows 빌드 버전과 CPU(AVX2) 사양
