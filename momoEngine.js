/* ============================================================
 * RECON 공유 엔진 코어 — momoEngine
 * 원본: index.html 에서 추출 (로직 무변경)
 * 변경점:
 *   1) 전역 G 의존을 ctx 인자로 명시화 (G 폴백 유지)
 *   2) getDumpScore / getPDSignatures 같이 포함 (RECON 본체와 단일 소스)
 *   3) P&D 버그 수정 (2026-05): 메가캡 가드 + 뉴스 출처 분리
 *   브라우저: momoEngine(ydata)                          // 전역 G 사용
 *   Node 봇 : momoEngine(ydata, {marketPhase, spyIntraday})
 * ============================================================ */
'use strict';

function getPDSignatures(r){
  var result = {
    dilution_risk: false,
    nasdaq_deficiency: false,
    recent_reverse_split: false,
    microcap_wire_pump: false,
    hits: 0,
    total_score: 0,
    reasons: [],
  };

  var newsLow = (r.newsText || r.news || '').toString().toLowerCase();
  if(!newsLow && !r.news_wire_only && !r.marketCap_b) return result;

  // 1. Dilution 위험 — 최근 자본 희석/추가 상장 이벤트
  var dilutionKW = [
    'direct offering','registered direct',
    'at-the-market','atm offering','atm facility',
    's-1 filing','s-3 filing','form s-1','form s-3',
    'secondary offering','public offering',
    'dilutive','dilution','share issuance',
    'pre-funded warrant','pre-funded warrants','prefunded warrant',
    'convertible note','convertible debenture','convertible notes',
    'debenture conversion','share repurchase program cancelled',
  ];
  if(dilutionKW.some(function(k){return newsLow.includes(k);})){
    result.dilution_risk = true;
    result.hits++;
    result.total_score += 20;
    result.reasons.push('Dilution 이벤트');
  }

  // 2. Nasdaq deficiency / delisting 위험
  // 상장 유지 요건 위반 종목이 급등하면 "마지막 펌프" 패턴
  var nasdaqKW = [
    'nasdaq deficiency','nasdaq notification','nasdaq notice',
    'minimum bid price','bid price rule','bid price requirement',
    'stockholders equity','minimum equity','equity requirement',
    'listing standards','continued listing',
    'delisting','delist','compliance plan',
    'hearing panel','cure period','grace period',
    'regains compliance','regain compliance',
  ];
  if(nasdaqKW.some(function(k){return newsLow.includes(k);})){
    result.nasdaq_deficiency = true;
    result.hits++;
    result.total_score += 25;
    result.reasons.push('Nasdaq 상장 요건 이슈');
  }

  // 3. Reverse split (이미 +60 있으나 여기선 hits count에 기여)
  if(newsLow.includes('reverse split')||newsLow.includes('reverse-split')||newsLow.includes('reverse stock split')){
    result.recent_reverse_split = true;
    result.hits++;
    // 추가 점수 없음 (이미 getDumpScore 본문에서 +60)
    result.reasons.push('Reverse split');
  }
  // "1-for-N" 패턴 (리버스 스플릿 변형 표기)
  if(/1[- ]for[- ]\d+/i.test(r.newsText || r.news || '')){
    if(!result.recent_reverse_split){
      result.recent_reverse_split = true;
      result.hits++;
      result.total_score += 30;
      result.reasons.push('1-for-N 스플릿');
    }
  }

  // 4. Microcap + wire_only 조합 (B안 + 시총)
  if(r.news_wire_only && r.marketCap_b !== null && r.marketCap_b !== undefined
     && r.marketCap_b > 0 && r.marketCap_b < 0.05){
    result.microcap_wire_pump = true;
    result.hits++;
    result.total_score += 15;
    result.reasons.push('소형주 와이어-only 펌프');
  }

  return result;
}

function getDumpScore(r){
  // ★ FIX 2026-05: 메가캡 가드 — $500M 이상은 P&D 평가 대상 아님 (Jim 발견 버그)
  if (r.marketCap_b != null && r.marketCap_b >= 0.5) return 0;
  var score=0;
  var all=(r.warnings||[]).concat(r.blockers||[]).join(' ').toLowerCase();
  var news=(r.news||'').toLowerCase();

  // ── 뉴스 품질 ──
  if(r.news_quality==='none')  score+=35;
  else if(r.news_quality==='vague') score+=18;

  // ── RVol 이상 ──
  // A안: 5~100x 구간 점수 공백 메움. SPRC 43.6x 같은 케이스 잡기 위함.
  if(r.rvol!==null&&r.rvol!==undefined){
    if(r.rvol>200)      score+=50;  // 완전 비정상
    else if(r.rvol>100) score+=35;
    else if(r.rvol>50)  score+=25;  // 신규 (50~100x)
    else if(r.rvol>20)  score+=18;  // 신규 (20~50x)
    else if(r.rvol>10)  score+=10;  // 신규 (10~20x)
    else if(r.rvol<3)   score+=30;
    else if(r.rvol<5)   score+=12;
  }

  // ── Float × RVol = 플로트 회전율 (가장 강력한 P&D 신호) ──
  // Float 1M × RVol 50x = 당일 거래량이 플로트의 50배 = 조작 의심
  if(r.float_m&&r.rvol){
    var floatTurnover = r.rvol; // 이미 avg volume 대비 배수
    if(r.float_m<2&&r.rvol>30) score+=40;  // 극소형 float + 폭발적 거래
    else if(r.float_m<5&&r.rvol>20) score+=25;
    else if(r.float_m>15) score+=15;
  }

  // ── 갭업 크기 vs 뉴스 품질 조합 ──
  if(r.gap_pct!==null&&r.gap_pct>80&&r.news_quality!=='factual') score+=35; // 뉴스없이 80%+ 갭
  else if(r.gap_pct!==null&&r.gap_pct>50&&r.news_quality==='none') score+=25;

  // ── 가격대 (초저가 종목) ──
  if(r.price&&r.price<2)  score+=20;
  else if(r.price&&r.price>15) score+=5;  // 고가 MOMO는 드물게 P&D

  // ── 스프레드 ──
  if(r.spread_pct&&r.spread_pct>2.5) score+=30;
  else if(r.spread_pct&&r.spread_pct>1.5) score+=15;

  // ── 기술적 덤프 패턴 ──
  if(all.includes('lower high'))                           score+=25;
  if(all.includes('open')&&all.includes('high'))           score+=35; // Open=High
  if(all.includes('거래량 감소')||all.includes('거래량 소멸')) score+=20;
  if(all.includes('vwap')&&all.includes('이탈'))            score+=20;

  // ── 강력 P&D 키워드 ──
  if(news.includes('reverse split')||news.includes('reverse-split')||news.includes('reverse stock split')) score+=60;
  // ★ FIX 2026-05: 뉴스 출처 표기 [Stocktwits] / (PR Newswire) 등을 본문과 분리
  // 출처 표기에 키워드가 들어 있다고 펌프로 오인하면 안 됨 (Jim 발견 버그)
  var newsBody = news.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  var socialKw=['discord','telegram','reddit','wallstreetbets','stocktwits','pump'];
  if(socialKw.some(function(k){return newsBody.includes(k);}))       score+=40;
  var promoKw=['press release only','no revenue','shell company','going concern','nasdaq deficiency'];
  if(promoKw.some(function(k){return newsBody.includes(k);}))        score+=30;
  if((newsBody.includes('globe newswire')||newsBody.includes('pr newswire'))&&r.news_quality!=='factual') score+=12;

  // ── 52주 신고가 갭 (역사적 소외주 갑작스런 급등) ──
  // fiftyTwoWeekHigh가 있고 현재가가 갑자기 그것에 근접하면 P&D 가능성
  if(r.fiftyTwoWeekHigh&&r.price&&r.gap_pct){
    var vs52 = (r.price - r.fiftyTwoWeekHigh) / r.fiftyTwoWeekHigh * 100;
    if(vs52 > 0 && r.gap_pct > 50 && r.news_quality !== 'factual') score+=25; // 신고가 돌파 + 갭 + 뉴스없음
  }

  // ── A안: 죽은 마이크로캡 깨우기 패턴 (dormant pump) ──
  // 52주 고점 대비 깊은 낙폭 + 52주 저점 대비 급등 + 당일 갭 = 저점에서 깨운 펌프
  // SPRC 예: 52주 고점 $94.50, 저점 $2.98, 현재 $6.47 (고점 -93%, 저점 +117%), 갭 +53%
  if(r.fiftyTwoWeekHigh&&r.fiftyTwoWeekLow&&r.price&&r.gap_pct){
    var vsHigh = (r.price - r.fiftyTwoWeekHigh) / r.fiftyTwoWeekHigh * 100; // 음수 = 고점 아래
    var vsLow  = (r.price - r.fiftyTwoWeekLow)  / r.fiftyTwoWeekLow  * 100; // 양수 = 저점 위
    if(vsHigh < -70 && vsLow > 80 && r.gap_pct > 30) score+=30;
    else if(vsHigh < -50 && vsLow > 50 && r.gap_pct > 30) score+=15;
  }

  // ── A안: 마이크로캡 시총 (P&D 핵심 타겟 사이즈) ──
  // US 펌프앤덤프 주 타겟은 $50M 미만 나스닥 마이크로캡
  // ($30M 미만은 momoEngine에서 하드 블록, 여기는 open trade 재분석 / SWING / CORE 경로)
  if(r.marketCap_b!==null&&r.marketCap_b!==undefined&&r.marketCap_b>0){
    if(r.marketCap_b < 0.01)      score+=40; // $10M 미만
    else if(r.marketCap_b < 0.05) score+=25; // $50M 미만
    else if(r.marketCap_b < 0.1)  score+=20; // $100M 미만 (Jim A안 스펙)
    else if(r.marketCap_b < 0.2)  score+=8;  // $200M 미만
  }

  // ── B안: wire_only 뉴스 패턴 (Tier 1 부재 + Tier 2/3 도배) ──
  // 정당한 catalyst는 Reuters/Bloomberg/WSJ 등 Tier 1이 받음. Tier 2/3만 있으면 펌프 의심.
  if(r.news_wire_only === true){
    score += 15;
    // 팩트 뉴스 면책 완화: wire_only면 factual로 분류되어도 패널티 부여
    if(r.news_quality === 'factual') score += 10;
  }

  // ── C안: US P&D 시그니처 (정당 거래와 구조적으로 다른 패턴들) ──
  // 각 시그니처는 단독으로도 의심스럽고, 조합 시 강력한 펌프 증거
  var sig = getPDSignatures(r);
  score += sig.total_score;

  return Math.min(score, 100);
}

function momoEngine(ydata, ctx){
  // ── 공유 코어용 컨텍스트 주입 ──
  // RECON(브라우저): ctx 미제공 → 전역 G 폴백 (기존 호출부 무수정 동작)
  // 봇(Node):        ctx 명시 주입 {marketPhase, spyIntraday}
  if (ctx === undefined && typeof G !== 'undefined') ctx = G;
  ctx = ctx || {};
  var r = {
    action:'WATCH', score:0, position_size:'none',
    blockers:[], warnings:[], signals:[],
    entry:null, stop:null, target1:null, rr:null,
    pullback_entry:null, pullback_stop:null, pullback_target:null, pullback_rr:null,
    entry_timing:'wait_pullback',
  };

  var gap    = ydata.gap_pct              !== null ? ydata.gap_pct    : 0;
  var rvol   = ydata.rvol                 !== null ? ydata.rvol       : 0;
  var floatM = ydata.float_m;
  var siPct  = ydata.short_pct            || 0;
  var price  = ydata.price               || 0;
  var news   = (ydata.newsText           || '').toLowerCase();
  var ph     = ctx.marketPhase             || '';

  // ── v4: PM floatTurns 기반 타입 분류 ──
  var pmFloatTurns = ydata.float_turns || null;
  var momoType = 'A';
  if(pmFloatTurns !== null){
    if(pmFloatTurns > 2.0)       momoType = 'C';
    else if(pmFloatTurns >= 0.5) momoType = 'B';
    else                          momoType = 'A';
  } else if(floatM !== null && rvol > 0){
    if(floatM <= 5 && rvol >= 25)        momoType = 'C';
    else if(floatM <= 10 && rvol >= 8)   momoType = 'B';
    else                                  momoType = 'A';
  }
  // PM volume 필터 (타입별 임계값: C=150K, B=100K, A=75K)
  var pmVol = ydata.volume || 0;
  var pmVolThreshold = momoType === 'C' ? 150000 : momoType === 'B' ? 100000 : 75000;
  if(ctx.marketPhase === 'PRE' && pmVol > 0 && pmVol < pmVolThreshold){
    r.action='BLOCK';
    r.blockers.push('[PM필터] PM 거래량 '+pmVol.toLocaleString()+'주 미만 ('+momoType+'타입 기준 '+(pmVolThreshold/1000)+'K) — 노이즈 제거');
    r.momo_type = momoType;
    return r;
  }
  // floatTurns < 0.1 → 타입 다운그레이드
  if(pmFloatTurns !== null && pmFloatTurns < 0.1){
    var prevType = momoType;
    if(momoType === 'C')      momoType = 'B';
    else if(momoType === 'B') momoType = 'A';
    else                       momoType = 'WATCH';
    r.warnings.push('[타입조정] floatTurns '+pmFloatTurns+'x 약함 → Type '+prevType+' → '+momoType);
  }
  r.momo_type = momoType;

  // ── 1. P&D 즉시 BLOCK ──
  if(news.includes('reverse split')||news.includes('reverse-split')||news.includes('reverse stock split')){
    r.action='BLOCK'; r.blockers.push('[P&D] 리버스 스플릿 — 조작성 급등 전형'); return r;
  }
  if(['discord','telegram','reddit','wallstreetbets','pump'].some(function(k){return news.includes(k);})){
    r.action='BLOCK'; r.blockers.push('[P&D] 소셜미디어 조작성 키워드 감지'); return r;
  }
  if(floatM!==null && floatM<2 && rvol>30){
    r.action='BLOCK'; r.blockers.push('[P&D] Float '+floatM.toFixed(1)+'M × RVol '+rvol.toFixed(0)+'x — 플로트 소각 조작'); return r;
  }
  if(gap>80 && (!ydata.newsText||ydata.newsText.trim()==='')){
    r.action='BLOCK'; r.blockers.push('[P&D] 갭 +'+gap.toFixed(0)+'% + 뉴스 없음 — 조작성 급등'); return r;
  }

  // ── A안: 마이크로캡 하드 블록 ($30M 미만) ──
  // US 펌프 타겟 종목은 거의 모두 $50M 미만. $30M 미만은 강제 차단.
  var capB = ydata.marketCap_b;
  if(capB!==null && capB!==undefined && capB>0 && capB < 0.03){
    r.action='BLOCK';
    r.blockers.push('[P&D] 시총 $'+(capB*1000).toFixed(1)+'M — $30M 미만 (마이크로캡 펌프 고위험)');
    r.momo_type = momoType;
    r.marketCap_b = capB;
    return r;
  }

  // ── A안: 죽은 마이크로캡 깨우기 패턴 하드 블록 ──
  // 52주 고점 -85% + 저점 +100% + 갭 +40% + 시총 $100M 미만 = 저점 펌프 전형
  var fwH = ydata.fiftyTwoWeekHigh, fwL = ydata.fiftyTwoWeekLow;
  if(fwH && fwL && price && gap){
    var vsH = (price - fwH)/fwH*100;
    var vsL = (price - fwL)/fwL*100;
    if(vsH < -85 && vsL > 100 && gap > 40 && (!capB || capB < 0.1)){
      r.action='BLOCK';
      r.blockers.push('[P&D] Dormant Pump — 52주 고점 '+vsH.toFixed(0)+'%, 저점 +'+vsL.toFixed(0)+'%, 갭 +'+gap.toFixed(0)+'% (죽은 마이크로캡 깨우기)');
      r.momo_type = momoType;
      r.marketCap_b = capB;
      return r;
    }
  }

  // ── C안: P&D 시그니처 조합 하드 블록 ──
  // 2개 이상 시그니처 동시 히트 = 구조적 펌프 패턴. 상세 점수는 getDumpScore에서.
  var pdSig = getPDSignatures(ydata);
  if(pdSig.hits >= 2){
    r.action='BLOCK';
    r.blockers.push('[P&D] 시그니처 다중 히트 ('+pdSig.hits+'개): '+pdSig.reasons.join(' + '));
    r.momo_type = momoType;
    r.marketCap_b = capB;
    return r;
  }
  // 단일 시그니처라도 강력한 것은 즉시 차단
  if(pdSig.nasdaq_deficiency && gap > 30){
    r.action='BLOCK';
    r.blockers.push('[P&D] 상장 요건 이슈 종목 + 갭 +'+gap.toFixed(0)+'% — 마지막 펌프 전형');
    r.momo_type = momoType;
    r.marketCap_b = capB;
    return r;
  }
  if(pdSig.dilution_risk && pdSig.microcap_wire_pump){
    r.action='BLOCK';
    r.blockers.push('[P&D] 희석 이벤트 + 마이크로캡 와이어 펌프 — 조작성 급등 확실');
    r.momo_type = momoType;
    r.marketCap_b = capB;
    return r;
  }

  // ── 2. SPY 시장 게이트 ──
  var spyDown = false;
  var spyVwapBelow = false;
  if(ctx.spyIntraday){
    var spy = ctx.spyIntraday;
    if(spy.trend==='crash'){
      r.action='BLOCK'; r.blockers.push('[시장] SPY '+spy.change_pct+'% 폭락 — 전 종목 BLOCK'); return r;
    }
    if(spy.trend==='down'){
      spyDown=true;
      r.warnings.push('[시장] SPY '+spy.change_pct+'% 하락 — 포지션 50% 이하 제한');
    }
    if(spy.aboveVwap===false){
      spyVwapBelow=true;
      r.warnings.push('[시장] SPY VWAP 아래 — 시장 매도 구조');
    }
  }

  // ── 3. 점수 계산 ──
  var score = 0;

  // Float (최대 25점)
  if(floatM!==null){
    if(floatM<=2)       {score+=25; r.signals.push('Ultra Float '+floatM.toFixed(1)+'M');}
    else if(floatM<=5)  {score+=20; r.signals.push('Low Float '+floatM.toFixed(1)+'M');}
    else if(floatM<=10) {score+=12;}
    else if(floatM<=15) {score+=7;}
    else if(floatM<=20) {score+=4;}
    else if(floatM<=25) {score+=2;}  // Type A 구간 (20~25M)
    else                {score-=5;}
  }

  // RVol (최대 20점)
  if(rvol>=15)      {score+=20; r.signals.push('RVol '+rvol.toFixed(1)+'x 폭발');}
  else if(rvol>=10) {score+=16; r.signals.push('RVol '+rvol.toFixed(1)+'x');}
  else if(rvol>=5)  {score+=10;}
  else if(rvol>=3)  {score+=5;}
  else if(rvol<2)   {score-=10; r.warnings.push('RVol '+rvol.toFixed(1)+'x — 유동성 약함');}

  // 갭% (최대 15점)
  if(gap>=50)      {score+=15; r.signals.push('갭 +'+gap.toFixed(0)+'%');}
  else if(gap>=30) {score+=12; r.signals.push('갭 +'+gap.toFixed(0)+'%');}
  else if(gap>=20) {score+=8;}
  else if(gap>=15) {score+=5;}  // Type A 구간 (15~20%)
  else             {score+=3;}  // 15% 미만은 이미 필터 통과한 케이스

  // Short Interest (최대 10점)
  if(siPct>=25)      {score+=10; r.signals.push('Short '+siPct.toFixed(0)+'% — 숏스퀴즈 잠재력');}
  else if(siPct>=15) {score+=6;}
  else if(siPct>=8)  {score+=3;}

  // VWAP 위치 (최대 8점)
  if(ydata.vwap && price){
    if(price>ydata.vwap*1.01)      {score+=8; r.signals.push('VWAP 위 매수 구조');}
    else if(price>ydata.vwap)      {score+=4;}
    else if(price<ydata.vwap*0.98) {score-=8; r.warnings.push('VWAP $'+ydata.vwap.toFixed(2)+' 아래 — 매도 구조');}
  }

  // PM 응집 (7점)
  if(ydata.pm_consolidation){score+=7; r.signals.push('PM 응집형 셋업');}

  // 차트 셋업 확인 (최대 10점)
  if(ydata.cons_breakout_confirmed)       {score+=10; r.signals.push('박스 캔들 돌파 확인');}
  else if(ydata.resistance_breakout_confirmed) {score+=8; r.signals.push('저항선 캔들 돌파 확인');}

  // 시간대 보정
  if(ph==='EARLY')      {score+=5; r.signals.push('골든윈도우');}
  else if(ph==='PRIME') {score+=2;}
  else if(ph==='LATE')  {score-=10; r.warnings.push('11:30+ 페이드 구간 — 포지션 절반 이하');}
  else if(ph==='ORB')   {r.warnings.push('ORB 형성 중 — 캔들 확정 후 진입');}

  // ── PRE 전용 셋업 감지 (v5: 승률 중심 셋업 엔진) ──
  // PRE는 VWAP/차트셋업이 약하므로 PM 구조 기반 셋업으로 대체 점수 부여
  // 셋업 하나 이상 감지되어야 PRE에서 ENTER 허용됨 (방향성 확보)
  var preSetup = null;
  if(ph==='PRE' && price){
    var _pmH = ydata.pm_high, _pmL = ydata.pm_low, _vw = ydata.vwap;

    // ① BREAKOUT — PM 고점 재돌파 (최강 셋업)
    if(_pmH && price >= _pmH * 0.995){
      preSetup = {type:'BREAKOUT', bonus:15, reason:'PM 고점 $'+_pmH.toFixed(2)+' 돌파'};
    }
    // ② RANGE_BREAK — PM 박스권 돌파 (consolidation 후 상방 이탈)
    else if(ydata.pm_consolidation && _pmH && price >= _pmH * 0.99){
      preSetup = {type:'RANGE_BREAK', bonus:13, reason:'PM 응집 박스 $'+_pmH.toFixed(2)+' 상단 돌파'};
    }
    // ③ PULLBACK — PM 되돌림 후 반등 (Jim 주력 셋업)
    //    pm_high 형성 + 5% 이상 눌림 + pm_low 대비 3%+ 반등 + (VWAP 근처 또는 위)
    else if(_pmH && _pmL && price < _pmH * 0.95 && price > _pmL * 1.03 && (!_vw || price >= _vw * 0.98)){
      var pullbackPct = ((_pmH - price) / _pmH * 100).toFixed(1);
      var bouncePct = ((price - _pmL) / _pmL * 100).toFixed(1);
      preSetup = {type:'PULLBACK', bonus:12, reason:'PM 고점에서 -'+pullbackPct+'% 눌림 → 저점에서 +'+bouncePct+'% 반등'};
    }
    // ④ MOMENTUM_CHASE — 강한 갭 + 뉴스 + 가격 유지 (모멘텀 추격)
    else if(gap >= 50 && ydata.newsText && ydata.newsText.trim() !== '' && _vw && price >= _vw){
      preSetup = {type:'MOMENTUM', bonus:10, reason:'갭 +'+gap.toFixed(0)+'% + 뉴스 촉매 + VWAP 위 유지'};
    }
    // ⑤ REVERSAL — PM 저점에서 강한 반등 (폭등 초입 포착)
    else if(_pmH && _pmL && price > _pmL * 1.08 && (_pmH - _pmL) / _pmL > 0.15){
      var revBounce = ((price - _pmL) / _pmL * 100).toFixed(1);
      preSetup = {type:'REVERSAL', bonus:8, reason:'PM 저점 $'+_pmL.toFixed(2)+' 대비 +'+revBounce+'% 반등 (스윕 가능성)'};
    }

    if(preSetup){
      score += preSetup.bonus;
      r.signals.push('[PRE셋업-'+preSetup.type+'] '+preSetup.reason);
      r._preSetup = preSetup.type;
    }
  }

  // ORB 덤프 패턴
  if(ph!=='PRE' && ydata.orb_low && price && price<ydata.orb_low*0.99){
    score-=20; r.warnings.push('ORB 저점 이탈 — 덤프 패턴');
  }

  // Breakout wick 실패
  if(ydata.breakout_wick_strength==='failed'){
    score-=15; r.warnings.push('슈팅스타/도지 — 돌파 실패 가능성');
  }

  r.score = Math.min(100, Math.max(0, score));

  // ── 4. 액션 결정 (타입별 점수 기준, PRE는 셋업 기반 완화) ──
  //    PRE는 차트셋업/VWAP 점수 구조적 손실 보정하여 기준 하향
  var enterThreshold, blockThreshold;
  if(ph==='PRE'){
    enterThreshold = momoType==='C' ? 48 : momoType==='B' ? 42 : 38; // PRE: A=38, B=42, C=48
    blockThreshold = momoType==='C' ? 28 : momoType==='B' ? 25 : 22; // PRE: 블록 기준도 하향
  } else {
    enterThreshold = momoType==='C' ? 60 : momoType==='B' ? 55 : 50; // 정규장: A=50, B=55, C=60
    blockThreshold = momoType==='C' ? 35 : momoType==='B' ? 35 : 30;
  }

  if(r.score < blockThreshold){
    r.action='BLOCK'; r.blockers.push('[Type '+momoType+'] 점수 '+r.score+'pt — 기준 '+blockThreshold+'pt 미달');
  } else if(r.score < enterThreshold){
    r.action='WATCH';
  } else {
    // 점수 충족 → 트리거 체크 (PRE와 정규장 분리)
    var triggerOk=true, triggerFail=[];

    if(ph==='PRE'){
      // PRE: 셋업 기반 + 최소한의 안전망만
      if(!preSetup){
        triggerOk=false;
        triggerFail.push('PRE 셋업 없음 — 진입 방향성 불확실 (고점돌파/되돌림반등/박스돌파/모멘텀 중 하나 필요)');
      }
      // SPY 폭락만 차단 (일반 하락은 PRE에서 허용 — 프리장은 종종 디커플링)
      if(ctx.spyIntraday && ctx.spyIntraday.trend === 'crash'){
        triggerOk=false; triggerFail.push('SPY 폭락 (-1.5%+) — PRE도 전체 차단');
      }
    } else {
      // 정규장: 기존 트리거 체크 그대로
      if(spyDown)                                                  {triggerOk=false; triggerFail.push('SPY 하락 — WATCH만 허용');}
      if(ph==='ORB')                                               {triggerOk=false; triggerFail.push('ORB 형성 중');}
      if(ph==='LATE')                                              {triggerOk=false; triggerFail.push('페이드 구간 — 포지션 절반 이하');}
      if(ydata.vwap&&price&&price<ydata.vwap*0.98)                 {triggerOk=false; triggerFail.push('VWAP 아래');}
      if(ydata.orb_low&&price&&price<ydata.orb_low*0.99)           {triggerOk=false; triggerFail.push('ORB 저점 이탈');}
      if(ydata.breakout_wick_strength==='failed')                  {triggerOk=false; triggerFail.push('돌파 캔들 실패');}
    }

    if(triggerOk){
      r.action='ENTER';
      // PRE 셋업 타입을 entry_timing에 반영 (없으면 기존 로직)
      if(preSetup){
        r.entry_timing = {
          BREAKOUT:     'pm_breakout',
          RANGE_BREAK:  'consolidation_break',
          PULLBACK:     'pullback_reversal',
          MOMENTUM:     'momentum_chase',
          REVERSAL:     'reversal'
        }[preSetup.type] || 'breakout';
      }
      else if(ydata.cons_breakout_confirmed)        r.entry_timing='consolidation_break';
      else if(ydata.resistance_breakout_confirmed) r.entry_timing='breakout';
      else if(ydata.vwap&&price&&Math.abs(price-ydata.vwap)/ydata.vwap<0.01) r.entry_timing='vwap_bounce';
      else r.entry_timing='breakout';
    } else {
      r.action='WATCH';
      r.warnings.push('[트리거 미충족] '+triggerFail.join(' / ')+' — 점수 '+r.score+'pt이나 진입 보류');
    }
  }

  // ── 5. Entry / Stop / Target (v4: 타입별 손절) ──
  if(price){
    var entry = ydata.entry_slip||ydata.entry_calc||price;
    // v4 타입별 손절: A=-7%, B=-10%, C=-15%
    var stopMult = momoType==='C' ? 0.85 : momoType==='B' ? 0.90 : 0.93;
    var stop  = ydata.stop_calc||parseFloat((entry*stopMult).toFixed(2));
    var risk  = entry-stop;
    var tgt   = ydata.target_calc||null;
    if(!tgt && ydata.nearest_resistance && ydata.nearest_resistance>entry*1.02)
      tgt = parseFloat((ydata.nearest_resistance*0.99).toFixed(2));
    else if(!tgt && ydata.pm_high && ydata.pm_high>entry*1.02)
      tgt = parseFloat((ydata.pm_high*0.99).toFixed(2));
    else if(!tgt)
      tgt = parseFloat((entry+risk*2).toFixed(2));

    r.entry   = parseFloat(entry.toFixed(2));
    r.stop    = stop;
    r.target1 = tgt;
    r.rr      = risk>0 ? parseFloat(((tgt-entry)/risk).toFixed(1)) : null;
    r.pullback_entry  = ydata.pullback_entry  || null;
    r.pullback_stop   = ydata.pullback_stop   || null;
    r.pullback_target = ydata.pullback_target || null;
    r.pullback_rr     = ydata.pullback_rr     || null;
  }

  // ── 6. 포지션 크기 (타입별 상한 적용) ──
  if(r.action==='ENTER'){
    // 타입별 기본 포지션 상한
    var posMax = momoType==='C' ? 'half(50%)' : momoType==='B' ? 'quarter(25%)' : 'small(15%)';
    if(floatM!==null&&floatM<=2)      r.position_size='quarter(25%)'; // 극소 Float = 슬리피지 위험
    else if(r.score>=85)              r.position_size='half(50%)';
    else if(r.score>=70)              r.position_size='quarter(25%)';
    else                              r.position_size='small(15%)';
    // 타입 상한 적용 (Type A는 아무리 점수 높아도 최대 25%)
    var posRank = {'small(15%)':1,'quarter(25%)':2,'half(50%)':3};
    var maxRank = posRank[posMax]||3;
    if((posRank[r.position_size]||1) > maxRank) r.position_size = posMax;
    if(spyVwapBelow&&r.position_size==='half(50%)') r.position_size='quarter(25%)';
  }

  // ── 7. 슬리피지 필드 전달 ──
  r.slippage_pct  = ydata.slippage_pct  || 0;
  r.slippage_risk = ydata.slippage_risk || 'low';
  r.entry_slip    = ydata.entry_slip    || null;
  r.float_turns   = ydata.float_turns   || null;
  r.breakout_wick_ratio    = ydata.breakout_wick_ratio    ?? null;
  r.breakout_wick_strength = ydata.breakout_wick_strength || null;

  return r;
}


/* ── 모듈 export (Node + 브라우저 양쪽 호환) ── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { momoEngine: momoEngine, getPDSignatures: getPDSignatures, getDumpScore: getDumpScore };
}
if (typeof window !== 'undefined') {
  window.momoEngine = momoEngine;
  window.getPDSignatures = getPDSignatures;
  window.getDumpScore = getDumpScore;
}
