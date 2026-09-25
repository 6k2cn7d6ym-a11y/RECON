# RECON — Claude Code / 팀 세션 작업 지침

미국 주식 트레이딩 분석 PWA. **규칙 엔진이 신호를 만들고 사람이 결정한다.**
Jim(대표님) 개인용 자문 도구 — 자동 체결 없음. 앱 일지는 "대표님 의도의 기록"이지 "계좌의 진실"이 아니다.

이 문서는 두 청중이 함께 본다:
1. **Jim이 Claude Code로 이 리포에 직접 코딩할 때** — 아래 규칙 그대로.
2. **민온 디스패처 팀 세션이 이 프로젝트 방을 열 때** — 팀들이 현재 상태·아키텍처·규칙 파악용.

---

## 0. 가장 중요한 것 (어기면 작업 거부당함)

1. **"AI는 자문, 규칙은 코드."** — 매수/매도/사이징 결정은 결정론 엔진(momo/swing/exit/size/core/babylon)이 낸다. Claude(LLM)는 **이유 설명만.** 새 규칙은 프롬프트가 아니라 엔진 코드에 박는다.
2. **검증 안 된 직관으로 임계값/필터를 박지 마라.** ★가장 중요★ — "이렇게 하면 승률 오를 것 같다"는 근거 아니다. 필터·임계값 변경 시 **백테스트로 기대값 개선 먼저 증명.** 못 하면 넣지 마라. 실제로 가격 상한 필터가 기대값을 +1.13% → +0.70%로 훼손한 적 있음.
3. **"수익성"과 "계좌 적합성"을 섞지 마라.** — 가격/시총 상한은 계좌 사정이지 수익성 필터가 아니다. sizeEngine이 수량으로 조절한다. 변동성은 **ATR%로 직접 측정** (시총·가격은 부정확한 대리지표).
4. **판정을 함부로 바꾸지 마라 — 검증 전엔 "표시만".** 새 지표(RS 등)는 카드에 표시+captureReconSignal 기록만. 거래 쌓여서 사후 분석 통과한 다음에 점수 반영.
5. **카드는 침묵이 기본. 문제 있을 때만 경고.** 정보 빽빽하게 만들지 마라. data_confidence, RVol 측정불가, 갭리스크, 어닝 임박 배지 전부 "해당될 때만" 뜬다.
6. **CORE는 단기 승률로 평가하지 마라.** 12개월 초과수익률 대상이다. 손절가 개념 약함, 펀더가 기준. SWING과 반대로 카드도 액션 중심(추가매수/매도/홀드)이지 손절선 중심 아님.
7. **워커는 가격만 안다 — 아는 척 금지.** 텔레그램 알람 워커(Cloudflare)는 SEC 안 본다. "펀더 훼손!" 단정 금지. "가격 이렇게 됐어, 앱에서 재분석해" 까지만.
8. **툴 rejection ≠ 대표님 거부.** Bash 등이 실패로 돌아올 때 "user doesn't want to proceed" 문구가 종종 붙지만 이건 권한·타임아웃·시스템 rejection일 수 있음. "거부하셨다"고 결론짓지 말고 상태만 보고.

---

## 1. 작업 스타일

- 1인 개발자 + 실전 트레이더.
- **감정 없는 논리를 선호한다.** 위로·빈말·격려 늘어놓지 마라. 사실과 근거로만.
- **직접 교정으로 빠르게 반복한다.** 긴 토론보다 "이렇게 고쳤어 → 정정 → 다시 고침" 사이클.
- **본인 전제도 심문받아야 한다고 본다.** "내가 쓴 걸 내가 옹호하는 것도 편향." 이전 판단을 성역으로 두지 마라. 대표님이 "막으려고 맞춘 거냐"고 물으면 방어 말고 재검증.
- **반대 의견 정직하게 원한다.** 대표님이 "이거 하자" 해도 검증 안 된 직관이면 정중히 멈추고 이유 설명. 알고도 하겠다면 그때 따른다.
- 모든 대화는 **한국어**로.

---

## 2. 아키텍처 (파일 구성)

### 프론트 (GitHub Pages)
| 파일 | 역할 | 규모 |
|---|---|---|
| `index.html` | 단일파일 PWA 본체 (UI + fetch + 카드 렌더 + 인라인 로직) | 11,818줄 |
| `momoEngine.js` | MOMO 당일 급등 진입 (P&D 방어 + R:R 게이트) | 580줄 |
| `swingEngine.js` | SWING 스윙 진입 (8조건 + 타입 A/B/C + 이격 게이트) | 595줄 |
| `exitEngine.js` | 보유 청산 결정 (swing/momo 1차 결정자) | 263줄 |
| `sizeEngine.js` | 포지션 사이징 (계좌 리스크 기반 권장 수량) | 164줄 |

- **`swing-backtest.js`, `sweep.js`, `cond-sweep.js` 는 현재 로컬에 없음.** 과거 도구로 현재 날짜 폴더에 존재하지 않는다.
- **`coreEngine` / `babylonEngine`은 `index.html` 안에 인라인**으로 있다 (별도 파일 아님). coreEngine: 6300줄, babylonEngine: 11,147줄, detectExitSignals: 11,705줄.
- index.html이 4개 엔진을 `<script src>`로 로드 (791~794줄, 순서: momo → swing → exit → size).

### 워커 (Cloudflare Workers, 별도 리포)
- `worker.js` — 텔레그램 알람 · 포지션 동기화 · API 프록시 (~1,250줄)
- **`GitHub 푸시로 워커 갱신 안 됨.` 대시보드 또는 wrangler로 별개 배포.**
- WORKER_URL = `https://recon.miinonnnn.workers.dev`
- SEC 프록시 = `https://dart.minon.kr/sec`

### 봇 (recon-bot 리포, `/Users/jim/projects/recon-bot`)
- `dataAdapter.js`, `exitEngine.js`, `momoEngine.js`, `notify.js`, `recon-net.js`, `run.js`, `sizeEngine.js`, `swingEngine.js`
- 봇용 엔진 사본 유지 (Node 실행 · 시장 시간 스캔 · 알람 발송). 프론트 엔진 로직 바꾸면 여기도 반영 필요할 수 있음.

### 엔진 export 패턴 (깨지 마라)
모든 엔진 dual export: `module.exports`(Node 백테스트·봇) + `window.X`(브라우저).
```js
if (typeof module !== 'undefined' && module.exports) { module.exports = {...}; }
else { window.engineName = engineName; }
```

### 스택
- 호스팅: GitHub Pages
- 빌드 시스템 **없음** — 단일파일 직접 편집이 대표님 선호 패턴
- 루트 = 유일한 작업·배포 경로 (★ 2026-09-25 이관). 날짜 폴더는 폐지, 과거 폴더는 `archive/`(로컬 전용·`.gitignore`), 시점 스냅샷은 `git tag snap-YYMMDD`. 연구·검수 파일(`review_*.cjs`, `baseline_*.json`, `proposal_*.json`, `fixtures/` 등)은 루트에 두되 `.gitignore`로 커밋 제외.
- sandbox/ 폴더: `.sandbox-marker` 파일만 있음. `.gitignore`에 포함되어 git 추적 제외.

---

## 3. 각 엔진의 핵심 (건드릴 때 알아야 할 것)

### MOMO (momoEngine.js)
- **성격**: 승률형이 아니라 **방어형**. "쓰레기 급등주(P&D) 차단"이 주특기. 진입 승률은 미검증.
- **P&D 하드필터**: 갭 80%+뉴스없음, Float 2M미만+RVol 30x이상, 스프레드 2.5%초과, P&D점수 65이상 → BLOCK.
- **슬리피지 보정 R:R 하드 게이트** (엔진 강제): 실효 R:R < 0.8 → BLOCK, < 1.2 → WATCH. 프롬프트가 아니라 엔진에 박혀 있다.
- **보유 포지션은 신규 프리필터 스킵** (`mode==='momo' && !openTrade`). 아침 진입 종목이 오후에 BLOCK 카드 뜨는 버그 방지. 보유 질문은 "들어갈까"가 아니라 "나가야 하나"다.
- **data_confidence**: 시세 stale / 호가 없음 / RVol 측정불가 → ENTER→WATCH 강등 + 사유 표시 (MOMO만).

### SWING (swingEngine.js)
- **성격**: 세 전략 중 **가장 트레이딩 시스템답고 승률 가능성 높음.** 실전 검증 1순위.
- **8조건**: 정배열, 200일선위, MA20눌림, 양봉, RSI(40~상단), MACD히스토그램상승, MA20기울기, 거래량1.5배+양봉.
- **타입별 핵심조건(SWING_TYPE_CORE)**: A(눌림목)=거래량 면제, B(돌파)=거래량 필수, C(반전)=거래량 면제. **눌림목은 거래량이 마르는 게 정상**이라 일부러 면제. 거래량 필수로 바꾸지 마라.
- **swingFitness 필터** (백테스트 검증): 초저가($10미만)·저변동(ATR%<2.5%)·저유동(평균<50만주)·거래고갈(RVol<0.3x) 제외. **가격/시총 상한은 의도적으로 뺐다** (백테스트가 기대값 훼손 증명). 다시 넣지 마라.
- **MA20 이격 과열 게이트** (엔진 강제): 이격 8%+ & 타입≠B → WATCH, 15%+ 전타입 WATCH. Type B는 8% 예외(돌파는 본질이 이격). "스윙은 놓쳤으면 보낸다."
- **스크리너 소스**: Yahoo predefined 3종(undervalued_growth / growth_technology / most_shorted), 각 count=25, 중복 제거 → ~74개. 매번 fresh fetch (고정 리스트 아님). predefined엔 추가할 스윙 렌즈가 사실상 없음.
- **상대강도(rs_spy)**: 이미 계산됨(13주). **표시+추적만, 점수 미반영** (검증 전 원칙).

### CORE (index.html 인라인 coreEngine + babylonEngine)
- **성격**: 승률 로직 아님. **장기 성장주 조기 발굴 리서치.** 12개월 초과수익률로 평가. 단기 승률로 평가하면 범주 오류.
- **두 축 분리**: babylon(SEC 펀더) + setup(매집·타이밍). 매트릭스로 합성.
- **펀더 훼손 = babylonEngine.detectExitSignals** (결정론 5규칙):
  - EXIT_1: 2분기 연속 YoY 10%p+ 감속 (warn)
  - EXIT_2: 매출 YoY 마이너스 (exit)
  - EXIT_3: YoY 피크 +30%↑ → 50%p+ 폭락 (exit)
  - EXIT_4: 영업이익률 3분기 연속 YoY 악화 (warn)
  - EXIT_5: pull-forward(+150%) 후 연속 감속 (exit)
  - severity=exit 하나라도 있으면 SELL 적극 고려. 없으면 단순 하락은 매도 금지.
- babylon exit_signals가 보유 재분석 프롬프트에 주입됨(`_makeHoldPrompt`). **주의**: makePrompt는 openTrade면 `_makeHoldPrompt`로 즉시 위임. 보유 프롬프트 수정은 `_makeHoldPrompt` 안에서 (과거 도달 불가 코드 만든 적 있음).
- **valuation 과확장 태그**: PER/PSR 하드필터 **아님**(고성장주엔 무의미). MA200 +40%이격 / 52주고점근접 / 베이스없는+30%급등 중 2개+ 겹치면 "💰 과확장" 경고. 매도 사유 아니라 "진입가 비쌈" 경고. base_tightening이면 제외.

### exitEngine.js
- 보유(swing/momo) **1차 청산 결정자.** pos(entry/stop/t1/t2/phase/highWatermark) + snap(price/vwap/atr20/lodBroken/closedBelowMA20/earningsDaysAway) → SELL_ALL / SELL_HALF / HOLD.
- **엔진 우선**: exitEngine이 SELL이면 Claude가 HOLD라 해도 엔진 SELL이 이긴다. `exitSignal.engine_action`에 원본 보존(투명성).

### sizeEngine.js
- 계좌 평가액·거래당 리스크·종목당 최대비중 → 권장 수량.
- 임상 catalyst면 `clinicalMult=0.3`로 수량 1/3 강제 축소.
- **진입 기록에 강제됨**: saveTradeLog가 entry>0, shares>0 필수. SWING/MOMO는 stop>0 필수(CORE는 펀더 기준이라 면제). 실리스크 한도 초과 시 경고. 고스트 포지션(0주/손절0인데 watch:true) 방지.

---

## 4. 포지션 동기화 (알려진 함정)

- 앱↔워커 포지션 동기화는 **ticker 기준 머지 + tombstone 모델**.
- **함정**: 삭제 시 tombstone(`deleted:true, deletedAt`)을 서버에 보내야 지워진다. 그냥 목록에서 빼면 서버는 "incoming에 없네 → cloud 유지" → **유령 포지션**. `journalUnwatch`가 tombstone 보내지만 같은 ticker에 다른 로트가 live면 안 보냄(stillLive 가드).
- 유령 제거 엔드포인트 (worker.js):
  - `POST /recon/positions` `{mode, clear:true}` (전체 비우기)
  - `POST /recon/positions` `{mode, removeTickers:[...]}` (특정 종목)
- 서버 현황 조회: `GET /recon/positions?mode=swing`

---

## 5. 추적 시스템 (포워드 검증)

- **captureReconSignal**: MOMO/SWING에서 ENTER/WATCH 나오면 자동 기록. 피처 스냅샷(type, RSI, 거래량, 갭, rs_spy, VIX 등). API 비용 0.
- 백테스트가 아니라 **포워드 추적**: 지금 검색한 종목을 시간 지나서 결과 확인. TRACK_WINDOWS — momo: 당일+1일 / swing: +2주+1달.
- **결과는 앱을 열 때 갱신**된다(백그라운드 서버 아님). 일주일에 한두 번은 열어야 만기 추적이 판정됨.
- **타입별 성과 패널(buildTrackStatsPanel)**: 체결 3건+이면 타입별 승률/평균R/T1도달률/손절률 표시. 평균R 음수(5건+)면 "이 타입 제외 검토" 경고. **이게 깔려야 점수 80이 "그럴듯한 숫자"를 벗어난다.**

---

## 6. 검증 방법 (편집 후 필수)

### 인라인 JS (index.html)
Python으로 `<script>` 블록 추출 후 `node --check`:
```bash
python3 -c "import re; s=open('index.html',encoding='utf-8').read(); blocks=[m.group(1) for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', s, flags=re.S)]; open('/tmp/chk.js','w',encoding='utf-8').write('\n;\n'.join(blocks))"
node --check /tmp/chk.js
```

### 엔진 .js
직접 `node --check momoEngine.js` (swing/exit/size도 동일)

### 로직 검증
- 엔진 로직 바꿨으면 **단위 테스트** (`node -e`로 케이스 돌려보기).
- 백테스트 영향이면 `swing-backtest.js` 실행.

### 배포 확인 마커
- `swingEngine.js`에 `window.SWING_ENGINE_VERSION`.
- index.html 설정탭이 값 동적 로드 → 최신=초록, 없으면 주황 "구버전 강제 새로고침".
- 엔진 크게 바꾸면 마커 날짜/태그 갱신.

---

## 7. 배포 흐름

| 대상 | 배포처 | 방법 |
|---|---|---|
| index.html / 엔진 .js / sw.js | GitHub Pages | 대표 "머지 승인" 후 `git checkout main && git fetch origin && git merge --no-ff dev && git push origin main` |
| worker.js | Cloudflare Workers | 대시보드 또는 wrangler (**GitHub과 별개**) |
| recon-bot | 로컬/서버 실행 | 별도 리포 배포 |

- **GitHub 리포**: `https://github.com/6k2cn7d6ym-a11y/RECON`
- **Pages URL**: `https://6k2cn7d6ym-a11y.github.io/RECON/`
- **브랜치 규칙 (★ 2026-09-25)**: 작업은 `dev`에서만. `main` push = 즉시 배포이므로 대표 채팅 "머지 승인" 전에는 금지, 위반 시 즉시 revert. force push 금지. 리모트 인증은 SSH 키(`~/.ssh/github_minon`).
- **`sw.js`는 루트에 있으며 서비스워커 등록(`/RECON/sw.js`)이 참조한다.** 삭제 금지. 커밋 전 `git status --short | grep '^ D'`가 0건인지 확인.
- **`deploy.sh`는 폐기**: 날짜 폴더를 전제로 하므로 이관 후 동작하지 않는다. 사용 금지.
- **주의**: worker.js를 GitHub에 올린다고 워커가 갱신되지 않는다. 매번 별도 배포 필요.
- pm2·firebase 배포 흐름은 여기 없음(민온 디스패처와 다름). RECON은 단순 정적 호스팅.

---

## 8. 외부 비판을 다루는 법

RECON은 외부 비평(GPT·타 LLM·백테스트 리뷰)을 자주 받는다:

1. **메타부터 파악하라** — 비평가가 RECON을 뭐라고 가정했나? (예: "자동 체결 시스템"으로 오해하면 비판 절반 빗나감. RECON은 자문 도구다.)
2. **수긍/반박 가른다** — 정당한 지적은 겸허히 받고, 전제 틀린 건 근거로 반박.
3. **받아들일 땐 RECON 철학에 맞게** — 비평가 해법 그대로 쓰지 말고, "AI는 자문, 규칙은 코드"에 맞는 방향으로.
4. **과최적화 경계** — "상대 임계값으로 바꿔라" 같은 제안은 복잡도·과최적화 키울 수 있음. 단, 백테스트가 단일 regime(강세장)이라 강건성 반박에 한계 있는 것도 인정.

---

## 9. 현재 상태 (2026-07-17 기준)

### ✅ 완료 · 안정
- **엔진 4종 dual export 구조 정착** (momo/swing/exit/size 모두 브라우저·Node 동시 로드)
- **P&D 하드필터·R:R 게이트·MA20 이격 게이트** 엔진 강제 적용
- **swingFitness 필터**: 백테스트로 기대값 훼손 없음 확인, 봇 안정성 확보 위해 유지
- **babylonEngine 5규칙**: SEC 분기 기반 결정론 판정. `_makeHoldPrompt`에 exit_signals 주입
- **포워드 추적 인프라(captureReconSignal + buildTrackStatsPanel)** 가동 중
- **포지션 동기화 tombstone 모델** 정착 (`journalUnwatch`가 stillLive 가드로 처리)
- **CORE 리서치 산출물**: `core_research_phase1.md`, `core_research_phase2_v2.md` — 메가 자이언트 "베이비 시절" 8+38개 케이스 감지 시그널 정리
- **일지 mode 방어 완료 (2026-07-15)**: `saveTradeLog` 모드 필수 검증 추가. `pushJournal`·`syncJournalWatch`·`journalUnwatch`·`mergeJournalLocal`·`renderOpenPositions` 에서 `t.mode || 'momo'` 폴백 제거 + `console.warn`. mode 없는 거래가 momo 버킷으로 오염되는 사일런트 버그 차단. `stop > entry` 시 confirm 팝업으로 이익보호선(트레일링 업) 여부 확인.
- **자동 배포 세팅 (2026-07-15)**: `deploy.sh` (루트에서 `./deploy.sh`) — 최신 날짜 폴더 → GitHub Pages 자동 push. SSH 키(`~/.ssh/github_minon`) 사용.

### ⏳ 진행 중 / 부분
- **rs_spy 표시+추적만, 점수 미반영** — 사후 분석 위해 데이터 쌓는 중
- **CORE 엔진 세부화**: Phase 2 v2 리서치 기반으로 감지 규칙 수치 확정 작업
- **타입별 성과 패널 검증**: 3건+ 체결 쌓이면 판정 시작. 데이터 축적 중

### 🔴 알려진 이슈 · 함정
- **워커·프론트 별개 배포** — 워커 갱신 잊고 프론트만 배포하는 실수 조심
- **인라인 프롬프트 도달 불가 코드** — makePrompt가 openTrade면 `_makeHoldPrompt`로 즉시 위임. 보유 프롬프트 수정은 반드시 `_makeHoldPrompt` 안에서
- **captureReconSignal 만기 갱신은 앱 열 때만** — 백그라운드 없음. 대표님이 앱 안 열면 판정 늦어짐
- **recon-bot과 프론트 엔진 로직 동기화** — 봇 리포에 엔진 사본 있음. 프론트만 바꾸면 봇은 옛 로직
- **CORE 일지 기본 필터 = '오늘' (의도적)** — 워커에 CORE 거래 있어도 기본 화면은 빈 것처럼 보임. "전체" 버튼 클릭 필요. 진단 시 먼저 워커 API 직접 조회: `GET https://recon.miinonnnn.workers.dev/recon/journal?mode=core`

---

## 10. 작업 폴더 규칙 (Claude Code 세션 시작 시 자동 적용)

★ 2026-09-25 이관: **날짜 폴더를 만들지 않는다.** 루트가 유일한 작업 경로다.

1. `git branch --show-current`가 `dev`인지 확인. 아니면 `git checkout dev`.
2. 편집은 루트 파일에서 직접 한다. 작업 전 스냅샷이 필요하면 `git tag snap-YYMMDD`.
3. `archive/`는 읽기 전용 이력이다. 수정·배포 대상이 아니다.
4. 커밋은 dev에만. `main` 머지·push는 대표 "머지 승인" 이후에만.

배포 대상 파일: `index.html`, `momoEngine.js`, `swingEngine.js`, `exitEngine.js`, `sizeEngine.js`, `babylonEngine.js`, `sw.js`.

---

## 11. 작업 마무리 체크리스트

1. 편집한 파일 `node --check` (인라인은 추출 후) 통과 확인.
2. 엔진 로직 바꿨으면 단위 테스트로 의도대로 작동 검증.
3. 필터/임계값 바꿨으면 → 기대값 영향 확인 (swing-backtest.js는 현재 로컬에 없음. 단위 테스트로 로직 검증 후 "검증 안 됨" 명시).
4. 배포 대상 명확히: index.html/엔진 = GitHub, worker.js = Cloudflare (별개!).
5. recon-bot에도 반영 필요한지 확인 (엔진 파일 바꿨을 때).
6. 엔진 크게 바꿨으면 `SWING_ENGINE_VERSION` 마커 갱신.
7. 대표님께 **무엇을 왜 바꿨는지 간결히** 보고. 길게 늘어놓지 마라.

---

## 한 줄 요약

**분석보다 검증. 점수보다 리스크. 신호보다 체결. 설명보다 규칙. 직관보다 데이터.**
검증 안 된 직관으로 시스템을 건드리지 마라. 이 프로젝트에서 가장 중요한 한 가지다.
