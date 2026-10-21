# dsearch

QMD를 검색 엔진으로 사용하는 로컬 문서 검색 프로젝트입니다. CLI·독립 웹 GUI·MCP가 같은 검색 계약을 사용하도록 구성합니다.

현재 P0 실행 기반과 P1 QMD 적합성 검증 경로를 구현했습니다. TypeScript 빌드, 공통 런타임 스키마, 독립 native worker, 원문 매핑 프로토타입, 고정 QMD 호환 패치와 합성 자료 비교 시험이 있습니다. 대상은 macOS arm64입니다. 제품용 카탈로그·검색/읽기 HTTP API·전체 CLI·MCP·C안 GUI는 이후 단계에서 연결합니다.

## 시작

Node.js 24.21.0과 pnpm 11.25.0을 사용합니다.

~~~sh
pnpm local:setup
pnpm install --ignore-scripts
pnpm check
~~~

## 엔진 검증

모델을 사용하는 첫 준비는 네트워크와 디스크 공간이 필요합니다. 고정 QMD 소스·lockfile·명시적으로 허용한 native 의존성을 준비하고, registry에 기록된 세 모델 약 1.61 GB를 받아 SHA-256과 크기를 확인합니다.

~~~sh
pnpm r0:prepare
pnpm r0:verify
~~~

`r0:verify`는 준비된 로컬 파일만 사용해 빌드·단위/통합·개발 서버 보안·native 계약 시험과 4개 엔진/표현/모델 조합의 240회 합성 검색을 실행합니다. 결과는 Git에서 제외한 `artifacts/r0/`에 생성됩니다. `verification.json`의 `passed`는 해당 소스 fingerprint의 P0/P1 엔진 검증 완료를 뜻합니다. R1의 실제 문서 품질·설치·장시간 성능 검증은 별도 단계입니다.

개별 명령은 `pnpm test:r0`, `pnpm r0:inspect`, `pnpm r0:benchmark`입니다. 명시적인 준비 이후 검색 도중 모델을 내려받지 않습니다. 선택적인 deep 확장 모델은 설치하지 않았으며, 없으면 오류를 반환합니다. 기본 질의 캐시는 bounded TTL 메모리를 사용합니다. SQLite WAL을 포함하는 일관된 snapshot 경로도 시험합니다.

웹 빌드의 `dist-web/`는 React 진입점과 C 세이지 토큰을 검증하는 기본 화면입니다. 실제 검색 화면은 P2/P3에서 구현합니다. 현재 CLI와 웹의 공통 DTO 소비 시험은 fixture adapter를 사용합니다.

## 구조

- apps/daemon: 로컬 HTTP 서비스와 프로세스 조정
- apps/cli: dsearch 명령
- apps/web: 독립 GUI
- apps/mcp: stdio 브리지
- apps/obsidian: 후속 Obsidian 플러그인
- packages/: 계약·수집·구간 구성·QMD 어댑터·검색·세대·런타임·UI·평가
- vendor/qmd-upstream.json: 기준 upstream과 통합 상태
- tests/, fixtures/: 계약·통합·수용 시험과 합성 자료를 위한 위치

## 로컬 자료

PRD·HLD·LLD·디자인 가이드·IA·목업은 docs/에 로컬로 보관합니다. pnpm local:setup은 이 자료와 artifacts/, .local/을 해당 checkout의 .git/info/exclude에 추가합니다. 설계 자료는 커밋에서 제외하며 새 checkout에서는 위 명령으로 제외 설정을 적용하세요.

로컬 목업 자료가 있는 환경에서는 pnpm mockup으로 볼 수 있습니다. 목업은 합성 자료만 사용하며 검색·모델·원문 파일에 연결하지 않습니다. 서버는 127.0.0.1에만 바인딩하고, 시작할 때 검증한 6개 파일의 복사본을 제공합니다. 심볼릭 링크·일반 파일이 아닌 자료·1 MiB를 넘는 파일은 거부하며, 목업을 수정한 뒤에는 서버를 다시 시작하세요.

기본 배색은 흰 배경의 C 세이지로 확정했습니다. #design 검토 화면에서 이전 A/B안과 비교할 수 있으며, 제품 화면에는 시안 전환 바를 표시하지 않습니다. 시안 및 테마 전환은 작성 중인 검색어와 읽던 문서를 유지합니다. 공통 색상은 packages/ui/src/tokens.json에서 정의하고 pnpm tokens:build로 CSS를 생성합니다. pnpm check는 세 배색의 라이트·다크 대비와 개발 서버의 보안 회귀 시험을 함께 검사합니다.
