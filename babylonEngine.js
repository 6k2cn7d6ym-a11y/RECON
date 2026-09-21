(function() {

const SEC_PROXY_BASE = 'https://dart.minon.kr/sec';

const CONFIG = {
  ACCEL_THRESHOLD_PP: 10,
  ACCEL_MIN_YOY: 10,
  ACCEL_CONSEC_QUARTERS: 2,
  ACCEL_STRONG_JUMP: 20,
  TURNAROUND_MIN_POSITIVE: 5,
  TURNAROUND_MIN_IMPROVEMENT: 15,
  UPTREND_CONSEC: 3,
  UPTREND_MIN_TOTAL: 10,
  IPO_MIN_YOY: 50,
  MICRO_REV_TTM_MIN: 30_000_000,   // 누수차단 선1: TTM(최근4분기합) 매출이 이 값 미만이면 "매출 미미"
  MICRO_REV_QOQ_MIN: 5_000_000,    // 누수차단 선2: 직전분기 대비 매출 증가액이 이 값 미만이면 "실증가 없음"
  MIN_MARKET_CAP: 500_000_000,
  PENNY_STOCK_PRICE: 5,
  MARGIN_IMPROVEMENT_PP: 3,
  B1_NEGATIVE_REV_QUARTERS: 2,
  B2_PULL_FORWARD_PEAK: 200,
  B2_PULL_FORWARD_DECEL: 30,
  B4_MARGIN_COLLAPSE_PP: 10,
  B4_MARGIN_COLLAPSE_QUARTERS: 3,
  W1_CONCURRENT_THRESHOLD: 100,
  W3_MARGIN_DECLINE_QUARTERS: 3,
  W3_MARGIN_DECLINE_PP: 2
};

const REVENUE_TAGS = ['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax','SalesRevenueGoodsNet'];
const IFRS_REVENUE_TAGS = ['Revenue','RevenueFromContractsWithCustomers','RevenueFromSaleOfGoods'];
const GROSS_PROFIT_TAGS = ['GrossProfit'];
const OP_INCOME_TAGS = ['OperatingIncomeLoss','OperatingIncome'];

let tickerCIKCache = null;
// ★ 2026-05-31 (메모리 픽스): factsCache를 LRU 캐시로 전환
//   - SEC company facts 응답은 종목당 1~5MB. 무한 누적 시 500종목 스캔에 500MB~2GB 폭증.
//   - JS Map은 insertion order 보존하므로, set 시 size 초과면 oldest key delete.
//   - 같은 종목 재방문 시(across-scan or rescan) hit하면 끝으로 이동(touch).
const factsCache = new Map();
const FACTS_CACHE_MAX = 20;
function _factsCacheGet(key){
  if(!factsCache.has(key)) return undefined;
  const v = factsCache.get(key);
  factsCache.delete(key); factsCache.set(key, v);  // touch → 끝으로
  return v;
}
function _factsCacheSet(key, value){
  if(factsCache.has(key)) factsCache.delete(key);  // 재삽입은 끝으로
  factsCache.set(key, value);
  if(factsCache.size > FACTS_CACHE_MAX){
    const oldest = factsCache.keys().next().value;
    factsCache.delete(oldest);
  }
}

async function loadTickerCIKMap(_retry) {
  if (tickerCIKCache) return tickerCIKCache;
  const res = await fetch(`${SEC_PROXY_BASE}/files/company_tickers.json`, {cache:'no-store'});
  if (!res.ok) throw new Error(`[SEC CIK맵] HTTP ${res.status}`);
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch(pe) {
    if (!_retry) { await new Promise(r=>setTimeout(r,600)); return loadTickerCIKMap(true); }
    throw new Error(`[SEC CIK맵] 응답 잘림 — ${pe.message}`);
  }
  const map = {};
  for (const key in data) {
    const e = data[key];
    map[e.ticker.toUpperCase()] = { cik: String(e.cik_str).padStart(10, '0'), title: e.title };
  }
  tickerCIKCache = map;
  return map;
}

async function tickerToCIK(ticker) {
  const map = await loadTickerCIKMap();
  const entry = map[ticker.toUpperCase()];
  if (!entry) throw new Error(`CIK not found: ${ticker}`);
  return entry;
}

async function fetchCompanyFacts(ticker, _retry) {
  const key = ticker.toUpperCase();
  const cached = _factsCacheGet(key);
  if (cached) return cached;
  const { cik, title } = await tickerToCIK(ticker);
  const url = `${SEC_PROXY_BASE}/api/xbrl/companyfacts/CIK${cik}.json`;
  const res = await fetch(url, {cache:'no-store'});
  if (!res.ok) throw new Error(`[SEC facts] ${ticker} HTTP ${res.status}`);
  // 대용량(1~5MB) facts는 전송 중 잘릴 수 있음 → 잘림 감지 시 1회 재시도
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch(pe) {
    if (!_retry) { await new Promise(r=>setTimeout(r,800)); return fetchCompanyFacts(ticker, true); }
    throw new Error(`[SEC facts] ${ticker} 응답 잘림 (재시도 실패) — ${pe.message}`);
  }
  const result = { cik, title, facts: data.facts };
  _factsCacheSet(key, result);
  return result;
}

function extractAllRevenueData(facts, preferredUnit = null) {
  const namespaces = ['us-gaap', 'ifrs-full'];
  const allResults = [];
  let unitUsed = null;
  for (const ns of namespaces) {
    if (!facts[ns]) continue;
    const tagList = ns === 'us-gaap' ? REVENUE_TAGS : IFRS_REVENUE_TAGS;
    for (const tag of tagList) {
      const units = facts[ns][tag]?.units;
      if (!units) continue;
      let selectedUnit = null;
      if (preferredUnit && units[preferredUnit]) selectedUnit = preferredUnit;
      else if (units.USD && units.USD.length > 0) selectedUnit = 'USD';
      else {
        const available = Object.keys(units).filter(u => units[u] && units[u].length > 0 && u !== 'pure' && u !== 'shares');
        if (available.length > 0) selectedUnit = available.sort((a, b) => units[b].length - units[a].length)[0];
      }
      if (!selectedUnit) continue;
      const unitData = units[selectedUnit];
      if (unitData && unitData.length > 0) {
        if (!unitUsed) unitUsed = selectedUnit;
        allResults.push({
          tag, namespace: ns, unit: selectedUnit,
          data: unitData.map(r => ({ ...r, _sourceTag: tag, _namespace: ns, _unit: selectedUnit }))
        });
      }
    }
  }
  if (allResults.length === 0) return null;
  return {
    tag: allResults.map(r => `${r.tag}[${r.unit}]`).join('+'),
    unit: unitUsed,
    data: allResults.flatMap(r => r.data)
  };
}

function extractTagData(facts, tags, unit = 'USD') {
  for (const ns of ['us-gaap', 'ifrs-full']) {
    if (!facts[ns]) continue;
    for (const tag of tags) {
      const unitData = facts[ns][tag]?.units?.[unit];
      if (unitData && unitData.length > 0) return { tag, namespace: ns, data: unitData };
    }
  }
  return null;
}

function filterByDate(data, asOfDate) {
  const cutoff = new Date(asOfDate);
  const filtered = data.filter(r => {
    const filed = r.filed ? new Date(r.filed) : new Date(r.end);
    return filed <= cutoff;
  });
  function getDurationDays(r) {
    if (!r.start || !r.end) return null;
    return Math.round((new Date(r.end) - new Date(r.start)) / 86400000);
  }
  const isTrueQuarter = r => { const d = getDurationDays(r); return d !== null && d >= 80 && d <= 100; };
  const isAnnual = r => { const d = getDurationDays(r); return d !== null && d >= 350 && d <= 380; };
  return {
    quarterly: dedupByEnd(filtered.filter(isTrueQuarter)),
    annual: dedupByEnd(filtered.filter(isAnnual))
  };
}

function dedupByEnd(records) {
  const map = new Map();
  for (const r of records) {
    const existing = map.get(r.end);
    if (!existing || new Date(r.filed) < new Date(existing.filed)) map.set(r.end, r);
  }
  return Array.from(map.values()).sort((a, b) => new Date(a.end) - new Date(b.end));
}

function computeYoYSeries(quarters) {
  const result = [];
  for (const q of quarters) {
    const qEnd = new Date(q.end);
    const priorYear = quarters.find(p => {
      if (p === q) return false;
      const d = Math.round((qEnd - new Date(p.end)) / 86400000);
      return d >= 320 && d <= 410;
    });
    let yoy = null;
    if (priorYear && priorYear.val > 0) yoy = ((q.val - priorYear.val) / priorYear.val) * 100;
    result.push({
      period: `FY${q.fy} ${q.fp}`, fy: q.fy, fp: q.fp,
      end: q.end, val: q.val, filed: q.filed, yoy,
      sourceTag: q._sourceTag
    });
  }
  return result;
}

async function getRecentQuartersRevenue(ticker, asOfDate, n = 10) {
  const { facts } = await fetchCompanyFacts(ticker);
  const revData = extractAllRevenueData(facts);
  if (!revData) return { quarters: [], noData: true };
  const { quarterly } = filterByDate(revData.data, asOfDate);
  const withYoY = computeYoYSeries(quarterly);
  return { tag: revData.tag, unit: revData.unit, quarters: withYoY.slice(-n) };
}

async function getMarginData(ticker, asOfDate) {
  const { facts } = await fetchCompanyFacts(ticker);
  const revData = extractAllRevenueData(facts);
  if (!revData) return { error: 'no revenue data' };
  const revFiltered = filterByDate(revData.data, asOfDate);
  const gpData = extractTagData(facts, GROSS_PROFIT_TAGS);
  const gpFiltered = gpData ? filterByDate(gpData.data, asOfDate) : { quarterly: [] };
  const opData = extractTagData(facts, OP_INCOME_TAGS);
  const opFiltered = opData ? filterByDate(opData.data, asOfDate) : { quarterly: [] };
  return {
    revenue: revFiltered.quarterly,
    grossProfit: gpFiltered.quarterly,
    opIncome: opFiltered.quarterly
  };
}

function computeQuarterlyMargins(marginData) {
  const result = [];
  for (const rev of marginData.revenue || []) {
    const gp = (marginData.grossProfit || []).find(g => g.end === rev.end);
    const op = (marginData.opIncome || []).find(o => o.end === rev.end);
    const grossMargin = (gp && rev.val > 0) ? (gp.val / rev.val) * 100 : null;
    const opMargin = (op && rev.val > 0) ? (op.val / rev.val) * 100 : null;
    result.push({
      period: `FY${rev.fy} ${rev.fp}`, fy: rev.fy, fp: rev.fp, end: rev.end,
      revenue: rev.val, grossMargin, opMargin
    });
  }
  return result;
}

function detectAcceleration(quarters) {
  if (quarters.length < 2) return { accelerating: false, reason: 'insufficient_data', details: { quarter_count: quarters.length } };
  const withYoY = quarters.filter(q => q.yoy !== null);
  
  if (withYoY.length >= 2) {
    const allHigh = withYoY.every(q => q.yoy >= CONFIG.IPO_MIN_YOY);
    if (allHigh) {
      return {
        accelerating: true, reason: 'ipo_momentum',
        details: {
          path: 'ipo_momentum',
          quarters: withYoY.map(q => ({ period: q.period, end: q.end, revenue_m: Math.round(q.val / 1e6), yoy_pct: Number(q.yoy.toFixed(1)) })),
          min_yoy: Math.min(...withYoY.map(q => q.yoy))
        }
      };
    }
  }
  
  if (quarters.length >= 3 && withYoY.length < 3) {
    const recent = quarters.slice(-3);
    const qoq1 = (recent[1].val - recent[0].val) / recent[0].val * 100;
    const qoq2 = (recent[2].val - recent[1].val) / recent[1].val * 100;
    if (qoq1 >= 15 && qoq2 >= 15) {
      return {
        accelerating: true, reason: 'ipo_early_qoq',
        details: {
          path: 'ipo_early_qoq',
          quarters: recent.map(q => ({ period: q.period, end: q.end, revenue_m: Math.round(q.val / 1e6), yoy_pct: q.yoy !== null ? Number(q.yoy.toFixed(1)) : null })),
          qoq_1: Number(qoq1.toFixed(1)), qoq_2: Number(qoq2.toFixed(1))
        }
      };
    }
  }
  
  if (withYoY.length < 3) return { accelerating: false, reason: 'insufficient_yoy_data', details: { yoy_count: withYoY.length } };
  
  const recent = withYoY.slice(-4);
  const q_latest = recent[recent.length - 1];
  const q_minus1 = recent[recent.length - 2];
  const q_minus2 = recent.length >= 3 ? recent[recent.length - 3] : null;
  const q_minus3 = recent.length >= 4 ? recent[recent.length - 4] : null;
  
  const latestJump = q_latest.yoy - q_minus1.yoy;
  const prevJump = q_minus2 ? q_minus1.yoy - q_minus2.yoy : null;
  const consecAccel = prevJump !== null && latestJump >= CONFIG.ACCEL_THRESHOLD_PP && prevJump >= CONFIG.ACCEL_THRESHOLD_PP;
  const strongLatest = latestJump >= CONFIG.ACCEL_STRONG_JUMP;
  const latestWithTrend = prevJump !== null && latestJump >= CONFIG.ACCEL_THRESHOLD_PP && prevJump >= 3;
  
  let turnaroundRecovery = false;
  if (q_minus2 !== null) {
    const wasNegative = q_minus2.yoy < 0 || q_minus1.yoy < 0;
    const nowPositive = q_latest.yoy >= CONFIG.TURNAROUND_MIN_POSITIVE;
    const totalImp = q_latest.yoy - q_minus2.yoy;
    turnaroundRecovery = wasNegative && nowPositive && totalImp >= CONFIG.TURNAROUND_MIN_IMPROVEMENT;
  }
  
  let sustainedUptrend = false;
  if (q_minus2 !== null && q_minus3 !== null) {
    const allAsc = q_latest.yoy > q_minus1.yoy && q_minus1.yoy > q_minus2.yoy && q_minus2.yoy > q_minus3.yoy;
    const totalGain = q_latest.yoy - q_minus3.yoy;
    sustainedUptrend = allAsc && totalGain >= CONFIG.UPTREND_MIN_TOTAL;
  }
  
  const solidYoY = q_latest.yoy >= CONFIG.ACCEL_MIN_YOY;
  const accelerating = ((consecAccel || strongLatest || latestWithTrend) && solidYoY) || turnaroundRecovery || sustainedUptrend;
  
  let path = 'none';
  if (consecAccel && solidYoY) path = 'consec_accel';
  else if (strongLatest && solidYoY) path = 'strong_latest';
  else if (latestWithTrend && solidYoY) path = 'latest_with_trend';
  else if (turnaroundRecovery) path = 'turnaround_recovery';
  else if (sustainedUptrend) path = 'sustained_uptrend';
  
  return {
    accelerating,
    reason: accelerating ? path : 'no_acceleration',
    details: {
      path,
      quarters: recent.map(q => ({ period: q.period, end: q.end, revenue_m: Math.round(q.val / 1e6), yoy_pct: q.yoy !== null ? Number(q.yoy.toFixed(1)) : null })),
      latest_jump_pp: Number(latestJump.toFixed(1)),
      prev_jump_pp: prevJump !== null ? Number(prevJump.toFixed(1)) : null
    }
  };
}

function detectMarginImprovement(margins) {
  if (!margins || margins.length < 6) return { improved: false, reason: 'insufficient_data' };
  const recent = margins.slice(-3);
  let grossImproved = 0, opImproved = 0;
  for (const recQ of recent) {
    const priorQ = margins.find(m => {
      const d = Math.round((new Date(recQ.end) - new Date(m.end)) / 86400000);
      return d >= 320 && d <= 410;
    });
    if (!priorQ) continue;
    if (recQ.grossMargin !== null && priorQ.grossMargin !== null && recQ.grossMargin - priorQ.grossMargin >= CONFIG.MARGIN_IMPROVEMENT_PP) grossImproved++;
    if (recQ.opMargin !== null && priorQ.opMargin !== null && recQ.opMargin - priorQ.opMargin >= 5) opImproved++;
  }
  const improved = grossImproved >= 2 || opImproved >= 2;
  let reason = 'no_margin_improvement';
  if (grossImproved >= 2 && opImproved >= 2) reason = 'both_margin_improvement';
  else if (opImproved >= 2) reason = 'operating_margin_improvement';
  else if (grossImproved >= 2) reason = 'gross_margin_improvement';
  return { improved, reason, details: { grossImproved, opImproved } };
}

// 영업이익 흑자전환 감지 — '첫 흑자' 변곡점 포착용 (BABYLON 보너스 가점, 게이트 아님)
// 기준: 최신분기 OP > 0 AND 직전 2분기 OP <= 0 (3분기 패턴으로 일회성 흑자 노이즈 차단)
function detectProfitTurnaround(marginData) {
  if (!marginData || marginData.error) return { turned_profitable: false, reason: 'no_data' };
  const ops = (marginData.opIncome || []).filter(o => o && o.val !== null && o.val !== undefined);
  if (ops.length < 3) return { turned_profitable: false, reason: 'insufficient_data', quarters_available: ops.length };
  const sorted = ops.slice().sort((a, b) => new Date(a.end) - new Date(b.end));
  const latest = sorted[sorted.length - 1];
  const prev   = sorted[sorted.length - 2];
  const prev2  = sorted[sorted.length - 3];

  if (latest.val > 0 && prev.val <= 0 && prev2.val <= 0) {
    return {
      turned_profitable: true,
      reason: 'first_op_profit',
      method: 'operating_income',
      latest_op_m: Math.round(latest.val / 1e6),
      prev_op_m: Math.round(prev.val / 1e6),
      latest_end: latest.end
    };
  }
  return {
    turned_profitable: false,
    reason: latest.val > 0 ? 'already_profitable' : 'still_unprofitable',
    latest_op_m: Math.round(latest.val / 1e6)
  };
}

function detectRevenueCollapse(quarters) {
  if (quarters.length < 5) return { collapsing: false };
  const withYoY = quarters.filter(q => q.yoy !== null);
  if (withYoY.length < 5) return { collapsing: false };
  const recent = withYoY.slice(-5);
  const q_minus2 = recent[2], q_minus1 = recent[3], q_latest = recent[4];
  const latestDecel = q_minus1.yoy - q_latest.yoy;
  const prevDecel = q_minus2.yoy - q_minus1.yoy;
  const consecSevere = latestDecel >= 30 && prevDecel >= 30;
  const peakYoY = Math.max(...recent.map(q => q.yoy));
  const deltaFromPeak = peakYoY - q_latest.yoy;
  const peakFromHigh = peakYoY >= 100;
  const postPeakCollapse = peakFromHigh && deltaFromPeak >= 50 && (latestDecel >= 30 || prevDecel >= 30);
  const collapsing = consecSevere || postPeakCollapse;
  return {
    collapsing,
    reason: collapsing ? (postPeakCollapse ? 'post_peak_collapse' : 'consecutive_decel') : 'stable',
    latest_decel_pp: Number(latestDecel.toFixed(1)),
    peak_yoy: Number(peakYoY.toFixed(1))
  };
}

// ── 게이트 누수 차단: 미미한 매출의 가짜 % 가속 거르기 ──
// val은 원시 매출(달러). TTM=최근4분기 합, QoQ증가=최신분기-직전분기 (절대액).
// 종목 종류(트레저리/IPO 등) 안 따지고 "% 가 신뢰할 매출이냐"만 본다.
function checkMicroRevenueBase(quarters) {
  if (!quarters || quarters.length < 2) return { isMicro: false, ttm: null, qoqDelta: null };
  const last4 = quarters.slice(-4);
  const ttm = last4.reduce((s, q) => s + (q.val || 0), 0);
  const qLatest = quarters[quarters.length - 1];
  const qPrev = quarters[quarters.length - 2];
  const qoqDelta = (qLatest.val || 0) - (qPrev.val || 0);
  // AND 구조: 둘 다 미달일 때만 micro. 하나라도 살아있으면(규모 충분 OR 절대증가 큼) 통과.
  const isMicro = ttm < CONFIG.MICRO_REV_TTM_MIN && qoqDelta < CONFIG.MICRO_REV_QOQ_MIN;
  return { isMicro, ttm: Math.round(ttm), qoqDelta: Math.round(qoqDelta) };
}

function detectOneTimeDemand(quarters) {
  if (quarters.length < 4) return false;
  const withYoY = quarters.filter(q => q.yoy !== null);
  if (withYoY.length < 3) return false;
  const recent6 = withYoY.slice(-6);
  const peakYoY = Math.max(...recent6.map(q => q.yoy));
  const latest = recent6[recent6.length - 1];
  const peakIdx = recent6.findIndex(q => q.yoy === peakYoY);
  const extremePeak = peakYoY >= 200;
  let postPeakDecel = false, deltaFromPeak = 0;
  if (peakIdx < recent6.length - 1) {
    deltaFromPeak = peakYoY - latest.yoy;
    postPeakDecel = peakYoY >= 150 && deltaFromPeak >= 30;
  }
  if (extremePeak || postPeakDecel) {
    return {
      suspicious: true,
      peak_yoy: Number(peakYoY.toFixed(1)),
      latest_yoy: Number(latest.yoy.toFixed(1)),
      delta_from_peak: Number(deltaFromPeak.toFixed(1))
    };
  }
  return false;
}

function checkWarnings({ quarters, margins }) {
  const warnings = [];
  if (quarters && quarters.length >= 4) {
    const ot = detectOneTimeDemand(quarters);
    if (ot && ot.suspicious) {
      warnings.push({
        type: 'W1_ONE_TIME_DEMAND_SUSPECTED', severity: 'high',
        message: `매출 peak +${ot.peak_yoy}% → 현재 +${ot.latest_yoy}%`,
        details: ot
      });
    }
  }
  if (margins && margins.length >= 6) {
    const recent = margins.slice(-3);
    let decline = 0;
    for (const recQ of recent) {
      const priorQ = margins.find(m => {
        const d = Math.round((new Date(recQ.end) - new Date(m.end)) / 86400000);
        return d >= 320 && d <= 410;
      });
      if (priorQ && recQ.opMargin !== null && priorQ.opMargin !== null && priorQ.opMargin - recQ.opMargin >= CONFIG.W3_MARGIN_DECLINE_PP) decline++;
    }
    if (decline >= CONFIG.W3_MARGIN_DECLINE_QUARTERS) {
      warnings.push({ type: 'W3_MARGIN_DETERIORATION', severity: 'medium', message: `영업이익률 ${decline}분기 YoY 악화` });
    }
  }
  return warnings;
}

function checkBlocks({ quarters, margins }) {
  const blocks = [];
  if (quarters && quarters.length >= 3) {
    const withYoY = quarters.filter(q => q.yoy !== null);
    if (withYoY.length >= 2) {
      const latest = withYoY[withYoY.length - 1];
      const prev = withYoY[withYoY.length - 2];
      if (latest.yoy < 0 && prev.yoy < 0) {
        blocks.push({ type: 'B1_NEGATIVE_REVENUE_2Q', message: `매출 2분기 연속 YoY 감소 (${prev.yoy.toFixed(1)}%, ${latest.yoy.toFixed(1)}%)` });
      }
    }
  }
  if (quarters && quarters.length >= 4) {
    const withYoY = quarters.filter(q => q.yoy !== null);
    if (withYoY.length >= 4) {
      const recent = withYoY.slice(-4);
      const q_minus2 = recent[1], q_minus1 = recent[2], q_latest = recent[3];
      const recent6 = withYoY.slice(-6);
      const peakYoY = Math.max(...recent6.map(q => q.yoy));
      const peakInRange = peakYoY >= CONFIG.B2_PULL_FORWARD_PEAK && peakYoY < 500;
      const stillHigh = q_latest.yoy >= 30;
      if (peakInRange && !stillHigh) {
        const latestDecel = q_minus1.yoy - q_latest.yoy;
        const prevDecel = q_minus2.yoy - q_minus1.yoy;
        if (latestDecel >= CONFIG.B2_PULL_FORWARD_DECEL && prevDecel >= CONFIG.B2_PULL_FORWARD_DECEL) {
          blocks.push({ type: 'B2_PULL_FORWARD_CONFIRMED', message: `Pull-forward 확정: peak +${peakYoY.toFixed(0)}% → 현재 +${q_latest.yoy.toFixed(1)}%` });
        }
      }
    }
  }
  if (margins && margins.length >= 6) {
    const recent = margins.slice(-3);
    let severe = 0;
    for (const recQ of recent) {
      const priorQ = margins.find(m => {
        const d = Math.round((new Date(recQ.end) - new Date(m.end)) / 86400000);
        return d >= 320 && d <= 410;
      });
      if (priorQ && recQ.opMargin !== null && priorQ.opMargin !== null && recQ.opMargin - priorQ.opMargin < -CONFIG.B4_MARGIN_COLLAPSE_PP) severe++;
    }
    if (severe >= CONFIG.B4_MARGIN_COLLAPSE_QUARTERS) {
      blocks.push({ type: 'B4_MARGIN_COLLAPSE', message: `Op Margin ${severe}분기 연속 -10%p+ 악화` });
    }
  }
  return blocks;
}

function makeFinalDecision({ blocks, acceleration, marginImprovement, revenueCollapse, warnings, quarters }) {
  if (blocks.length > 0) {
    return { verdict: 'BLOCK', reason: 'hard_block', details: { blocks, position_size_pct: 0, sizing_rule: 'F_NO_ENTRY' } };
  }
  // 게이트 누수 차단: 매출 미미 + 실증가 없음 → 가속 % 가 노이즈이므로 ENTER 불가
  const micro = checkMicroRevenueBase(quarters);
  if (micro.isMicro) {
    return { verdict: 'WATCH_WEAK', reason: 'micro_revenue_base', details: { ttm: micro.ttm, qoq_delta: micro.qoqDelta, position_size_pct: 0, sizing_rule: 'E_WATCH_ONLY', note: 'TTM 매출 미미 + QoQ 실증가 없음 — % 가속 신뢰 불가' } };
  }
  const hasGrowthSignal = acceleration.accelerating || marginImprovement?.improved;
  if (!hasGrowthSignal) {
    if (acceleration.reason === 'insufficient_yoy_data' || acceleration.reason === 'insufficient_data') {
      return { verdict: 'NO_DATA', reason: acceleration.reason, details: { ...acceleration.details, position_size_pct: 0 } };
    }
    return { verdict: 'WATCH_WEAK', reason: 'no_acceleration_no_margin_improvement', details: { acceleration, marginImprovement, position_size_pct: 0, sizing_rule: 'E_WATCH_ONLY' } };
  }
  const highCount = warnings.filter(w => w.severity === 'high').length;
  const mediumCount = warnings.filter(w => w.severity === 'medium').length;
  const collapseFlag = revenueCollapse?.collapsing ? 1 : 0;
  const mediumGroup = mediumCount >= 2 ? 1 : 0;
  const totalRisk = highCount + collapseFlag + mediumGroup;
  
  if (totalRisk === 0) {
    return {
      verdict: 'ENTER', reason: acceleration.accelerating ? acceleration.reason : 'margin_improvement',
      details: {
        growth_path: acceleration.accelerating ? acceleration.details.path : 'margin_improvement',
        position_size_pct: 100, sizing_rule: 'A_FULL_CLEAN', note: '신호 명확, 풀 매수 가능'
      }
    };
  }
  if (totalRisk === 1) {
    return {
      verdict: 'ENTER', reason: 'growth_with_context_warnings',
      details: {
        growth_path: acceleration.accelerating ? acceleration.details.path : 'margin_improvement',
        warning_flags: warnings.map(w => ({ type: w.type, severity: w.severity })),
        position_size_pct: 50, sizing_rule: 'B_HALF_WITH_WARNING', note: 'Warning 1개, 50% 시작'
      }
    };
  }
  return {
    verdict: 'WATCH_CLAUDE', reason: 'multiple_risk_signals',
    details: {
      high_warnings: warnings.filter(w => w.severity === 'high').map(w => w.type),
      revenue_collapsing: collapseFlag > 0,
      position_size_pct: 30, sizing_rule: 'C_QUARTER_CLAUDE_CHECK', note: 'Claude 정성 판단 필요'
    }
  };
}

function detectExitSignals(quarters, margins) {
  const signals = [];
  if (!quarters || quarters.length < 4) return { signals: [], severity: 'insufficient_data' };
  const withYoY = quarters.filter(q => q.yoy !== null);
  if (withYoY.length < 3) return { signals: [], severity: 'insufficient_data' };
  const recent = withYoY.slice(-5);
  const q_latest = recent[recent.length - 1];
  const q_minus1 = recent[recent.length - 2];
  const q_minus2 = recent.length >= 3 ? recent[recent.length - 3] : null;
  
  if (q_minus2) {
    const latestDecel = q_minus1.yoy - q_latest.yoy;
    const prevDecel = q_minus2.yoy - q_minus1.yoy;
    if (latestDecel >= 10 && prevDecel >= 10) {
      signals.push({ type: 'EXIT_1_DECEL_2Q', severity: 'warn', message: `매출 2분기 연속 감속 (${prevDecel.toFixed(1)}%p, ${latestDecel.toFixed(1)}%p)` });
    }
  }
  if (q_latest.yoy < 0) {
    signals.push({ type: 'EXIT_2_NEGATIVE_YOY', severity: 'exit', message: `매출 YoY 감소 (${q_latest.yoy.toFixed(1)}%)` });
  }
  const recent6 = withYoY.slice(-6);
  const peakYoY = Math.max(...recent6.map(q => q.yoy));
  const deltaFromPeak = peakYoY - q_latest.yoy;
  if (peakYoY >= 30 && deltaFromPeak >= 50) {
    signals.push({ type: 'EXIT_3_PEAK_COLLAPSE', severity: 'exit', message: `Peak +${peakYoY.toFixed(1)}% → 현재 +${q_latest.yoy.toFixed(1)}%` });
  }
  if (margins && margins.length >= 6) {
    const recent3 = margins.slice(-3);
    let decline = 0;
    for (const recQ of recent3) {
      const priorQ = margins.find(m => {
        const d = Math.round((new Date(recQ.end) - new Date(m.end)) / 86400000);
        return d >= 320 && d <= 410;
      });
      if (priorQ && recQ.opMargin !== null && priorQ.opMargin !== null && recQ.opMargin - priorQ.opMargin < -2) decline++;
    }
    if (decline >= 3) signals.push({ type: 'EXIT_4_MARGIN_DETERIORATION', severity: 'warn', message: `영업이익률 3분기 YoY 악화` });
  }
  if (q_minus2) {
    const peakHigh = peakYoY >= 150;
    const latestDecel = q_minus1.yoy - q_latest.yoy;
    const prevDecel = q_minus2.yoy - q_minus1.yoy;
    if (peakHigh && latestDecel > 0 && prevDecel > 0) {
      signals.push({ type: 'EXIT_5_PULL_FORWARD_CONFIRMED', severity: 'exit', message: `Pull-forward 확정 (peak +${peakYoY.toFixed(1)}%)` });
    }
  }
  let overallSeverity = 'clean';
  if (signals.some(s => s.severity === 'exit')) overallSeverity = 'exit';
  else if (signals.some(s => s.severity === 'warn')) overallSeverity = 'warn';
  else if (signals.length > 0) overallSeverity = 'watch';
  return { signals, severity: overallSeverity, signal_count: signals.length };
}

async function analyze(ticker, options = {}) {
  const asOfDate = options.asOfDate || new Date().toISOString().slice(0, 10);
  const result = { ticker: ticker.toUpperCase(), asOfDate, timestamp: new Date().toISOString(), stages: {} };
  try {
    const [revData, marginData] = await Promise.all([
      getRecentQuartersRevenue(ticker, asOfDate, 10).catch(e => ({ error: e.message, quarters: [] })),
      getMarginData(ticker, asOfDate).catch(e => ({ error: e.message }))
    ]);
    if (!revData.quarters || revData.quarters.length === 0) {
      result.verdict = 'NO_DATA';
      result.reason = 'sec_data_insufficient';
      result.error = revData.error;
      return result;
    }
    result.stages.fundamentals = { revenue_quarters: revData.quarters.length, tag: revData.tag, unit: revData.unit };
    const margins = !marginData.error ? computeQuarterlyMargins(marginData) : [];
    const acceleration = detectAcceleration(revData.quarters);
    const marginImprovement = detectMarginImprovement(margins);
    const profitTurnaround = detectProfitTurnaround(marginData);
    const revenueCollapse = detectRevenueCollapse(revData.quarters);
    const warnings = checkWarnings({ quarters: revData.quarters, margins });
    const blocks = checkBlocks({ quarters: revData.quarters, margins });
    
    result.stages.acceleration = acceleration;
    result.stages.margin_improvement = marginImprovement;
    result.stages.profit_turnaround = profitTurnaround;
    result.stages.revenue_collapse = revenueCollapse;
    result.stages.warnings = warnings;
    result.stages.blocks = blocks;
    result.stages.quarters = revData.quarters;
    result.stages.margins = margins;
    
    const decision = makeFinalDecision({ blocks, acceleration, marginImprovement, revenueCollapse, warnings, quarters: revData.quarters });
    result.verdict = decision.verdict;
    result.reason = decision.reason;
    result.decision_details = decision.details;
    
    if (options.isHolding) {
      result.exit_signals = detectExitSignals(revData.quarters, margins);
    }
    return result;
  } catch (e) {
    result.verdict = 'ERROR';
    result.reason = 'exception';
    result.error = e.message;
    return result;
  }
}

function clearCache() {
  tickerCIKCache = null;
  factsCache.clear();
}

  var babylonEngine = { analyze, clearCache, fetchCompanyFacts, getRecentQuartersRevenue, detectAcceleration, detectExitSignals, CONFIG };
  if (typeof module !== 'undefined' && module.exports) { module.exports = babylonEngine; }
  else { window.babylonEngine = babylonEngine; }

})();