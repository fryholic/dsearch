# dsearch

**내 문서를 로컬에서 검색하고, 찾은 근거를 원문으로 확인하세요.**

dsearch는 [QMD](https://github.com/tobi/qmd)를 검색 엔진으로 사용하는 로컬 Markdown 문서 검색 도구입니다. 프로젝트 문서, 업무 안내, 연구 노트 같은 기존 폴더를 등록해 키워드와 의미로 검색하고, 결과의 원문과 앞뒤 문맥을 확인할 수 있습니다. CLI·웹 GUI·MCP로 같은 문서 집합에 접근합니다.

> **Status: Alpha** · 현재 지원 환경은 macOS Apple Silicon이며 소스 checkout에서 실행합니다.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [CLI usage](#cli-usage)
- [MCP](#mcp)
- [Configuration](#configuration)
- [Data and privacy](#data-and-privacy)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

## Features

- **키워드·의미 검색** — 단어가 일치하는 문서와 의미가 가까운 구간을 찾고, 선택적으로 리랭킹을 적용합니다.
- **정확한 문자열 검색** — 코드·식별자·기호를 정규식 해석 없이 찾습니다.
- **원문 확인과 비교** — 검색 근거와 줄 위치를 읽고, 선택한 구간의 관련 자료와 두 문서의 근거를 비교합니다. 원문이 변경되면 이전 결과를 그대로 읽지 않도록 알립니다.
- **CLI·GUI·MCP** — 터미널, 브라우저, MCP 클라이언트에서 같은 로컬 검색 서비스를 사용합니다.
- **컬렉션·모델 관리** — 폴더별 검색 범위, 모델 준비, 색인 생성과 프로필 전환을 관리합니다.
- **색인과 운영 관리** — 자동 변경 반영, 증분 갱신, 배치 사이 검색 양보, 검증된 작업 재개, 백업·오프라인 복원과 미리보기 후 오래된 색인 정리를 제공합니다.
- **로컬 처리** — 원문을 수정하지 않고 검색하며, 검색어와 검색 결과는 메모리 세션으로 관리합니다.

GUI에서는 검색·원문 읽기 외에 작업 상태, 테마, 진단, 결과 내보내기를 제공합니다. Markdown 수식은 제한된 MathML로 표시하며 TeX 원문도 확인할 수 있습니다.

## Requirements

| 항목 | 기준 |
| --- | --- |
| 운영체제 | macOS, Apple Silicon (`arm64`) |
| Node.js | `24.21.0` — [`.node-version`](.node-version) 기준 |
| 패키지 관리자 | `pnpm 11.25.0` |
| Git | 프로젝트와 고정된 QMD 소스 준비에 사용 |
| 최초 준비 | 네트워크 연결과 의존성·모델·색인을 저장할 디스크 공간 |

Apple Silicon·메모리 16GB 환경에서 동작을 확인했습니다. 필요한 메모리와 색인 공간은 문서량에 따라 달라집니다. 네이티브 의존성을 직접 빌드하는 경우 macOS 개발 도구가 필요할 수 있습니다.

기본 Qwen 프로필의 모델 두 파일은 약 **1.28GB**입니다. 의존성·엔진 빌드·문서 색인은 추가 공간을 사용합니다. 현재 설치 패키지와 전역 CLI 설치는 제공하지 않습니다.

## Quick start

프로젝트 소스를 받은 뒤 루트 디렉터리에서 실행합니다. `node --version`으로 위 Node.js 버전을 확인하세요. `pnpm`이 없다면 먼저 Corepack으로 준비합니다.

```sh
# Corepack이 없는 경우에만 설치
npm install --global corepack@0.36.0
corepack enable pnpm
corepack install
pnpm --version
```

`corepack install`은 이 checkout의 `packageManager`에 고정된 pnpm을 준비합니다. 버전 관리자를 사용한다면 선택한 Node.js 환경에서 실행하세요.

```sh
# 프로젝트 의존성 설치
pnpm install --frozen-lockfile --ignore-scripts

# 생성되는 로컬 자료를 Git 추적 대상에서 제외
pnpm local:setup

# QMD 엔진과 애플리케이션 준비
pnpm engine:prepare

# 웹 GUI 열기 — 서비스가 없으면 자동 시작
pnpm dsearch ui
```

`engine:prepare`는 고정된 QMD 소스와 허용된 네이티브 의존성을 준비합니다. 모델은 GUI에서 별도로 다운로드합니다. 일반 검색 중에는 모델을 자동 다운로드하지 않습니다.

GUI에서 다음 순서로 시작하세요.

1. **검색 준비**에서 Markdown 폴더의 절대 경로와 이름을 입력합니다.
2. **범위 미리보기**로 포함·제외 범위를 확인한 뒤 **폴더 등록**을 누릅니다.
3. **다운로드 및 검증**으로 기본 모델을 준비합니다. 기존 파일은 체크섬을 검증합니다.
4. **색인 만들고 검색 준비**를 실행합니다.
5. **문서 검색 시작**으로 이동해 검색하고 결과의 원문을 읽습니다.

CLI로 시작하려면 다음 [폴더 등록과 색인](#폴더-등록과-색인) 절차를 사용하세요. 설치·엔진 준비는 공통으로 필요합니다.

## CLI usage

아래 검색어는 [예제 문서](examples/documents)의 백업·업무 안내 내용을 사용합니다. 직접 확인하려면 `collection add "$PWD/examples/documents" --name "Examples"`로 등록하고 색인을 만드세요. 예제는 소규모 기능 확인용이며 검색 품질·성능의 대표 평가 자료는 아닙니다. 폴더 경로와 검색어는 자신의 문서에 맞게 바꾸세요. `pnpm dsearch` 명령은 프로젝트 루트에서 실행합니다.

### 폴더 등록과 색인

GUI의 준비 절차를 CLI로 수행할 수도 있습니다.

```sh
pnpm dsearch collection add /absolute/path/to/documents --name "My documents"
pnpm dsearch collection list --json
pnpm dsearch model prepare qwen-local --wait --json
pnpm dsearch reconcile
```

`model prepare`는 모델을 다운로드·검증하고, `reconcile`은 등록된 활성 컬렉션의 색인을 만듭니다. 문서를 수정·추가하거나 컬렉션 범위를 변경한 뒤에도 `reconcile`로 검색 색인을 갱신합니다. 호환되는 기존 세대가 있으면 미변경 문서의 컴파일과 벡터를 재사용하며, 검증한 새 세대가 준비된 뒤 전환합니다. `reconcile --full`은 기존 색인을 재사용하지 않고 다시 만듭니다. 작업 결과의 `reused_documents`와 `embedding_calls`로 실제 재사용을 확인할 수 있습니다.

GUI 작업 화면에는 준비를 마친 검색 구간 수를 표시합니다. 임베딩 배치의 응답이 120초 동안 없으면 `WORKER_TIMEOUT`으로 실패하며 다시 시도할 수 있습니다. 사용자 취소는 `CANCELLED`로 구분합니다.

### 키워드와 정확한 문자열 검색

```sh
pnpm dsearch search "백업" --mode lexical --json

# 정규식으로 해석하지 않고 문자열 자체를 검색
pnpm dsearch literal '[a-z]+' --json

# COLLECTION_ID를 collection list의 실제 ID로 바꿉니다
pnpm dsearch search "백업" --mode lexical --collection COLLECTION_ID --json
```

`--collection`을 생략하면 활성 컬렉션 전체를 검색합니다. 여러 컬렉션은 옵션을 반복해 지정합니다. 정확한 문자열 검색은 현재 파일을 직접 확인하므로 새 파일도 색인 갱신 전에 찾을 수 있습니다.

### 의미 검색과 리랭킹

```sh
# 키워드·벡터 검색 결과에 리랭킹 적용
pnpm dsearch search "실수로 삭제한 파일을 되돌리는 절차" --mode hybrid --rerank --json

# 리랭킹 없이 키워드·벡터 후보를 결합
pnpm dsearch search "새 팀원이 개발 환경을 준비하는 방법" --mode hybrid --no-rerank --json

# 모델 오류가 발생하면 대체 검색을 허용
pnpm dsearch search "배포 전에 확인할 사항" --mode hybrid --allow-degraded --json
```

초기 기본 방식은 `hybrid`이고 리랭킹은 꺼져 있습니다. 리랭킹을 사용할 수 없으면 허용한 경우 리랭킹 없이 검색하고, 임베딩 모델을 사용할 수 없으면 키워드 검색으로 전환합니다. 응답에는 실제 검색 방식과 전환 이유를 표시합니다. 대체 방식은 `--allow-degraded` 또는 설정에서 명시적으로 허용합니다.

### 원문 읽기와 관련 자료

검색 결과의 `doc_id`와 `revision_id`를 사용합니다. 아래 대문자 값은 실제 응답의 값으로 바꾸세요.

```sh
pnpm dsearch read DOC_ID --revision REVISION_ID --lines 3:8 --json
pnpm dsearch related DOC_ID --revision REVISION_ID --lines 3:8 --json

pnpm dsearch compare LEFT_DOC_ID RIGHT_DOC_ID \
  --left-revision LEFT_REVISION --right-revision RIGHT_REVISION \
  --query "백업 보관 기간과 복구 절차" --json
```

`--lines 3:8`은 3~8행을 포함합니다. 문서 버전이 바뀌면 `STALE_REVISION`을 반환합니다. 색인을 갱신하고 다시 검색해 새 버전으로 읽으세요. 관련 검색은 선택 구간을 바탕으로 다른 문서를 찾고, 비교는 지정한 두 문서에서 각각 근거를 찾습니다.

### 서비스·설정·진단

```sh
pnpm dsearch status --json
pnpm dsearch settings set --theme light --mode hybrid --no-rerank
pnpm dsearch jobs list --json
pnpm dsearch doctor --json
pnpm dsearch serve stop
```

일반 CLI 명령은 서비스가 없으면 자동 시작합니다. 자동 시작을 막으려면 `--no-start`를 지정합니다. 결과 내보내기는 `pnpm dsearch export SEARCH_ID --output results.json`을 사용하며, 질의는 기본적으로 제외합니다. `--include-query`로 질의를 포함할 수 있습니다. 기존 출력 파일은 덮어쓰지 않습니다.

### 스크립트에서 사용

패키지 관리자의 출력 없이 JSON을 처리하려면 빌드된 CLI 진입점을 직접 실행합니다.

```sh
printf '%s\n' '백업' |
  node apps/cli/dist/main.js search --stdin --mode lexical --json
```

`--json`은 stdout에 JSON 응답 하나를 출력하고 진행 상황은 stderr에 출력합니다. 결과가 0개여도 명령은 성공합니다. 주요 종료 코드는 성공 `0`, 입력 오류 `2`, 인증·범위 오류 `3`, 서비스·색인 준비 오류 `4`, 변경된 문서·만료된 결과 `5`, 모델·호환성 등 기타 오류 `6`, 취소 완료 `130`입니다. 전체 명령은 `pnpm dsearch --help`로 확인하세요.

## MCP

MCP 클라이언트에서도 등록된 문서를 검색하고 원문을 읽을 수 있습니다. 먼저 GUI 또는 CLI로 모델과 컬렉션 색인을 준비하세요.

```sh
pnpm dsearch mcp
```

다음은 `mcpServers` 형식을 사용하는 클라이언트의 설정 예시입니다. `command`는 `command -v node`로 확인한 Node.js 실행 파일의 절대 경로, 첫 번째 인자는 이 checkout의 빌드된 CLI 절대 경로로 바꿉니다. 클라이언트에 따라 설정 파일 형식은 다를 수 있습니다.

```json
{
  "mcpServers": {
    "dsearch": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/dsearch/apps/cli/dist/main.js", "mcp"]
    }
  }
}
```

제공 도구는 `search_documents`, `search_literal`, `read_document`, `find_related`, `compare_documents`, `get_search_status`, `list_collections`, `cancel_search`입니다. 컬렉션·모델 관리와 원문 쓰기는 제공하지 않습니다. 문서 내용은 신뢰할 수 없는 자료로 표시하며, 결과가 크면 생략 여부와 후속 읽기 안내를 반환합니다.

별도 데이터 디렉터리를 사용한다면 `args`에 `"--data-root", "/absolute/path/to/dsearch-data"`를 추가하고 GUI·CLI에도 같은 경로를 지정하세요.

## Configuration

### 데이터 디렉터리

macOS의 기본 데이터 디렉터리는 다음과 같습니다.

```text
~/Library/Application Support/dsearch
```

개발·테스트 환경은 `--data-root`로 분리할 수 있습니다. 같은 환경에 연결하는 CLI·GUI·MCP에는 동일한 경로를 지정합니다. 이 옵션은 카탈로그·색인·설정을 분리하며, 기본 설치 모델은 checkout의 `.local/models/`에서 공유합니다.

```sh
pnpm dsearch ui --data-root .local/dev-data
pnpm dsearch status --data-root .local/dev-data --json
pnpm dsearch serve stop --data-root .local/dev-data
```

### 컬렉션과 검색 범위

새 컬렉션은 `general` 설정으로 `.md`와 `.markdown` 파일을 대상으로 하며 폴더 구조나 메타데이터를 요구하지 않습니다. `Sources` 같은 폴더명이나 `superseded` 같은 상태 값에 따른 자동 제외도 없습니다. 숨김 폴더·`node_modules`·symlink·제품 데이터 폴더는 기본적으로 제외합니다.

`--include`와 `--exclude`로 범위를 조정할 수 있습니다. glob 패턴은 등록할 폴더를 기준으로 해석하며, 셸에서 확장되지 않도록 따옴표로 감쌉니다.

```sh
pnpm dsearch collection preview /absolute/path/to/documents \
  --name "My documents" \
  --include '**/*.md' --include '**/*.markdown' \
  --exclude 'archive/**' --exclude 'drafts/**' \
  --json
```

미리보기는 컬렉션을 등록하지 않습니다. 확인한 범위는 같은 옵션의 `collection add`로 등록합니다. 기존 규칙은 `collection update COLLECTION_ID`로 변경할 수 있습니다.

`--include`를 지정하면 기본 포함 패턴을 대체합니다. 포함 패턴 중 하나에 일치하면 포함 후보가 되고, 제외 패턴에 일치하면 제외합니다. 컬렉션을 일시적으로 검색에서 빼려면 `collection disable COLLECTION_ID`, 복귀시키려면 `collection enable COLLECTION_ID`를 사용합니다.

하위 폴더·메타데이터·제목에 따른 제한이 필요하면 GUI의 **포함·제외 규칙** 또는 `--scope-json`을 사용합니다. 경로 접두사는 glob이 아닌 상대 폴더 경로이며 `/`로 끝나야 합니다. 비워 두면 해당 제한이 없습니다.

```sh
pnpm dsearch collection preview /absolute/path/to/documents \
  --name "Project documents" \
  --scope-json '{"path_prefixes":["Projects/"],"metadata_filter":{"not":{"field":"metadata.status","operator":"eq","value":"draft"}},"navigation_headings":["Navigation"]}' \
  --json

# 기존 컬렉션의 변경 전후 문서 수를 확인한 뒤 같은 규칙을 저장
pnpm dsearch collection preview COLLECTION_ID \
  --scope-json '{"metadata_filter":null}' --json
pnpm dsearch collection update COLLECTION_ID \
  --scope-json '{"metadata_filter":null}' --json
pnpm dsearch reconcile
```

`--scope-json`에 지정하지 않은 필드는 기존 규칙을 유지합니다. 기존 컬렉션의 미리보기는 새로 포함·제외되는 문서 수와 유지되는 수를 반환하며, 읽기·시간 한도에 걸리거나 접근하지 못한 범위가 있으면 차이 집계를 확정하지 않습니다. GUI는 변경한 규칙으로 다시 미리보기를 마친 뒤 저장할 수 있습니다. `navigation_headings`는 정확히 일치하는 제목 아래 본문 구간을 색인에서 제외하며 원문은 유지합니다.

### 메타데이터와 필터

YAML frontmatter의 `role`과 `type`은 독립적인 필드입니다. 문자열·숫자·불리언과 같은 형식의 단일 값 또는 목록을 필터에 사용할 수 있으며, 중첩 객체는 `metadata.project.team`처럼 지정합니다. GUI에서 유형·역할을 각각 선택하거나 CLI의 `--filter-json`, MCP의 `filter`를 사용할 수 있습니다.

```sh
pnpm dsearch search "운영" --mode lexical \
  --filter-json '{"field":"metadata.type","operator":"eq","value":"guide"}' --json
```

`eq`는 값 또는 목록의 원소가 일치하는지, `in`은 후보 목록 중 하나가 일치하는지, `all`은 후보가 모두 들어 있는지 확인합니다. `ne`는 해당 형식의 값이 존재하면서 일치하지 않을 때만 참입니다. 누락된 필드까지 포함해 특정 값을 제외하려면 `not`으로 `eq`를 감쌉니다. `exists`와 `and`·`or`·`not`도 지원합니다.

검색용 필드는 최대 63개이며 값은 문자열 1,024자·목록 128개·중첩 깊이 6단계까지 정규화합니다. 필드명은 영문 소문자로 시작하는 영문 소문자·숫자·`_`·`.`·`-`의 조합으로 최대 64자입니다. 지원하지 않는 값은 원래 메타데이터에 보관하고 필터에서 생략하며 처리 상태에 알립니다. YAML 문법 오류·중복 키·파싱 한도 초과는 문서 처리 오류로 표시합니다. 필터는 원문 파일을 변경하지 않습니다.

### 기존 컬렉션 업그레이드

이전 버전의 서비스를 `serve stop`으로 종료하고 새 코드를 빌드한 뒤 다시 시작하세요. 최초 실행 시 카탈로그를 SQLite의 일관된 백업으로 데이터 디렉터리의 `backups/`에 저장하고, 기존 포함 범위를 명시적인 규칙으로 변환합니다. 컬렉션·문서 ID와 원문은 유지합니다.

기존 메타데이터 형식 제약은 호환 모드로 유지합니다. 새 색인을 만드는 동안 이전·이후 포함 판정을 대조하며, 일치하지 않으면 게시를 중단합니다. GUI의 **범위 편집과 처리 상태**에서 변환된 규칙을 확인하고 수동 색인을 실행하세요. 새 색인이 게시될 때까지 이전 정책의 색인을 검색에 사용하지 않습니다. 프로필 후보 준비만으로는 전환되지 않습니다.

이전 형식 제약을 해제하려면 GUI의 체크박스 또는 기존 `collection preview`·`collection update`의 `--no-legacy-metadata` 옵션을 사용합니다. 먼저 미리보기로 추가되는 문서를 확인하세요. 경로·상태 등의 명시적 범위 규칙은 별도로 편집합니다. 새 색인은 변경된 메타데이터 처리 방식으로 작성하며 이전 색인 파일은 삭제하지 않습니다. 변환 전 백업 파일도 유지하세요. 일반 운영 백업의 생성과 복원은 아래 절차를 사용합니다.

### 모델과 검색 기본값

기본 `qwen-local` 프로필은 Qwen3-Embedding-0.6B와 Qwen3-Reranker-0.6B를 사용합니다. 대안인 `qmd-reference`는 EmbeddingGemma-300M과 같은 리랭커를 사용합니다. 모델 파일의 출처·고정 버전·크기·체크섬은 [모델 registry](vendor/models/registry.json)에서 확인할 수 있습니다.

GUI의 **설정 → 검색 모델과 프로필**에서 모델을 준비하고 새 색인을 만든 뒤 명시적으로 전환합니다. 파일을 내려받거나 프로필을 선택하는 것만으로 현재 검색은 바뀌지 않습니다. GUI와 `settings set`에서 테마, 기본 검색 방식, 리랭킹과 대체 검색 허용 여부를 변경할 수 있습니다.

### 자동 반영

자동 반영은 기본으로 켜져 있습니다. 모델이 준비된 등록 폴더에서 변경을 감지하면 약 5초간 저장이 안정되기를 기다린 뒤 증분 색인을 만듭니다. 연속 변경은 최대 30초 단위로 묶고, 색인 중 추가된 변경도 다음 작업으로 반영합니다. 이벤트를 놓친 경우를 위해 시작·잠자기 복귀 감지와 60초 주기 재대조도 수행합니다.

GUI의 **설정 → 자동 반영**에서 변경한 뒤 **설정 저장**을 누르거나 CLI를 사용하세요.

```sh
pnpm dsearch settings set --no-auto-sync --json
pnpm dsearch settings set --auto-sync --json
pnpm dsearch status --json
```

상태의 `synchronization`에서 반영 대기·진행·확인이 필요한 상태를 볼 수 있습니다. 자동 작업은 작업 목록에 **자동 반영**으로 표시합니다. 자동 반영을 꺼도 `reconcile`로 수동 갱신할 수 있습니다. 모델을 자동으로 다운로드하지 않으며, 준비되지 않은 모델이나 접근할 수 없는 폴더는 확인을 기다립니다. 실패하거나 사용자가 취소한 자동 작업은 서비스를 재시작해도 같은 입력으로 반복 생성하지 않습니다. 원인을 해결한 뒤 작업 목록에서 다시 시도하거나 `reconcile`을 실행하세요. 자동 반영을 껐다 켜도 새 시도를 허용합니다. 정상 종료로 중단된 자동 작업은 다음 시작에서 다시 처리할 수 있습니다.

자동 반영을 꺼도 실행 공백이나 시계 변경을 감지하면 기존 모델 실행 환경을 종료하고 다음 검색에서 새로 준비합니다. 진행 중인 검색은 재시도 가능한 오류로 끝날 수 있으며, 사용자가 취소한 작업은 취소 의도를 유지합니다. 이 복구는 자동 반영 설정과 마지막 정상 색인을 유지하며 원문을 변경하지 않습니다. 복구 상태가 계속되면 서비스를 재시작하세요.

### 백업·복원과 색인 정리

GUI의 **설정 → 데이터 백업 / 이전 색인 정리** 또는 CLI에서 운영 백업을 생성할 수 있습니다. 백업은 카탈로그·설정·검색용 내용과 색인·참조된 정책 변환 스냅샷을 포함하며, 원문 파일·모델 파일·인증 토큰은 포함하지 않습니다. 원문과 모델은 별도로 보관하세요. 백업에도 원문에서 파생된 내용이 있으므로 데이터 디렉터리와 같은 수준으로 보호합니다.

```sh
pnpm dsearch backup create --json
pnpm dsearch backup list --json

# 삭제 후보만 확인
pnpm dsearch generation gc --json

# 확인한 미리보기의 plan_id를 지정해 정리
pnpm dsearch generation gc --apply --plan-id PLAN_ID --json
```

일반 백업은 최근 7개를 유지합니다. 정책 변환 스냅샷은 별도로 보존합니다. 색인 정리는 활성 세대·준비된 후보·읽기 중인 세대·현재 입력으로 재개할 작업과 외부 파일에 의존하는 백업 참조를 보호합니다. 새 운영 백업은 색인 파일을 자체 보관하며, 전체 체크섬·DB·봉인 검증을 통과하면 중복된 원본 색인은 정리할 수 있습니다. 검증하지 못한 백업·이전 형식·정책 변환 스냅샷의 참조는 계속 보호합니다. 상태나 참조가 달라져 미리보기가 오래되면 다시 확인해야 합니다. 기본 정책은 최근 비활성 정상 세대 2개와 생성 후 24시간 미만인 세대를 유지하며 자동으로 삭제하지 않습니다.

복원은 대상 서비스가 종료된 상태에서 CLI로 실행합니다. 먼저 별도 데이터 디렉터리를 대상으로 검증하는 것을 권장합니다. 첫 명령은 검증 결과와 적용할 `plan_id`를 반환하고, 두 번째 명령에서 이를 지정합니다.

```sh
pnpm dsearch restore /absolute/path/to/backup-folder \
  --target-root /absolute/path/to/restored-data --json
pnpm dsearch restore /absolute/path/to/backup-folder \
  --target-root /absolute/path/to/restored-data --apply --plan-id PLAN_ID --json
```

복원은 원문 파일을 덮어쓰지 않습니다. 기존 대상 데이터는 교체 전에 별도 경로로 보존하고 반환된 `previous_archive`에서 확인할 수 있습니다. 원문 경로·내용·실행 환경이 달라지면 `rebuild_required`, 모델을 준비해야 하면 `models_ready: false`로 알립니다. 복원된 데이터로 실행할 때는 CLI·GUI·MCP에 같은 `--data-root`를 지정합니다.

중단된 색인 작업은 입력·프로필·체크포인트가 현재 상태와 일치할 때 GUI의 **재개** 또는 `jobs retry JOB_ID`로 이어갈 수 있습니다. 입력이 달라진 경우 새 `reconcile`을 실행하세요. 메모리 부족은 배치를 줄여 한 번 재시도하고, 반복 실패는 기존 활성 색인을 유지한 채 오류로 종료합니다.

## Data and privacy

- 원문 읽기·검색·색인 처리는 로컬에서 수행합니다. 의존성 설치와 엔진·모델 준비에는 네트워크를 사용합니다.
- 원문 폴더는 읽기 대상으로 사용하며, 컬렉션 사용 중지는 원문 파일을 삭제하지 않습니다.
- 문서 메타데이터·검색용 내용·색인·설정·작업 상태는 데이터 디렉터리에 저장합니다. 이 경로에도 원문에서 파생된 내용이 있으므로 백업과 접근 권한을 관리하세요.
- 검색어·검색 결과는 서버 메모리 세션에서 관리하고 검색 이력을 자동으로 DB에 저장하지 않습니다. 명령줄 검색어는 사용 중인 셸의 이력에 남을 수 있습니다.
- 서비스는 `127.0.0.1`에서 실행합니다. CLI는 사용자 전용 토큰을 사용하고 GUI는 일회성 진입 코드로 인증합니다.
- GUI는 원문의 HTML을 실행하지 않고, 외부 이미지의 자동 로딩과 위험한 링크 실행을 제한합니다.

직접 저장한 CLI 출력·내보내기 파일과 MCP 클라이언트로 전달한 결과는 해당 파일·클라이언트의 보관 정책에 따라 관리됩니다.

## Known limitations

- 증분 갱신은 호환되는 이전 세대의 입력과 벡터를 재사용합니다. 자동 반영을 끄면 문서 변경 후 `reconcile`을 실행하세요. 전체 구축은 `reconcile --full`로 선택합니다. 배치 사이에는 색인 모델을 해제해 검색에 실행권을 양보하지만, 현재 배치나 구간 구성 작업이 끝날 때까지 검색이 대기할 수 있습니다.
- 의미 검색은 관련 구간을 순위로 반환합니다. 답이 없는 질의를 자동으로 판정하지 않으므로 결과의 원문을 확인하세요.
- 일부 큰 코드·표는 의미 검색에서 제외되고 키워드 검색의 별도 결과로 반환될 수 있습니다.
- 정확한 문자열 검색은 파일 크기·총 읽기량·시간·일치 수에 한도가 있습니다. 한도에 도달하면 부분 결과와 중단 이유를 반환합니다.
- 원문 읽기는 요청당 최대 200행·64KiB이며 검색 결과 세션은 유휴 15분 후 만료됩니다.
- 접근하지 못한 하위 폴더가 있으면 새 색인 게시를 막고 기존 색인을 유지합니다. 컬렉션과 진단 화면에서 범위를 확인하세요.
- 대규모 문서의 검색 품질·장시간 성능과 설치 패키지·업데이트/복귀 검증은 진행 전입니다. OS·GPU의 실제 잠자기 복귀 운용 검증도 남아 있습니다.

## Development

의존성을 설치한 checkout에서 실행합니다.

```sh
pnpm build
pnpm typecheck
pnpm check
```

`pnpm check`는 빌드·구조·디자인 토큰·계약/통합·보안 검사를 실행합니다. 모델을 사용하는 실제 검색 동작은 별도의 엔진·모델 준비가 필요합니다.

주요 디렉터리는 다음과 같습니다.

```text
apps/       로컬 서비스, CLI, 웹 GUI, MCP 서버
packages/   문서 관리, 검색 엔진 연결, 공통 UI와 요청·응답 정의
scripts/    준비·빌드·검사 도구
tests/      자동 검사
examples/   직접 등록해 사용할 수 있는 일반 문서 예제
fixtures/   합성 검사 자료
vendor/     엔진·모델 명세, 호환 패치, 라이선스 고지
```

`pnpm local:setup`은 checkout의 `.git/info/exclude`에 로컬 자료 제외 규칙을 설정합니다. 이 설정은 clone으로 전달되지 않으므로 새 checkout에서 다시 실행합니다.

## Roadmap

- 자동 동기화·검색·복구의 장시간 운용 검증
- 대표 문서 집합의 검색 품질·성능 검증
- 설치·업데이트 배포 방식 개선
- Obsidian 등 문서 도구와의 연결

## Contributing

버그 보고에는 운영체제·Node.js·pnpm 버전, 재현 순서, 기대한 동작과 실제 동작, 오류 코드를 포함해 주세요. 재현 문서는 개인 자료를 제거한 최소 예제로 준비합니다.

변경에는 목적과 확인 방법을 함께 설명하고 `pnpm check`를 실행해 주세요. 검색·원문 위치·문서 버전·취소·상태 처리를 변경할 때에는 관련 회귀 검사를 포함합니다. 엔진·모델 경계를 변경하면 준비된 환경에서 실제 검색 동작도 확인합니다.

개인 문서, 인증 토큰, 모델 파일, 생성된 색인과 로컬 검증 자료는 커밋에서 제외합니다. 보안 문제의 재현 자료에도 자격 증명과 개인 원문을 포함하지 마세요.

## License

이 프로젝트는 [MIT License](LICENSE)로 배포합니다.

QMD·KaTeX·MCP SDK의 MIT 라이선스 고지는 [vendor/licenses](vendor/licenses)에 보관합니다. 그 밖의 의존성과 모델에는 각 배포본의 라이선스가 적용됩니다.

## Acknowledgements

- [QMD](https://github.com/tobi/qmd) — 검색 엔진 기반
- [KaTeX](https://github.com/KaTeX/KaTeX) — MathML 수식 변환
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MCP stdio 연결
- Qwen3-Embedding·Qwen3-Reranker·EmbeddingGemma — 로컬 검색 모델
