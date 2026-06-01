// ═══════════════════════════════════════════════════════════════
// swingEngine.js  —  RECON SWING 결정 엔진
// 분리일: 2026-06 / 개선일: 2026-06
//
// 설계 원칙
//   1. MOMO 개념 일절 없음 (갭업%, RVol, PM고점, ORB, intraday 응집, 당일 상대강도 x)
//   2. T1/T2는 이 파일이 단독 계산 — calcSellTargets()는 r.target1/r.target2 재사용만 함
//   3. calcSwingEntrySignal()은 반드시 엔진 score ≥ SWING_ENTER_SCORE 또는
//      타입별 핵심조건 충족 후 발화
//   4. 외부 의존: window.G (VIX, spyAboveMA200), LEVERAGE_ETF_MAP
//
// 점수 체계 (v2)
//   기본: 타입별 핵심조건 충족 수 / 핵심조건 수 × 100
//   타입 미확정: conditions_met / 8 × 100
//   보너스/감점: 시장 구조만 (SPY MA200, 주봉 추세) — 개별 조건 이중 반영 없음
//
// ENTER 기준 (엔진 자체 판단 — Claude 전적 위임 제거)
//   ENTER: score ≥ 70 AND 타입별 핵심조건 모두 충족 AND BLOCK 없음
//   WATCH: score ≥ 40 AND conditions_met ≥ 4
//   BLOCK: 그 외 (최소 미달, 거시 게이트)
//
// 내보내는 함수
//   swingEngine(ydata, swingData)  → r 객체
//   calcSwingEntrySignal(r)        → { signal, icon, label, reason, trigger, css }
// ═══════════════════════════════════════════════════════════════

'use strict';

// ── 상수 ──
var SWING_ENTER_SCORE  = 70;  // ENTER 최소 점수
var SWING_WATCH_SCORE  = 40;  // WATCH 최소 점수
var SWING_MIN_COND     = 4;   // 진입 신호 발화 최소 조건 수
var SWING_T1_MIN_DIST  = 0.02;
var SWING_T2_MIN_GAP   = 0.05;

// ── 타입별 핵심 조건 정의 ──
// 각 타입에서 반드시 충족해야 할 조건 인덱스 (0-based: c1=0 ... c8=7)
// 핵심 조건이 하나라도 빠지면 ENTER 불가 (WATCH로 강등)
var SWING_TYPE_CORE = {
  'A': [0, 1, 2, 5, 6],   // C1정배열 C2MA200 C3눌림목 C6MACD C7기울기
  'B': [1, 4, 5, 7],      // C2MA200 C5RSI C6MACD C8거래량 (C3눌림목 제외 — 돌파형)
  'C': [1, 5, 6],         // C2MA200 C5RSI C6MACD (반전형 — 거래량고갈은 별도 체크)
};

// ═══════════════════════════════════════════════════════════════
// swingEngine
// ═══════════════════════════════════════════════════════════════
function swingEngine(ydata, swingData) {
  var r = {
    action: 'WATCH', score: 0, position_size: 'none',
    blockers: [], warnings: [], signals: [],
    entry: null, stop: null, target1: null, target2: null,
    rr: null, rr2: null,
    conditions_met: 0, swing_detail: [],
    _coresMet: false,  // 타입별 핵심조건 모두 충족 여부
  };

  if (!swingData) {
    r.blockers.push('기술 데이터 부족');
    r.action = 'BLOCK';
    return r;
  }

  r.conditions_met = swingData.conditions_met || 0;
  r.swing_detail   = swingData.condition_detail || [];

  var price = ydata.price;
  var ma20  = swingData.ma20;
  var ma60  = swingData.ma60;

  var swingMinT1Pct = parseFloat(
    ((document.getElementById('swingMinT1Pct') || {textContent: '8'}).textContent) || '8'
  );

  // ══════════════════════════════════════
  // 1. 거시 게이트 (VIX + 주봉 MA + 어닝)
  // ══════════════════════════════════════
  var vix = (typeof G !== 'undefined' && G.vixLevel) || null;
  var vixRegime = (typeof G !== 'undefined' && G.vixRegime) || 'UNKNOWN';
  if (vixRegime === 'FEAR') {
    r.action = 'BLOCK';
    r.blockers.push('[VIX] ' + vix + ' — 공포 국면 (35+), 스윙 진입 전면 중단');
    return r;
  }
  if (vixRegime === 'STRESS') {
    r.warnings.push('[VIX] ' + vix + ' — 스트레스 국면 (25~35): 포지션 최소화, 손절 엄수');
  } else if (vixRegime === 'CAUTION') {
    r.warnings.push('[VIX] ' + vix + ' — 주의 국면 (20~25): 포지션 축소 권고');
  } else if (vix !== null) {
    r.signals.push('VIX ' + vix + ' — 안정 국면');
  }

  if (swingData.ma100 && price) {
    if (price > swingData.ma100) {
      r.signals.push('주봉 MA20(100일) 위 — 중기 상승 구조');
      if (swingData.weeklySlope !== null && swingData.weeklySlope > 0)
        r.signals.push('주봉 MA20 기울기 상승 (' + swingData.weeklySlope + '%)');
    } else {
      r.warnings.push('[주봉] MA20(100일) 아래 — 중기 추세 약세, 진입 신중');
    }
  }

  var earnDays = ydata.earningsDaysAway;
  if (earnDays !== null && earnDays !== undefined) {
    if (earnDays >= 0 && earnDays <= 7) {
      r.action = 'BLOCK';
      r.blockers.push('[어닝] ' + earnDays + '일 후 실적 발표 — 이벤트 리스크 BLOCK');
      return r;
    } else if (earnDays > 7 && earnDays <= 14) {
      r.warnings.push('[어닝] ' + earnDays + '일 후 실적 발표 — 포지션 50% 이하 권고');
    }
  }

  // ══════════════════════════════════════
  // 2. 진입각 계산 (일봉 MA 기준)
  //  A) MA20 ±3% 이내 → MA20*1.005
  //  B) MA60 ±3% 이내 → MA60*1.005
  //  C) MA20 +3~15%   → price*0.99
  //  D) MA20 +15% 초과 → 현재가
  //  E) 기타 → MA20*1.01 or fallback
  // ══════════════════════════════════════
  if (price) {
    var sEntry;
    var ma20Gap = ma20 ? (price - ma20) / ma20 * 100 : null;

    if (ma20 && swingData.pullback_to_ma20)                  sEntry = parseFloat((ma20 * 1.005).toFixed(2));
    else if (ma60 && Math.abs((price - ma60) / ma60) <= 0.03) sEntry = parseFloat((ma60 * 1.005).toFixed(2));
    else if (ma20Gap !== null && ma20Gap > 15)               sEntry = parseFloat(price.toFixed(2));
    else if (ma20Gap !== null && ma20Gap > 3)                sEntry = parseFloat((price * 0.99).toFixed(2));
    else if (ma20)                                           sEntry = parseFloat((ma20 * 1.01).toFixed(2));
    else                                                     sEntry = parseFloat(price.toFixed(2));

    var isLargeGap = ma20Gap !== null && ma20Gap > 15;
    var stopMult   = isLargeGap ? 0.93 : 0.95;
    var ma20Stop   = (!isLargeGap && ma20) ? parseFloat((ma20 * 0.97).toFixed(2)) : null;
    var sStop = parseFloat(Math.max(
      sEntry * stopMult,
      ma20Stop !== null ? ma20Stop : 0
    ).toFixed(2));
    var sRisk = sEntry - sStop;
    var stopPctActual = sRisk > 0 ? ((sStop - sEntry) / sEntry * 100).toFixed(0) : '-5';

    // ── T1/T2: 저항 사다리 ──
    var _levels = swingData.resistanceLevels || [];
    var _above  = [];
    for (var li = 0; li < _levels.length; li++) {
      if (_levels[li].price > sEntry * (1 + SWING_T1_MIN_DIST)) _above.push(_levels[li]);
    }

    var sT1, sT2, t1Src = 'resistance', t2Src = 'resistance';
    var t1Strong = false, t2Strong = false;

    if (_above.length > 0) {
      var _z1 = _above[0];
      sT1      = parseFloat((_z1.price * 0.99).toFixed(2));
      t1Strong = !!_z1.strong;
      var _z2  = null;
      for (var li2 = 1; li2 < _above.length; li2++) {
        if (_above[li2].price >= _z1.price * (1 + SWING_T2_MIN_GAP)) { _z2 = _above[li2]; break; }
      }
      if (_z2) {
        sT2 = parseFloat((_z2.price * 0.99).toFixed(2)); t2Strong = !!_z2.strong;
      } else {
        var _atr2 = swingData.atr20 ? parseFloat((sEntry + swingData.atr20 * 8).toFixed(2)) : 0;
        sT2 = Math.max(_atr2, parseFloat((sT1 * 1.12).toFixed(2))); t2Src = 'est';
      }
    } else {
      t1Src = 'est'; t2Src = 'est';
      var _a3 = swingData.atr20 ? parseFloat((sEntry + swingData.atr20 * 3).toFixed(2)) : 0;
      sT1 = Math.max(_a3, parseFloat((sEntry * 1.10).toFixed(2)));
      var _a8 = swingData.atr20 ? parseFloat((sEntry + swingData.atr20 * 8).toFixed(2)) : 0;
      sT2 = Math.max(_a8, parseFloat((sEntry * 1.25).toFixed(2)));
    }
    if (sT2 < sT1 * 1.10) sT2 = parseFloat((sT1 * 1.15).toFixed(2));

    var sRR  = sRisk > 0 ? parseFloat(((sT1 - sEntry) / sRisk).toFixed(1)) : null;
    var sRR2 = sRisk > 0 ? parseFloat(((sT2 - sEntry) / sRisk).toFixed(1)) : null;
    var sT1Pct = parseFloat(((sT1 - sEntry) / sEntry * 100).toFixed(1));
    var sT2Pct = parseFloat(((sT2 - sEntry) / sEntry * 100).toFixed(1));

    r.entry = sEntry; r.stop = sStop;
    r.target1 = sT1;  r.target2 = sT2;
    r.rr = sRR; r.rr2 = sRR2;
    r.target1_pct = sT1Pct; r.target2_pct = sT2Pct;
    r.t1_src = t1Src; r.t2_src = t2Src;
    r.t1_strong = t1Strong; r.t2_strong = t2Strong;
    r.stop_type = '손절(' + stopPctActual + '%)';
    r.vpoc = swingData.vpoc || null;
  }

  // ══════════════════════════════════════
  // 3. 점수 계산 — 타입별 가중치
  //
  // 타입 확정 시: 핵심조건 충족 수 / 핵심조건 수 × 100
  //   → Type B는 C3(눌림목) 없어도 감점 없음
  //   → Type C는 C3/C4 없어도 감점 없음
  // 타입 미확정: conditions_met / 8 × 100
  // 시장 구조 보너스/감점만 추가
  // ══════════════════════════════════════
  var swingType = swingData.swing_type || null;
  r.swing_type = swingType;

  // 조건 배열 (fetchSwingData가 계산한 boolean 목록)
  var condBools = swingData.condition_bools || null;  // [c1,c2,...,c8] — 없으면 fallback

  var score;
  var coresMet = false;

  if (swingType && SWING_TYPE_CORE[swingType] && condBools && condBools.length === 8) {
    // 타입별 핵심조건 점수
    var coreIdxs   = SWING_TYPE_CORE[swingType];
    var corePassed = coreIdxs.filter(function(i) { return !!condBools[i]; }).length;
    score = Math.round(corePassed / coreIdxs.length * 100);
    coresMet = (corePassed === coreIdxs.length);

    // 핵심 외 조건도 소폭 반영 (최대 +15)
    var extraPassed = 0;
    for (var ei = 0; ei < 8; ei++) {
      if (coreIdxs.indexOf(ei) === -1 && condBools[ei]) extraPassed++;
    }
    score = Math.min(100, score + Math.round(extraPassed / (8 - coreIdxs.length) * 15));

    // 신호 텍스트
    r.signals.push('Type ' + swingType + ' 핵심조건 ' + corePassed + '/' + coreIdxs.length + ' 충족');
    if (!coresMet) {
      var missingLabels = coreIdxs
        .filter(function(i) { return !condBools[i]; })
        .map(function(i) { return ['C1정배열','C2MA200','C3눌림목','C4양봉흐름','C5RSI','C6MACD','C7기울기','C8거래량'][i]; });
      r.warnings.push('[Type ' + swingType + '] 핵심조건 미충족: ' + missingLabels.join(', '));
    }
  } else {
    // fallback: conditions_met 기반
    score = Math.round(r.conditions_met / 8 * 100);
    coresMet = r.conditions_met >= 5;  // fallback 기준
  }

  r._coresMet = coresMet;

  // MA20 기울기 신호 텍스트
  if (swingData.ma20_slope !== null && swingData.ma20_slope >= 0.2)
    r.signals.push('MA20 기울기 ' + swingData.ma20_slope + '%');

  // 시장 구조 보너스/감점
  if (typeof G !== 'undefined') {
    if (G.spyAboveMA200 === true)       score = Math.min(100, score + 5);
    else if (G.spyAboveMA200 === false) { score = Math.max(0, score - 10); r.warnings.push('SPY MA200 아래 — 약세 구조'); }
  }
  if (swingData.weeklyUptrend)                score = Math.min(100, score + 5);
  else if (swingData.ma100 && price)          score = Math.max(0, score - 8);

  r.score = score;

  // ── 컨텍스트 경고 ──
  if (typeof G !== 'undefined' && G.spyAboveMA200 === false)
    r.warnings.push('SPY MA200 아래 — 스윙 진입 신중');
  if (swingData.ma20_gap_pct !== null && swingData.ma20_gap_pct > 15)
    r.warnings.push('MA20 이격 ' + swingData.ma20_gap_pct + '% — 눌림목 대기 권고');
  if (swingData.vol_ratio !== null && swingData.vol_ratio < 0.8)
    r.warnings.push('거래량 평균비 ' + swingData.vol_ratio + 'x — 약한 수급');

  // ══════════════════════════════════════
  // 4. T1 상방 필터
  // ══════════════════════════════════════
  if (r.target1_pct !== null && r.target1_pct !== undefined && r.target1_pct < swingMinT1Pct) {
    var _t2Narrow = (r.target2_pct === null || r.target2_pct === undefined || r.target2_pct < swingMinT1Pct);
    if (_t2Narrow) {
      r.blockers.push('[SWING] T1 +' + r.target1_pct + '% · T2 +' + (r.target2_pct != null ? r.target2_pct : '-') + '% — 상방 전 구간 협소');
      r.action = 'BLOCK'; return r;
    }
    r.warnings.push('[SWING] T1 +' + r.target1_pct + '% 협소 (최소 ' + swingMinT1Pct + '% 미만) — 눌림 대기 / T2 +' + r.target2_pct + '%');
    r.score = Math.max(0, r.score - 10);
  }

  // ── 최소 조건 게이트 ──
  if (r.conditions_met <= 1) {
    r.blockers.push('[SWING] 조건 ' + r.conditions_met + '/8 — 최소 기준 미달');
    r.action = 'BLOCK'; return r;
  }

  // ══════════════════════════════════════
  // 5. ENTER / WATCH 엔진 자체 판단
  //
  // ENTER 조건 (모두 충족):
  //   ① score ≥ SWING_ENTER_SCORE (70)
  //   ② 타입별 핵심조건 모두 충족 (_coresMet)
  //   ③ conditions_met ≥ 5
  //   ④ T1 상방 충분 (위에서 BLOCK 안 됨)
  //
  // WATCH 조건:
  //   score ≥ SWING_WATCH_SCORE (40) AND conditions_met ≥ 4
  //   → Claude에게 뉴스/컨텍스트 기반 최종 판단 위임
  //
  // BLOCK: 나머지
  // ══════════════════════════════════════
  if (r.score >= SWING_ENTER_SCORE && r._coresMet && r.conditions_met >= 5) {
    r.action = 'ENTER';
  } else if (r.score >= SWING_WATCH_SCORE && r.conditions_met >= 4) {
    r.action = 'WATCH';
  } else {
    r.blockers.push('[SWING] 점수 ' + r.score + '점 / 조건 ' + r.conditions_met + '/8 — WATCH 기준 미달');
    r.action = 'BLOCK'; return r;
  }

  // ══════════════════════════════════════
  // 6. 포지션 사이즈 권고
  //   ENTER: 타입별 기본 사이즈 (A=50%, B=25%, C=30%)
  //   WATCH: 절반
  // ══════════════════════════════════════
  var baseSizes = { 'A': 50, 'B': 25, 'C': 30 };
  var baseSize  = (swingType && baseSizes[swingType]) || 35;
  if (r.action === 'ENTER') {
    // VIX STRESS/CAUTION 시 추가 축소
    var sizeMulti = vixRegime === 'STRESS' ? 0.5 : vixRegime === 'CAUTION' ? 0.7 : 1.0;
    r.position_size = Math.round(baseSize * sizeMulti) + '%';
  } else {
    r.position_size = 'none';
  }

  // ══════════════════════════════════════
  // 7. 시가총액 / 유동성 필터
  // ══════════════════════════════════════
  var levInfo = (ydata.levInfo) || (typeof LEVERAGE_ETF_MAP !== 'undefined' && LEVERAGE_ETF_MAP[(ydata.ticker || '').toUpperCase()]) || null;
  if (!levInfo) {
    var capB   = ydata.marketCap_b;
    var avgVol = ydata.avgVolume;
    var minCapEl = document.getElementById('swingMinCap');
    var maxCapEl = document.getElementById('swingMaxCap');
    var minVolEl = document.getElementById('swingMinVol');
    var minCapStr = minCapEl ? minCapEl.textContent : '$500M';
    var maxCapStr = maxCapEl ? maxCapEl.textContent : '$10B';
    var minVolStr = minVolEl ? minVolEl.textContent : '50만';
    var minCapB = minCapStr === '없음' ? 0 : minCapStr === '$300M' ? 0.3 : minCapStr === '$500M' ? 0.5 : minCapStr === '$1B' ? 1 : 0;
    var maxCapB = maxCapStr === '없음' ? 99999 : maxCapStr === '$5B' ? 5 : maxCapStr === '$10B' ? 10 : maxCapStr === '$20B' ? 20 : 99999;
    var minVolK = minVolStr === '없음' ? 0 : minVolStr === '30만' ? 300000 : minVolStr === '50만' ? 500000 : minVolStr === '100만' ? 1000000 : 0;
    if (minCapB > 0 && capB !== null && capB < minCapB && r.action !== 'BLOCK') {
      r.blockers.push('[SWING] 시총 $' + capB + 'B — 최소 ' + minCapStr + ' 미만'); r.action = 'BLOCK';
    }
    if (capB !== null && capB > maxCapB)
      r.warnings.push('[SWING] 시총 $' + capB + 'B — ' + maxCapStr + ' 초과 (라지캡, 수익률 제한)');
    if (minVolK > 0 && avgVol && avgVol < minVolK && r.action !== 'BLOCK')
      r.warnings.push('[SWING] 일평균 거래량 ' + (avgVol / 10000).toFixed(0) + '만주 — 유동성 부족');
    r.marketCap_b = capB;
  } else {
    var mult = levInfo.mult;
    var absM = Math.abs(mult);
    var swingHoldDays = parseInt(((document.getElementById('swingHoldDays') || {textContent: '10'}).textContent) || '10');
    var maxSafeDays   = absM >= 3 ? 5 : 7;
    r.is_lev_etf = true; r.lev_mult = mult; r.lev_base = levInfo.base; r.lev_base_ticker = levInfo.baseTicker;
    r.float_m = null; r.short_pct = null; r.slippage_risk = 'low';
    r.warnings.push((mult > 0 ? '📈' : '📉') + ' ' + levInfo.base + ' ' + mult + 'x ETF');
    r.warnings.push('⚠ 베타 슬리피지: ' + absM + 'x ETF ' + maxSafeDays + '일 이내 청산' + (swingHoldDays > maxSafeDays ? ' — 현재 설정 ' + swingHoldDays + '일 ⚠' : ''));
    r.lev_info = levInfo;
  }

  return r;
}

// ═══════════════════════════════════════════════════════════════
// calcSwingEntrySignal
// 스윙 전용 진입 신호 — MOMO 개념 완전 배제
// 일봉 MA 구조 + 피벗 지지/저항 기반
//
// 게이트:
//   BLOCK → AVOID 반환
//   score < SWING_WATCH_SCORE or conditions_met < SWING_MIN_COND → WAIT(조건부족)
//   ENTER: GO 신호 발화
//   WATCH: 타입별 대기 신호
// ═══════════════════════════════════════════════════════════════
function calcSwingEntrySignal(r) {
  if (!r) return { signal: 'WAIT', icon: '⏸', label: '데이터 없음', reason: '분석 결과 없음', trigger: null, css: 'wait' };

  if (r.action === 'BLOCK') return {
    signal: 'AVOID', icon: '🔴', label: '진입 금지',
    reason: (r.blockers && r.blockers[0]) || 'BLOCK',
    trigger: null, css: 'avoid'
  };

  var condMet = r.conditions_met || 0;
  var score   = r.score || 0;

  if (condMet < SWING_MIN_COND || score < SWING_WATCH_SCORE) return {
    signal: 'WAIT', icon: '⏸', label: '조건 부족',
    reason: '조건 ' + condMet + '/8 · 점수 ' + score + '점 — 기준 미달',
    trigger: '추가 조건 충족 후 재분석 권장',
    css: 'wait'
  };

  var price = r.price;
  var ma20  = r.ma20  || null;
  var ma60  = r.ma60  || null;
  var res1  = r.nearest_resistance;
  var sup1  = r.nearest_support;
  var swingType = r.swing_type || null;

  // ── ENTER — 타입별 진입 신호 ──
  if (r.action === 'ENTER') {
    // Type A: MA20 눌림목
    if (swingType === 'A' && ma20 && price) {
      return {
        signal: 'GO', icon: '🟢', label: '눌림목 진입',
        reason: 'Type A — MA20 $' + ma20.toFixed(2) + ' 눌림목 + 핵심조건 충족 (' + score + '점)',
        trigger: '손절 MA20 -3% $' + (ma20 * 0.97).toFixed(2) + ' / T1 $' + (r.target1 ? r.target1.toFixed(2) : '--'),
        css: 'go'
      };
    }
    // Type B: 돌파형 — 신고가 근접
    if (swingType === 'B') {
      return {
        signal: 'GO', icon: '🟢', label: '돌파 진입',
        reason: 'Type B — 20일 신고가 근접 + 베이스 + 거래량 (' + score + '점)',
        trigger: (res1 ? '저항 $' + res1.toFixed(2) + ' 종가 돌파 확인 시 진입' : '신고가 돌파 확인 후 진입') +
                 ' / T1 $' + (r.target1 ? r.target1.toFixed(2) : '--'),
        css: 'go'
      };
    }
    // Type C: 반전형
    if (swingType === 'C') {
      return {
        signal: 'GO', icon: '🟢', label: '반전 진입',
        reason: 'Type C — MA200 회복 + MACD 플러스 전환 + 하락 거래량 고갈 (' + score + '점)',
        trigger: (sup1 ? '지지 $' + sup1.toFixed(2) + ' 유지 확인 / ' : '') +
                 'T1 $' + (r.target1 ? r.target1.toFixed(2) : '--'),
        css: 'go'
      };
    }
    // 타입 미확정 ENTER
    return {
      signal: 'GO', icon: '🟢', label: '진입',
      reason: '스윙 조건 충족 — ' + condMet + '/8 · ' + score + '점',
      trigger: (sup1 ? '지지 $' + sup1.toFixed(2) + ' / ' : '') + 'T1 $' + (r.target1 ? r.target1.toFixed(2) : '--'),
      css: 'go'
    };
  }

  // ── WATCH — 타입별 대기 신호 ──

  // MA20 눌림목 근처 — 핵심조건 아직 미충족
  if (ma20 && price && Math.abs(price - ma20) / ma20 <= 0.03) {
    return {
      signal: 'WAIT', icon: '🟡', label: 'MA20 눌림목 대기',
      reason: 'MA20 $' + ma20.toFixed(2) + ' 근처 (' + condMet + '/8 · ' + score + '점) — 핵심조건 대기',
      trigger: r._coresMet ? '핵심조건 충족 — 일봉 종가 확인 후 진입 가능' :
               '미충족 조건 해소 후 진입 / 손절 MA20 -3% $' + (ma20 * 0.97).toFixed(2),
      css: 'wait'
    };
  }

  // MA60 근처
  if (ma60 && price && Math.abs(price - ma60) / ma60 <= 0.03) {
    return {
      signal: 'WAIT', icon: '🟡', label: 'MA60 눌림목 대기',
      reason: 'MA60 $' + ma60.toFixed(2) + ' 근처 (' + condMet + '/8 · ' + score + '점)',
      trigger: '반등 + 조건 개선 확인 후 진입 / 손절 $' + (ma60 * 0.97).toFixed(2),
      css: 'wait'
    };
  }

  // 저항 직전
  if (res1 && price && price > res1 * 0.985 && price < res1) {
    return {
      signal: 'WAIT', icon: '🟡', label: '저항 직전',
      reason: '저항선 $' + res1.toFixed(2) + ' 직전 (' + condMet + '/8 · ' + score + '점)',
      trigger: '돌파: $' + (res1 * 1.005).toFixed(2) + ' 종가 확인 / 눌림: $' + (sup1 ? sup1.toFixed(2) : '--') + ' 반등',
      css: 'wait'
    };
  }

  // 지지선 바운스 — 공간 충분
  if (sup1 && price && price > sup1 && (price - sup1) <= (r.atr20 || price * 0.02) * 3) {
    var spaceToRes = res1 ? res1 - price : null;
    var minSpace   = (r.atr20 || price * 0.02) * 2;
    if (!res1 || spaceToRes >= minSpace) {
      return {
        signal: 'WAIT', icon: '🟡', label: '지지선 확인 중',
        reason: '지지선 $' + sup1.toFixed(2) + ' 근처 (' + condMet + '/8 · ' + score + '점) — 조건 개선 대기',
        trigger: '조건 ' + SWING_MIN_COND + '/8 + 점수 ' + SWING_ENTER_SCORE + '점 달성 시 진입 / 손절 $' + (sup1 * 0.97).toFixed(2),
        css: 'wait'
      };
    }
  }

  // MA20 이격 큼
  if (ma20 && price && (price - ma20) / ma20 > 0.08) {
    return {
      signal: 'WAIT', icon: '🟡', label: 'MA20 눌림 대기',
      reason: 'MA20 대비 +' + (((price - ma20) / ma20) * 100).toFixed(0) + '% 이격 (' + score + '점)',
      trigger: 'MA20 $' + ma20.toFixed(2) + ' 눌림 확인 후 재분석',
      css: 'wait'
    };
  }

  // Default
  var defaultReason = '스윙 관찰 중 — ' + condMet + '/8 · ' + score + '점';
  if (ma20)  defaultReason += ' / MA20 $' + ma20.toFixed(2);
  if (res1)  defaultReason += ' / 저항 $' + res1.toFixed(2);
  if (sup1)  defaultReason += ' / 지지 $' + sup1.toFixed(2);

  return {
    signal: 'WAIT', icon: '🟡', label: '셋업 대기',
    reason: defaultReason,
    trigger: sup1 ? '지지선 $' + sup1.toFixed(2) + ' 눌림 반등 후 재분석' :
             (ma20 ? 'MA20 $' + ma20.toFixed(2) + ' 눌림 후 재분석' : null),
    css: 'wait'
  };
}

// ── 전역 노출 ──
window.swingEngine           = swingEngine;
window.calcSwingEntrySignal  = calcSwingEntrySignal;
