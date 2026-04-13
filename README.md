# lafdb

라프텔의 애니메이션 데이터를 탐색하고, 재생 환경을 제공하는 **커스텀 웹 플레이어 및 메타데이터 서버**입니다.

## ✨ 특징

* **커스텀 플레이어 엔진**:
  Dedicated Worker 기반의 MSE와 AES-CTR 복호화 로직을 통해 iOS 환경에서도 클리어키 재생을 지원합니다.

* **오프라인 메타데이터 동기화**:
  IndexedDB를 활용해 수만 개의 작품 정보를 로컬에 저장하며, 네트워크 없이도 빠르게 검색하고 탐색할 수 있습니다.

## 🛠 빌드 및 실행

### 사전 요구 사항

* [Bun](https://bun.sh/) — 런타임 및 빌드 도구
* [Go](https://go.dev/) — 백엔드 서버
* [Python 3.10+](https://python.org/) — CDM 서버

### 설치 및 빌드

```bash
# 의존성 설치
bun install

# 프론트엔드 빌드
ln -sf ../THIRD-PARTY-NOTICES.md public/
bun build.mjs

# 백엔드 빌드
go build -o bin/lafdb .
go build -o bin/scraper ./cmd/scraper
go build -o bin/drm ./cmd/drm

# Python 가상환경 설정 (CDM 서버용)
cd scripts
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 서버 실행 (상호작용형)
./run_server.sh
```

---

## ⚙️ 주요 플래그

### 1. 메인 서버 (Main Server)

| 플래그     | 설명  |
| :-------- | :--------------- |
| `--port 4003`    | 서버가 사용할 포트를 설정합니다. |
| `--cf-csp`       | Cloudflare 환경에 맞게 CSP 헤더를 자동으로 조정합니다. |
| `--rebuild-cache`| `laftel/`의 JSON 파일을 다시 스캔해 `data.bin` 인덱스를 재생성합니다. |
| `--no-cache`     | 인덱스를 사용하지 않고 요청 시 JSON을 직접 읽어 메모리 사용량을 줄입니다. |


### 2. 스크래퍼 (Scraper)

```bash
go run cmd/scraper/main.go [flags]
```

| 플래그     | 설명  |
| :-------- | :--------------- |
| `--proxies <path>`| 프록시 리스트 파일 경로 (`ip:port:user:pass`) |
| `--daemon`        | 수집 → DRM 갱신 → 인덱싱 과정을 계속 반복 실행합니다 |
| `--no-skip`       | 기존 데이터를 무시하고 강제로 다시 수집합니다 |

### 3. DRM 도구 (DRM Tool)

```bash
go run cmd/drm/main.go [flags]
```

| 플래그     | 설명  |
| :-------- | :--------------- |
| `--token <token>` | Laftel API 인증 토큰 (DRM 키 획득에 필요) |
| `--decrypt <url>` | CDM 서버 주소 (기본값: `http://127.0.0.1:3040/api/decrypt`) |
| `--sleep <duration>`| 요청 사이의 대기 시간(밀리초). 차단 방지를 위해 16000 이상을 권장합니다. |
| `--skip-failed` | 이전에 실패한 에피소드를 건너뜁니다. |


자세한 플래그는 `grep ':= flag.' internal/server/server.go cmd/*/main.go`로 확인할 수 있습니다.

## 🚀 배포

### 1. 환경 변수 설정

`/etc/default/lafdb` 파일을 생성하고 다음을 설정합니다.

```env
LAFDB_HOME=/path/to/lafdb
LAFTEL_TOKEN=<token>
```

### 2. systemd 서비스 등록

```bash
# 서비스 파일 복사
sudo cp services/*.service /etc/systemd/system/

# 서비스 등록 및 실행
sudo systemctl daemon-reload
sudo systemctl enable --now lafdb-cdm.service
sudo systemctl enable --now lafdb-drm.service
sudo systemctl enable --now lafdb.service
```

### 3. 리버스 프록시 설정 (Caddy 예시)

```caddy
localhost, mediacloud.localhost, streaming-bp.localhost, thumbnail.localhost {

	@preflight method OPTIONS
	handle @preflight {
		header {
			Access-Control-Allow-Origin *
			Access-Control-Allow-Methods "GET, OPTIONS"
			Access-Control-Allow-Headers *
			Access-Control-Expose-Headers "Content-Length, Content-Range, Accept-Ranges"
		}
		respond 204
	}

	header {
		Access-Control-Allow-Origin *
		Access-Control-Allow-Methods "GET, OPTIONS"
		Access-Control-Allow-Headers *
		Access-Control-Expose-Headers "Content-Length, Content-Range, Accept-Ranges"
	}

	reverse_proxy localhost:4003
}
```

## 📂 프로젝트 구조

```bash
bin/        # 컴파일된 Go 바이너리
cmd/        # Go 서브커맨드 (scraper, drm 등)
internal/   # 백엔드 핵심 로직 (server, indexer, drm)
laftel/     # Laftel API 클라이언트
src/        # TypeScript 프론트엔드
public/     # 정적 리소스 및 빌드 결과물
scripts/    # Python CDM 서버 (FastAPI)
services/   # systemd 서비스 설정 파일
```

---

## ⚖️ 라이선스

이 프로젝트는 pywidevine 종속성으로 인해 **GPL-3.0-only**로 배포됩니다.

제3자 오픈소스 라이브러리와 개별 라이선스 고지는 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)에서 확인할 수 있습니다.
