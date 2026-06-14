// ═══════════════════════════════════════════════════════════════
// RECON 포지션 사이징 엔진 — sizeEngine.js
//
//   철학: "한 거래에 잃을 돈을 계좌의 N%로 고정한다."
//   신호 강도(조건 개수)가 아니라 손절 거리가 주수를 정한다.
//   → 어떤 거래가 손절나도 손실은 항상 계좌의 risk% — 연속 손실에도 생존.
//
//   순수 함수: sizeEngine(plan, account, cfgIn) → sizing
//   - 주수만 계산. 실제 주문은 호출자(봇)가 수행.
//
//   사이징 4중 캡 (가장 작은 주수 채택):
//     1. 리스크 캡   : (계좌 × risk%) ÷ (진입가 − 손절가)   ← 주 기준
//     2. 비중 캡     : 한 종목 최대 비중 (집중 방지)
//     3. 현금 캡     : 가용 현금/매수가능액
//     4. 절대 캡     : 사용자 지정 최대 주수 (선택)
//
//   risk% 조정 (기본 리스크에 곱):
//     - 타입: A=1.0, B=0.6, C=0.7  (B 돌파는 실패율↑ → 리스크 축소)
//     - VIX:  CALM=1.0, CAUTION=0.7, STRESS=0.5
//     - WATCH 진입(엔진 ENTER 아님): ×0.5
// ═══════════════════════════════════════════════════════════════

'use strict';

var SIZE_DEFAULTS = {
  riskPctPerTrade: 1.5,    // 한 거래 최대 손실 = 계좌의 1.5% (보수 1.0, 공격 2.0)
  maxPositionPct:  20,     // 한 종목 최대 비중 = 계좌의 20% (집중 방지)
  allowFractional: false,  // 소수점 주 허용 (해외주식 일부 가능)
  minShares:       1,      // 최소 주수 (이하면 진입 스킵)
  typeRiskMult:  { A: 1.0, B: 0.6, C: 0.7, none: 0.8 },
  vixRiskMult:   { CALM: 1.0, CAUTION: 0.7, STRESS: 0.5 },
  watchMult:       0.5,    // WATCH(미확정) 진입 시 리스크 절반
};

function _n(v){ return (typeof v === 'number' && isFinite(v)) ? v : null; }
function _r2(v){ return parseFloat(Number(v).toFixed(2)); }
function _mergeCfg(base, over){
  var out = {}; for (var k in base) out[k] = base[k];
  if (over) for (var k2 in over) if (over[k2] !== undefined){
    // 중첩 객체(typeRiskMult 등)는 얕은 병합
    if (out[k2] && typeof out[k2] === 'object' && typeof over[k2] === 'object'){
      var m = {}; for (var a in out[k2]) m[a] = out[k2][a];
      for (var b in over[k2]) m[b] = over[k2][b]; out[k2] = m;
    } else out[k2] = over[k2];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// sizeEngine(plan, account, cfgIn)
//
// plan (진입 계획 — 엔진 결과/카드에서):
//   ticker
//   entry      (진입가, 필수)
//   stop       (손절가, 필수 — 리스크 계산의 핵심)
//   type       'A'|'B'|'C'|null   (swingEngine swing_type / core는 null)
//   action     'ENTER'|'WATCH'    (WATCH면 리스크 절반)
//   vixRegime  'CALM'|'CAUTION'|'STRESS'  (없으면 CALM)
//
// account (계좌 상태 — 호출자가 제공):
//   equity        (총 평가자산, 필수 — 리스크/비중 기준)
//   cashAvailable (매수가능 현금; 없으면 equity로 가정)
//
// 반환:
//   { ticker, shares, notional, riskAmount, riskPctActual,
//     entry, stop, stopDistPct,
//     boundBy: 'risk'|'position'|'cash'|'absolute'|'none',
//     skip: bool, reasons[], warnings[] }
// ═══════════════════════════════════════════════════════════════
function sizeEngine(plan, account, cfgIn){
  var cfg = _mergeCfg(SIZE_DEFAULTS, cfgIn);
  var d = {
    ticker: plan && plan.ticker || '?',
    shares: 0, notional: 0, riskAmount: 0, riskPctActual: 0,
    entry: null, stop: null, stopDistPct: null,
    boundBy: 'none', skip: false, reasons: [], warnings: [],
  };

  var entry = _n(plan && plan.entry);
  var stop  = _n(plan && plan.stop);
  var equity = _n(account && account.equity);
  var cash   = _n(account && account.cashAvailable);
  if (cash === null) cash = equity;

  // ── 입력 검증 ──
  if (!entry || entry <= 0){ d.skip = true; d.reasons.push('진입가 없음 — 사이징 불가'); return d; }
  if (!stop || stop <= 0){ d.skip = true; d.reasons.push('손절가 없음 — 리스크 계산 불가 (사이징 거부)'); return d; }
  if (stop >= entry){ d.skip = true; d.reasons.push('손절가 ≥ 진입가 — 잘못된 계획 (사이징 거부)'); return d; }
  if (!equity || equity <= 0){ d.skip = true; d.reasons.push('계좌 평가액 없음 — 사이징 불가'); return d; }

  d.entry = _r2(entry); d.stop = _r2(stop);
  var stopDist = entry - stop;                 // 주당 리스크 ($)
  d.stopDistPct = _r2(stopDist / entry * 100);

  // ── 리스크% 조정 ──
  var typeMult = cfg.typeRiskMult[plan && plan.type || 'none'];
  if (typeMult === undefined) typeMult = cfg.typeRiskMult.none;
  var vixMult  = cfg.vixRiskMult[(plan && plan.vixRegime) || 'CALM'] || 1.0;
  var watchMult = (plan && plan.action === 'WATCH') ? cfg.watchMult : 1.0;
  var effRiskPct = cfg.riskPctPerTrade * typeMult * vixMult * watchMult;
  var riskBudget = equity * effRiskPct / 100;   // 이 거래에 걸 수 있는 최대 손실 ($)

  // ── 4중 캡: 각 기준의 주수 계산 후 최소값 ──
  var sharesRisk = riskBudget / stopDist;                        // 1. 리스크 캡
  var sharesPos  = (equity * cfg.maxPositionPct / 100) / entry;  // 2. 비중 캡
  var sharesCash = cash / entry;                                 // 3. 현금 캡
  var sharesAbs  = (cfgIn && _n(cfgIn.maxShares)) || Infinity;   // 4. 절대 캡

  var caps = [
    { n: sharesRisk, by: 'risk' },
    { n: sharesPos,  by: 'position' },
    { n: sharesCash, by: 'cash' },
    { n: sharesAbs,  by: 'absolute' },
  ];
  var chosen = caps[0];
  for (var i = 1; i < caps.length; i++) if (caps[i].n < chosen.n) chosen = caps[i];

  var shares = chosen.n;
  if (!cfg.allowFractional) shares = Math.floor(shares);
  else shares = _r2(shares);

  // ── 최소 주수 미달 → 스킵 ──
  if (shares < cfg.minShares || shares <= 0){
    d.skip = true; d.boundBy = chosen.by;
    d.reasons.push('계산 주수 ' + _r2(chosen.n) + '주 < 최소 ' + cfg.minShares + '주 — 진입 스킵 (' +
      (chosen.by === 'risk' ? '손절폭 대비 리스크 예산 부족' :
       chosen.by === 'cash' ? '현금 부족' :
       chosen.by === 'position' ? '비중 한도' : '주수 한도') + ')');
    return d;
  }

  d.shares = shares;
  d.boundBy = chosen.by;
  d.notional = _r2(shares * entry);
  d.riskAmount = _r2(shares * stopDist);
  d.riskPctActual = _r2(d.riskAmount / equity * 100);

  // ── 설명 ──
  d.reasons.push('주당 리스크 $' + _r2(stopDist) + ' (손절폭 ' + d.stopDistPct + '%)');
  d.reasons.push('리스크 예산 $' + _r2(riskBudget) + ' (계좌 ' + _r2(effRiskPct) + '%' +
    (typeMult !== 1 ? ' · 타입' + (plan.type||'?') + '×' + typeMult : '') +
    (vixMult !== 1 ? ' · VIX×' + vixMult : '') +
    (watchMult !== 1 ? ' · WATCH×' + watchMult : '') + ')');
  d.reasons.push(shares + '주 → 투입 $' + d.notional + ' (비중 ' + _r2(d.notional/equity*100) + '%) · 실리스크 $' + d.riskAmount + ' (' + d.riskPctActual + '%)');

  if (chosen.by === 'position') d.warnings.push('비중 한도(' + cfg.maxPositionPct + '%)에 막힘 — 리스크 예산보다 적게 진입');
  if (chosen.by === 'cash')     d.warnings.push('현금 한도에 막힘 — 가용현금 $' + _r2(cash));
  if (chosen.by === 'absolute') d.warnings.push('지정 최대 주수에 막힘');
  if (d.stopDistPct > 12)       d.warnings.push('손절폭 ' + d.stopDistPct + '% 과대 — 주수 적음, 갭 리스크 점검');

  return d;
}

// ── 모듈 export (Node) + 전역 (브라우저) ──
if (typeof module !== 'undefined' && module.exports){
  module.exports = { sizeEngine: sizeEngine, SIZE_DEFAULTS: SIZE_DEFAULTS };
}
if (typeof window !== 'undefined'){
  window.sizeEngine = sizeEngine;
  window.SIZE_DEFAULTS = SIZE_DEFAULTS;
}
