# dsearch

**내 문서를 로컬에서 검색하고, 찾은 근거를 원문으로 확인하세요.**

dsearch는 [QMD](https://github.com/tobi/qmd)를 검색 엔진으로 사용하는 로컬 문서 검색 도구입니다. Markdown 폴더를 등록하면 CLI와 웹 GUI에서 같은 문서를 찾고, 검색된 구간과 앞뒤 문맥을 읽을 수 있습니다.

> **Status: Alpha** · 현재 지원 환경은 macOS Apple Silicon입니다.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [CLI usage](#cli-usage)
- [Configuration](#configuration)
- [Data and privacy](#data-and-privacy)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Features

- **키워드 검색** — QMD의 전문 검색으로 등록된 문서를 찾습니다.
- **정확한 문자열 검색** — 식별자·코드·기호를 정규식 해석 없이 검색합니다.
- **원문 근거 확인** — 문서별 검색 근거와 줄 위치, 앞뒤 문맥을 확인합니다.
- **변경 감지** — 읽기 전에 원문 revision을 대조하고 오래된 결과의 재읽기를 거부합니다.
- **CLI와 GUI** — 같은 로컬 API와 문서·위치 계약을 사용합니다.
- **컬렉션 관리** — 폴더 등록, 검색 범위 선택, 사용 중지와 수동 색인을 지원합니다.
- **로컬 처리** — 검색어와 검색 결과는 메모리 세션으로 관리합니다.

의미 검색·리랭킹·MCP·Obsidian 연동은 [로드맵](#roadmap)에 포함되어 있습니다.

## Requirements

| 항목 | 기준 |
| --- | --- |
| 운영체제 | macOS, Apple Silicon (`arm64`) |
| Node.js | `24.21.0` — [`.node-version`](.node-version) 기준 |
| 패키지 관리자 | `pnpm 11.25.0` |
| Git | 고정된 QMD 소스 준비에 사용 |
| 최초 준비 | 네트워크 연결과 모델·의존성·색인을 저장할 디스크 공간 |

현재 Apple Silicon·메모리 16GB 환경에서 검증했습니다. 네이티브 의존성을 직접 빌드하는 경우 macOS 개발 도구가 필요할 수 있습니다.

## Quick start

프로젝트 소스를 받은 뒤 루트 디렉터리에서 실행합니다.

```sh
# 로컬 작업 자료의 Git 제외 설정
pnpm local:setup

# 프로젝트 의존성 설치
pnpm install --frozen-lockfile --ignore-scripts

# 고정된 QMD 엔진과 로컬 모델 준비
pnpm r0:prepare

# 웹 GUI 열기 — 서비스가 없으면 자동 시작
pnpm dsearch ui
```

`r0:prepare`는 QMD 소스를 준비하고 허용된 네이티브 의존성을 빌드한 뒤, 모델 registry에 지정된 GGUF 파일 약 **1.61GB**를 내려받아 크기와 SHA-256을 확인합니다. 의존성·빌드 캐시·문서 색인은 추가 공간을 사용합니다. 모델 준비 이후 검색 도중 모델을 자동 다운로드하지 않습니다.

GUI에서 다음 순서로 시작하세요.

1. **폴더 등록**에서 기존 Markdown 폴더의 절대 경로를 입력합니다.
2. **수동 색인 시작**을 누르고 작업 완료를 확인합니다.
3. **문서 검색**에서 키워드 또는 정확한 문자열을 검색합니다.
4. 결과를 선택해 원문과 앞뒤 문맥을 읽습니다.

일반 컬렉션은 `.md`와 `.markdown` 파일을 포함합니다. 숨김 폴더·`node_modules`·symlink·제품 데이터 폴더는 기본 검색 범위에서 제외합니다.

## CLI usage

### 폴더 등록과 색인

```sh
pnpm dsearch collection add /absolute/path/to/notes --name "My notes"
pnpm dsearch collection list --json
pnpm dsearch reconcile
```

### 문서 검색

```sh
# 키워드 검색
pnpm dsearch search "인증서 갱신" --mode lexical --json

# 기호를 포함한 정확한 문자열 검색
pnpm dsearch literal '[a-z]+' --json

# 컬렉션 범위 지정 — COLLECTION_ID를 실제 ID로 바꿉니다
pnpm dsearch search "인증서" --collection COLLECTION_ID --json
```

`--collection`을 생략하면 활성 컬렉션 전체를 검색합니다. 여러 컬렉션을 지정하려면 옵션을 반복합니다. 정확한 문자열 검색은 현재 저장된 파일을 대조하므로 새 파일도 수동 색인 전에 찾을 수 있습니다.

### 원문 읽기

검색 결과의 `doc_id`와 `revision_id`를 사용합니다.

```sh
# DOC_ID와 REVISION_ID를 검색 결과의 값으로 바꿉니다
pnpm dsearch read DOC_ID --revision REVISION_ID --lines 3:8 --json
```

`--lines 3:8`은 3~8행을 포함합니다. 원문이 변경되면 `STALE_REVISION`을 반환합니다. 키워드 검색에 변경 내용을 반영하려면 `reconcile`로 색인을 다시 만드세요.

### 서비스와 컬렉션 관리

```sh
pnpm dsearch serve start
pnpm dsearch status --json
pnpm dsearch collection disable COLLECTION_ID
pnpm dsearch collection enable COLLECTION_ID
pnpm dsearch serve stop
```

### 스크립트에서 사용

직접 CLI 진입점을 실행하면 패키지 관리자의 출력 없이 JSON을 처리할 수 있습니다.

```sh
printf '%s\n' '인증서 갱신' |
  node apps/cli/dist/main.js search --stdin --json
```

`--json`의 stdout에는 응답 envelope 한 개와 마지막 줄바꿈을 출력합니다. 진행 상황은 stderr에 출력하며, 검색 결과가 0개인 경우도 성공으로 처리합니다.

| 옵션 | 동작 |
| --- | --- |
| `--json` | 구조화된 JSON 응답 출력 |
| `--stdin` | 표준입력에서 검색어 읽기 |
| `--collection ID` | 검색 범위 지정, 반복 가능 |
| `--data-root PATH` | 별도의 데이터 디렉터리 사용 |
| `--no-start` | 서비스 자동 시작 금지 |
| `--no-wait` | 완료 대기 없이 접수 ID 반환 |
| `--ignore-case` | 정확한 문자열 검색에서 대소문자 구분 해제 |
| `--help` | 명령 도움말 출력 |

주요 종료 코드는 성공 `0`, 입력 오류 `2`, 인증·범위 오류 `3`, 서비스·색인 준비 오류 `4`, 오래된 revision·만료된 결과 `5`, 모델·호환성 등 기타 오류 `6`, 취소 완료 `130`입니다.

## Configuration

### 데이터 디렉터리

기본 위치는 다음과 같습니다.

```text
~/Library/Application Support/dsearch
```

별도 실험 환경은 `--data-root`로 분리할 수 있습니다. 같은 환경을 사용하는 명령에는 동일한 경로를 지정하세요.

```sh
pnpm dsearch ui --data-root .local/dev-data
pnpm dsearch status --data-root .local/dev-data --json
pnpm dsearch serve stop --data-root .local/dev-data
```

### 컬렉션 프리셋

기본 `general` 프리셋은 일반 Markdown 폴더에 사용합니다.

`learning`은 다음 보관소 구조를 위한 선택적 프리셋입니다. 등록할 경로는 보관소 루트입니다.

```text
30_Resources/
├── ASN.1/
├── Crypto/
└── V2X-Crypto/
```

이 프리셋은 `role` 또는 `type`이 `lesson`, `concept`, `example`인 문서를 포함하고, `Sources` 디렉터리·source 역할·`superseded` 상태를 제외합니다.

### 엔진과 모델

QMD 소스·패치·모델 파일의 식별자는 아래 파일에서 관리합니다.

- [QMD upstream manifest](vendor/qmd-upstream.json)
- [호환 패치](vendor/qmd-patches/compat-v1.patch)
- [모델 registry](vendor/models/registry.json)

현재 모델 구성은 Qwen3-Embedding-0.6B, Qwen3-Reranker-0.6B, 비교용 EmbeddingGemma-300M입니다. 모델과 native 엔진 시험은 준비되어 있으며, 현재 제품 검색은 키워드와 정확한 문자열을 제공합니다.

## Data and privacy

- 원문 읽기·검색·색인 처리는 로컬에서 수행합니다. 최초 엔진·모델 준비에는 네트워크를 사용합니다.
- 원문 폴더는 읽기 대상으로 사용합니다. 컬렉션 사용 중지는 검색 범위를 바꾸며 원문 파일을 삭제하지 않습니다.
- 문서 metadata·검색용 구간·색인·색인 작업 상태는 데이터 디렉터리에 저장합니다.
- 검색어·검색 결과는 서버 메모리 세션으로 관리하고 검색 이력을 자동으로 DB에 저장하지 않습니다.
- 서비스는 `127.0.0.1`에 바인딩합니다. CLI는 사용자 전용 토큰 파일을 사용하고, GUI는 일회성 진입 코드로 세션을 만듭니다.
- GUI는 HTML을 텍스트로 표시하고 외부 이미지의 자동 로딩과 위험한 링크 실행을 제한합니다.

CLI 출력을 파일로 저장하는 경우 해당 파일은 사용자가 관리합니다. 데이터 디렉터리에는 문서 경로와 검색용 내용이 있으므로 저장·백업 범위에 포함해 관리하세요.

## Known limitations

현재는 기능과 운영 경계를 검증하는 알파 단계입니다.

- 색인은 수동 전체 재구축 방식입니다. 자동 동기화·증분 색인·강제 종료 후 복구·세대 자동 정리는 후속 작업입니다.
- GUI의 폴더 등록은 절대 경로 입력 방식이며, 수식은 원래 TeX 표기로 표시합니다.
- 정확한 문자열 검색은 기본 파일당 8MiB, 요청당 총 128MiB·5초·200개 일치까지 처리합니다. 한도에 도달하면 부분 결과와 중단 이유를 반환합니다. 시간 한도는 파일 작업 사이에서 확인합니다.
- 원문 읽기는 최대 200행·64KiB입니다. 검색 세션은 최근 접근 기준 15분, 최대 50개·총 64MiB로 제한합니다.
- 대규모 개인 문서 집합의 검색 품질·장시간 성능·설치 패키지 검증은 진행 전입니다.

확인된 보완 항목도 있습니다.

- 접근하지 못한 하위 폴더가 있어도 색인 작업이 정상 완료로 표시될 수 있습니다.
- 일반 CLI 출력에서 원문의 터미널 제어문자가 그대로 전달됩니다. 구조화된 처리는 `--json`을 사용하세요.
- 늦게 도착한 취소 응답이 새 검색의 GUI 상태를 덮을 수 있습니다.

## Development

```sh
# TypeScript와 웹 빌드
pnpm build

# 타입 검사
pnpm typecheck

# 빌드·구조·디자인 토큰·계약/통합·보안 검사
pnpm check
```

엔진과 모델을 준비한 환경에서는 native 시험과 전체 알파 검증을 실행할 수 있습니다.

```sh
pnpm test:r0
pnpm p3:verify
```

`p3:verify`는 소스 fingerprint를 고정하고 HTTP·CLI·native 시험을 포함한 검증을 실행합니다. manifest와 로그는 `artifacts/p3/`에 저장합니다.

엔진 비교 실험은 다음 명령으로 실행합니다.

```sh
pnpm r0:inspect
pnpm r0:benchmark
```

`r0:verify`는 일반 검사·native 시험·합성 자료의 엔진 비교를 묶어서 실행합니다. 각 통과 기록은 해당 source fingerprint의 검증 범위를 나타냅니다.

공통 UI 토큰은 [tokens.json](packages/ui/src/tokens.json)에서 관리하며 `pnpm tokens:build`로 CSS를 생성합니다. 디자인 목업 자료가 있는 개발 환경에서는 `pnpm mockup`으로 확인할 수 있습니다.

## Project structure

```text
apps/
├── daemon/       로컬 HTTP API, 인증, 작업 조정
├── cli/          명령줄 클라이언트
├── web/          React 웹 GUI
├── mcp/          MCP 브리지 기반 구조 — 구현 예정
└── obsidian/     Obsidian 플러그인 기반 구조 — 구현 예정
packages/
├── contracts/    요청·응답 스키마와 공통 DTO
├── catalog/      문서 ID, revision, 범위 관리
├── compiler/     AST 구간 구성, source map, coverage
├── engine-qmd/   고정 QMD SDK 어댑터
├── search/       검색, 문서별 집계, 메모리 세션
├── generations/  색인 세대 구축·검증·게시
├── runtime/      worker와 모델 무결성 관리
├── ui/           디자인 토큰
└── evaluation/   검색 품질 평가
scripts/          준비·빌드·검증 도구
tests/            계약·통합·보안·native 시험
fixtures/         합성 시험 자료
vendor/           upstream manifest, 패치, 모델 registry, 라이선스
```

`pnpm local:setup`은 `docs/`, `artifacts/`, `.local/`을 checkout의 `.git/info/exclude`에 등록합니다. 이 디렉터리의 로컬 설계·검증 자료·엔진·모델은 저장소에 포함하지 않습니다.

## Roadmap

- [x] Markdown 컬렉션 등록과 수동 색인
- [x] 키워드·정확한 문자열 검색
- [x] revision을 확인하는 원문·문맥 읽기
- [x] 초기 CLI와 독립 웹 GUI
- [ ] 알파에서 확인된 상태·출력 처리 문제 보완
- [ ] 의미 검색과 리랭킹의 제품 연결
- [ ] 대표 자료의 검색 품질·지연·메모리 비교
- [ ] MCP 읽기 도구와 전체 GUI·CLI 확장
- [ ] 자동 동기화, 증분 갱신, 복구·백업·세대 정리
- [ ] 설치 패키지와 운영 검증
- [ ] Obsidian 연결 검토·확정 링크 연동

## Contributing

버그 보고에는 다음 정보를 포함해 주세요.

1. macOS·Node.js·pnpm 버전
2. 실행한 명령 또는 GUI의 재현 순서
3. 기대한 동작과 실제 동작
4. 재현 가능한 최소 합성 문서와 오류 코드

변경에는 목적과 확인 방법을 함께 설명해 주세요. 요청·응답 스키마, 원문 위치, revision, 취소·상태 전이를 바꾸는 경우 관련 회귀 시험을 추가합니다. 기본 검사는 `pnpm check`이며 엔진·모델 경계를 변경하면 준비된 환경에서 native 시험도 확인합니다.

개인 문서, 인증 토큰, 모델 파일, 생성된 색인과 로컬 검증 결과는 커밋에서 제외해 주세요. 보안 문제의 재현 자료에도 자격 증명과 개인 원문을 포함하지 마세요.

## License

이 프로젝트는 [MIT License](LICENSE)로 배포합니다.

QMD의 MIT 라이선스 고지는 [vendor/licenses/QMD-LICENSE](vendor/licenses/QMD-LICENSE)에 보관합니다. 그 밖의 의존성과 모델에는 각 배포본의 라이선스가 적용됩니다.

## Acknowledgements

- [QMD](https://github.com/tobi/qmd) — 검색 엔진 기반
- Qwen3-Embedding·Qwen3-Reranker·EmbeddingGemma — 로컬 모델과 엔진 비교 시험
