# dsearch

QMD를 검색 엔진으로 사용하는 로컬 문서 검색 프로젝트입니다. macOS Apple Silicon에서 폴더 등록, 수동 색인, 키워드·정확한 문자열 검색, revision을 확인하는 원문 읽기를 CLI와 독립 GUI로 제공합니다. 현재 완료 범위는 P3 내부 알파입니다.

GUI는 흰 배경의 C 세이지 디자인을 사용합니다. 검색 결과와 원문 패널, 컬렉션 등록·사용 중지, 색인 진행·취소를 실제 로컬 API에 연결했습니다. 의미 검색·리랭킹을 제품에 연결하는 단계는 P4이며, 전체 GUI·MCP·자동 동기화·설치본은 후속 단계입니다.

## 준비와 실행

대상 환경은 macOS arm64, Node.js 24.21.0, pnpm 11.25.0입니다.

~~~sh
pnpm local:setup
pnpm install --ignore-scripts
pnpm check
pnpm r0:prepare
pnpm dsearch ui
~~~

`r0:prepare`는 고정 QMD 소스와 native 의존성을 준비하고 registry의 세 모델 약 1.61 GB를 내려받아 크기와 SHA-256을 확인합니다. 준비 후 검색이나 색인 도중 모델을 자동 다운로드하지 않습니다. GUI에서 기존 Markdown 폴더를 등록한 뒤 수동 색인을 시작하세요. 일반 폴더는 `.md`와 `.markdown` 파일을 포함합니다. 학습 프리셋은 보관소 루트 아래 `30_Resources/ASN.1`, `Crypto`, `V2X-Crypto`와 지정된 역할·상태 정책을 사용합니다.

기본 데이터 폴더는 `~/Library/Application Support/dsearch`입니다. `--data-root <folder>`로 별도 실험 환경을 지정할 수 있습니다. 서비스는 `127.0.0.1`의 임의 포트에 바인딩하며 CLI는 사용자 전용 파일의 토큰을 읽습니다. GUI 진입 코드는 60초 안에 한 번 사용하고 주소에서 제거됩니다. 질의와 검색 결과는 서버 메모리에 두며 검색 이력을 DB에 쓰지 않습니다. 원문이나 Obsidian 설정을 수정하는 기능은 포함하지 않습니다.

## CLI

프로젝트 루트에서 다음과 같이 실행합니다. JSON을 파이프로 처리할 때에는 `node apps/cli/dist/main.js`를 사용할 수 있습니다.

~~~sh
pnpm dsearch collection add /absolute/path/to/notes --name "내 문서"
pnpm dsearch collection list --json
pnpm dsearch reconcile
pnpm dsearch search "서명 검증" --mode lexical --json
pnpm dsearch literal '[a-z]+' --json
pnpm dsearch read <doc-id> --revision <revision-id> --lines 3:8 --json
pnpm dsearch status --json
pnpm dsearch serve stop
~~~

`--collection <id>`를 반복하면 검색 범위를 지정할 수 있습니다. 생략하면 활성 컬렉션 전체를 검색합니다. `--stdin`은 질의를 표준입력으로 받습니다. `--no-start`는 서비스 자동 시작을 금지하고 `--no-wait`는 접수된 작업·검색 ID만 반환합니다. `--json` stdout은 envelope 하나와 마지막 LF이며 진행은 stderr에 출력합니다. 검색 결과 0개는 성공입니다. SIGINT는 취소 후 실제 종료를 기다립니다.

`--lines 3:8`은 3~8행을 포함합니다. API의 locator 끝점은 exclusive이며 열은 LF 정규화 원문의 UTF-16 단위입니다. 원문이 바뀌면 예전 revision 읽기는 `STALE_REVISION`과 종료 코드 5로 거부됩니다. 키워드 결과는 읽을 때 전체 hash를 대조하고 변경된 후보를 제외합니다. 새 파일·수정 내용은 수동 색인으로 갱신하세요. 정확한 문자열 검색은 현재 저장된 원문을 직접 대조합니다.

## 알파 한도

정확한 문자열은 정규식으로 해석하지 않습니다. 기본 한도는 파일당 8 MiB, 요청당 총 128 MiB·5초·200개 일치이며 중단 이유와 부분 결과를 반환합니다. 검색 세션은 최근 접근 기준 15분, 최대 50개·64 MiB의 메모리 한도를 사용합니다. 원문 읽기는 최대 200행·64 KiB입니다.

GUI의 폴더 등록은 절대 경로 입력 방식입니다. Markdown은 안전한 AST 허용 목록으로 표시하며 HTML은 텍스트로, 외부 이미지는 설명으로, 수식은 원래 TeX 표기로 보여줍니다. 검색용 세대는 전체 재구축 방식이며 자동 watcher, 강제 종료 후 작업 복구, 세대 자동 정리, 설치 패키지, 전체 R1 품질·장시간 성능 검증은 후속 범위입니다.

## 검증

~~~sh
pnpm p3:verify
~~~

현재 소스 fingerprint를 고정해 빌드·계약/통합·보안·native 엔진·HTTP·CLI 시험을 실행하고 `artifacts/p3/verification.json`과 로그를 생성합니다. 실제 임시 폴더에서 등록→색인→검색→읽기→변경 거부·취소·재시작을 검사합니다. 브라우저 시연과 반응형 화면 증거는 로컬 설계 자료의 `P3_REPORT.md`와 `P3-evidence/`에 보관합니다. 이 명령의 통과는 P3 자동 검증 범위이며 전체 R1 출시 승인을 뜻하지 않습니다.

`pnpm r0:verify`는 별도로 4개 엔진/표현/모델 조합의 240회 합성 비교를 실행합니다. 최초 R0 결과는 당시 소스 상태의 기록이며 현재 알파의 검증과 구별합니다.

## 구조와 로컬 자료

- `apps/daemon`, `apps/cli`, `apps/web`: 실제 로컬 서비스와 초기 클라이언트
- `apps/mcp`, `apps/obsidian`: 후속 클라이언트 경계
- `packages/`: 계약·카탈로그·컴파일러·QMD 어댑터·검색·세대·런타임·UI 토큰·평가
- `vendor/`: 고정 upstream·호환 패치·모델 registry·라이선스
- `tests/`, `fixtures/`: 계약·통합·보안·native 시험과 합성 자료

PRD·HLD·LLD·디자인 가이드·IA·목업은 `docs/`에 로컬로 보관합니다. `pnpm local:setup`은 `docs/`, `artifacts/`, `.local/`을 해당 checkout의 `.git/info/exclude`에 추가합니다. 코드만 로컬 커밋으로 관리합니다.

`pnpm mockup`은 디자인 검토용 합성 목업을 엽니다. 실제 제품은 `pnpm dsearch ui`로 실행합니다. 공통 색상·타이포그래피·간격은 `packages/ui/src/tokens.json`에서 정의하고 `pnpm tokens:build`로 CSS를 생성합니다.
