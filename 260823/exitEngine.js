// ═══════════════════════════════════════════════════════════════
// RECON 청산 엔진 — exitEngine.js
//
//   철학: 진입 엔진(momoEngine/swingEngine/coreEngine)과 동일.
//   "규칙은 코드, AI는 자문." 청산 결정은 100% 결정론.
//
//   순수 함수: exitEngine(pos, snap, cfg) → decision
//   - 엔진은 결정만 반환. 매도 실행/손절선 갱신은 호출자(봇·Worker·앱)가 수행.
//   - 실제 체결 없이 상태만 바뀌는 사고를 구조적으로 차단.
//
//   우선순위 사다리 (위가 먼저):
//     1. 손절선 터치        → SELL_ALL  (이익보호선이면 protective 플래그)
//     2. T2 도달            → SELL_ALL
//     3. T1 첫 도달         → SELL_HALF + 손절 BE 이동 제안 + phase 't1_done'
//     4. 모드별 전제 소멸    → SELL_ALL (momo: VWAP 이탈 / core: 펀더 청산조건)
//     5. 시간 청산 (swing)   → SELL_ALL (30일 — 백테스트 보유한도 정합)
//     6. 트레일링 제안       → HOLD + stop_update (절대 하향 없음, 상향만)
//     7. 기본                → HOLD
//
//   백테스트 정합 노트 (2026-06):
//     - swing stop/T1/T2 터치 규칙 = swing-backtest 검증 완료 (+0.80%/47.8%)
//     - swing 30일 시간청산 = 백테스트 보유한도(holdDays=30)와 동일 창
//     - swing MA20 종가 이탈 청산 = ★미검증★ → cfg.swing.useMA20CloseExit 기본 false
//       (swing-backtest.js에 해당 exit 모드 추가해 검증 통과 후 켤 것)
//     - momo/core 규칙 = 플레이북 코드화. TRACK 라이브 측정으로 검증.
// ═══════════════════════════════════════════════════════════════

'use strict';

var EXIT_DEFAULTS = {
  momo: {
    useVwapExit: true,     // 모멘텀 전제 = VWAP 위. 이탈 시 청산.
    vwapLossPct: 0.3,      // VWAP 대비 -0.3% 초과 이탈 시 발동 (노이즈 버퍼)
    useLodExit:  true,     // 당일 저점(LoD) 이탈 = 구조 붕괴
  },
  swing: {
    timeStopDays: 30,        // 백테스트 보유한도와 정합
    t1SellPct: 100,          // ★백테스트 검증(2026-06): T1 전량(+0.56%) > 절반+BE(+0.46%)
    useMA20CloseExit: false, // ★미검증 — 백테스트 통과 전 OFF
    trailAtrMult: 2.0,       // T1 후 트레일: 고점 - 2×ATR (진입 손절폭과 동일 배수)
    earningsWarnDays: 1,     // 어닝 D-1 이내 경고
  },
  core: {
    weeklyMA50CloseLimit: 2, // 주봉 MA50 아래 N주 연속 종가 → 청산 (카드 청산조건)
    trailWeeklyMA50: true,   // 손절선을 주봉 MA50 따라 상향 (래칫)
    ma50TrailPad: 0.97,      // MA50 × 0.97 (휩쏘 버퍼)
  },
};

// ── 유틸 ──
function _n(v){ return (typeof v === 'number' && isFinite(v)) ? v : null; }
function _r2(v){ return parseFloat(Number(v).toFixed(2)); }
function _mergeCfg(base, over){
  var out = {};
  for (var k in base) out[k] = base[k];
  if (over) for (var k2 in over) if (over[k2] !== undefined) out[k2] = over[k2];
  return out;
}

// ═══════════════════════════════════════════════════════════════
// exitEngine(pos, snap, cfgIn)
//
// pos (포지션 — 일지/KV에서):
//   ticker, mode: 'momo'|'swing'|'core'
//   entry, stop, t1, t2          — 현재 저장된 레벨 (0/null = 없음)
//   phase: 'open' | 't1_done'    — T1 절반매도 완료 여부
//   highWatermark                — 보유 중 최고가 (호출자가 유지; 없으면 max(entry, price))
//   entryTs                      — 진입 시각 (ms) — 시간청산용
//
// snap (시장 스냅샷 — 호출자가 수집):
//   price (필수)
//   vwap                — momo
//   atr20               — swing 트레일
//   ma20                — swing (useMA20CloseExit용)
//   closedBelowMA20     — swing: 일봉 종가 < MA20 (bool, 종가 확정 후만 true)
//   earningsDaysAway    — swing
//   weeklyMA50          — core 트레일
//   weeklyClosesBelowMA50 — core: MA50 아래 연속 주봉 종가 수
//   babylonVerdict      — core: 최근 재분석 결과 ('ENTER'|'WATCH_CLAUDE'|'WATCH_WEAK'|'BLOCK')
//   yoySlowdownQuarters — core: YoY 연속 둔화 분기 수
//   stage3              — core: 분배 구간 감지 (bool)
//   rsAdBothFalling     — core: RS + A/D 동시 하락 지속 (bool)
//
// 반환:
//   { ticker, mode, action: 'HOLD'|'SELL_HALF'|'SELL_ALL',
//     sell_pct: 0|50|100,            — 잔여 수량 대비 %
//     urgency: null|'now'|'close',   — now=즉시, close=종가 기준 확인 후
//     protective: bool,              — 손절 터치가 이익보호선(BE/트레일) 터치인지
//     stop_update: number|null,      — 제안 손절선 (항상 현재보다 높을 때만)
//     phase_update: null|'t1_done',
//     pnl_pct, reasons[], warnings[] }
// ═══════════════════════════════════════════════════════════════
function exitEngine(pos, snap, cfgIn){
  var mode = (pos && pos.mode) || 'swing';
  var cfg = {
    momo:  _mergeCfg(EXIT_DEFAULTS.momo,  cfgIn && cfgIn.momo),
    swing: _mergeCfg(EXIT_DEFAULTS.swing, cfgIn && cfgIn.swing),
    core:  _mergeCfg(EXIT_DEFAULTS.core,  cfgIn && cfgIn.core),
  };

  var d = {
    ticker: pos && pos.ticker || '?',
    mode: mode,
    action: 'HOLD', sell_pct: 0,
    urgency: null, protective: false,
    stop_update: null, phase_update: null,
    pnl_pct: null,
    reasons: [], warnings: [],
  };

  var price = _n(snap && snap.price);
  var entry = _n(pos && pos.entry);
  var stop  = _n(pos && pos.stop)  || 0;
  var t1    = _n(pos && pos.t1)    || 0;
  var t2    = _n(pos && pos.t2)    || 0;
  if (!price || price <= 0){ d.warnings.push('시세 없음 — 판단 보류'); return d; }
  if (entry && entry > 0) d.pnl_pct = _r2((price - entry) / entry * 100);

  var t1Done = pos.phase === 't1_done';
  var hw = Math.max(_n(pos.highWatermark) || 0, entry || 0, price);

  // ── 1. 손절선 터치 (최우선 — 백테스트 동시터치 규칙과 동일하게 보수적) ──
  if (stop > 0 && price <= stop){
    d.protective = !!(entry && (stop >= entry || price > entry));
    d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'now';
    d.reasons.push(d.protective
      ? '이익보호선(상향 손절) 터치 $' + stop + ' — 이익 확정 매도'
      : '손절선 터치 $' + stop + ' — 원금 방어 매도');
    return d;
  }

  // ── 2. T2 도달 → 전량 ──
  if (t2 > 0 && price >= t2){
    d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'now';
    d.reasons.push('T2 도달 $' + t2 + ' — 잔량 전량 익절');
    return d;
  }

  // ── 3. T1 첫 도달 → 익절 (백테스트상 전량이 최적; cfg로 절반 전환 가능) ──
  if (t1 > 0 && price >= t1 && !t1Done){
    var t1Pct = (mode === 'swing') ? (cfg.swing.t1SellPct || 100) : 50;
    if (t1Pct >= 100){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'now';
      d.reasons.push('T1 도달 $' + t1 + ' — 전량 익절 (백테스트 최적)');
      return d;
    }
    d.action = 'SELL_HALF'; d.sell_pct = t1Pct; d.urgency = 'now';
    d.phase_update = 't1_done';
    d.reasons.push('T1 도달 $' + t1 + ' — ' + t1Pct + '% 익절');
    if (entry && entry > stop){
      d.stop_update = _r2(entry);
      d.reasons.push('손절 BE 이동 제안 → $' + d.stop_update);
    }
    return d;
  }

  // ── 4. 모드별 전제 소멸 ──
  if (mode === 'momo'){
    var vwap = _n(snap.vwap);
    if (cfg.momo.useVwapExit && vwap && vwap > 0){
      var vwapFloor = vwap * (1 - cfg.momo.vwapLossPct / 100);
      if (price < vwapFloor){
        d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'now';
        d.reasons.push('VWAP -' + cfg.momo.vwapLossPct + '% 이탈 ($' + _r2(vwap) + ') — 모멘텀 전제 소멸');
        return d;
      }
    }
    if (cfg.momo.useLodExit && snap.lodBroken === true){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'now';
      d.reasons.push('당일 저점 이탈 — 일중 구조 붕괴');
      return d;
    }
  }

  if (mode === 'core'){
    var bv = snap.babylonVerdict;
    if (bv === 'BLOCK' || bv === 'WATCH_WEAK'){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
      d.reasons.push('Babylon ' + bv + ' 전환 — 투자 논거 소멸');
      return d;
    }
    if (_n(snap.yoySlowdownQuarters) >= 2){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
      d.reasons.push('매출 YoY ' + snap.yoySlowdownQuarters + '분기 연속 둔화 — 가속 소멸');
      return d;
    }
    if (snap.stage3 === true){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
      d.reasons.push('Stage 3 분배 구간 전환 감지');
      return d;
    }
    if (_n(snap.weeklyClosesBelowMA50) >= cfg.core.weeklyMA50CloseLimit){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
      d.reasons.push('주봉 MA50 아래 ' + snap.weeklyClosesBelowMA50 + '주 연속 종가 — 장기 추세 이탈');
      return d;
    }
    if (snap.rsAdBothFalling === true){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
      d.reasons.push('RS + A/D Line 동시 하락 지속 — 수급 이탈');
      return d;
    }
  }

  if (mode === 'swing'){
    // 시간 청산 — 백테스트 보유한도(30일)와 정합
    var entryTs = _n(pos.entryTs);
    if (entryTs && cfg.swing.timeStopDays > 0){
      var daysHeld = (Date.now() - entryTs) / 86400000;
      if (daysHeld >= cfg.swing.timeStopDays){
        d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
        d.reasons.push('보유 ' + Math.floor(daysHeld) + '일 — 시간 청산 (셋업 유효기간 만료)');
        return d;
      }
    }
    // MA20 종가 이탈 — ★미검증, 기본 OFF★
    if (cfg.swing.useMA20CloseExit && snap.closedBelowMA20 === true){
      d.action = 'SELL_ALL'; d.sell_pct = 100; d.urgency = 'close';
      d.reasons.push('일봉 종가 MA20 이탈 — 추세 전제 소멸 [미검증 규칙]');
      return d;
    }
    // 어닝 경고 (강제 매도 아님 — 갭 리스크 알림)
    var eDays = _n(snap.earningsDaysAway);
    if (eDays !== null && eDays >= 0 && eDays <= cfg.swing.earningsWarnDays){
      d.warnings.push('어닝 D-' + eDays + ' — 갭 리스크, 축소/청산 검토');
    }
  }

  // ── 5. 트레일링 제안 (HOLD 유지, 손절선 상향만 — 래칫) ──
  var trailCandidates = [];
  if (mode === 'momo' && t1Done){
    if (entry) trailCandidates.push(entry);                       // BE 최소
    var v2 = _n(snap.vwap);
    if (v2 && v2 > 0) trailCandidates.push(v2 * 0.995);          // VWAP 살짝 아래
  }
  if (mode === 'swing' && t1Done){
    if (entry) trailCandidates.push(entry);                       // BE 최소
    var atr = _n(snap.atr20);
    if (atr && atr > 0) trailCandidates.push(hw - cfg.swing.trailAtrMult * atr); // 고점-2×ATR
  }
  if (mode === 'core' && cfg.core.trailWeeklyMA50){
    var wma = _n(snap.weeklyMA50);
    if (wma && wma > 0) trailCandidates.push(wma * cfg.core.ma50TrailPad);       // 주봉 MA50 래칫
  }
  if (trailCandidates.length){
    var cand = _r2(Math.max.apply(null, trailCandidates));
    if (cand > stop && cand < price){                             // 상향만 + 현재가 아래만
      d.stop_update = cand;
      d.reasons.push('트레일링 손절 상향 제안 → $' + cand + ' (현행 $' + stop + ')');
    }
  }

  if (!d.reasons.length) d.reasons.push('청산 조건 미충족 — 보유 유지');
  return d;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { exitEngine: exitEngine, EXIT_DEFAULTS: EXIT_DEFAULTS };
}
if (typeof window !== 'undefined'){
  window.exitEngine = exitEngine;
  window.EXIT_DEFAULTS = EXIT_DEFAULTS;
}
