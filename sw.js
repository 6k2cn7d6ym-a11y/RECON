// RECON Service Worker
// 버전 올리면 자동으로 새 캐시로 교체

const VERSION = 'recon-v9';
const CACHE   = VERSION;

// 설치 — 핵심 파일 캐시
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(cache){
      return cache.addAll(['/RECON/', '/RECON/index.html']);
    }).then(function(){
      return self.skipWaiting(); // 즉시 활성화
    })
  );
});

// 활성화 — 구버전 캐시 삭제
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    }).then(function(){
      return self.clients.claim(); // 모든 탭에 즉시 적용
    })
  );
});

// 요청 처리 — 네트워크 우선, 실패 시 캐시
self.addEventListener('fetch', function(e){
  // API 요청은 캐시 안 함
  if(e.request.url.includes('anthropic.com') ||
     e.request.url.includes('workers.dev') ||
     e.request.url.includes('yahoo.com') ||
     e.request.url.includes('finviz.com')){
    return;
  }

  e.respondWith(
    fetch(e.request).then(function(res){
      // 성공하면 캐시 업데이트
      var clone = res.clone();
      caches.open(CACHE).then(function(cache){
        cache.put(e.request, clone);
      });
      return res;
    }).catch(function(){
      // 오프라인이면 캐시에서
      return caches.match(e.request);
    })
  );
});
