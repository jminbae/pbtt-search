// =====================================================================
// 피부텐텐 써치엔진 - 앱 (렌더링, 라우팅, 소셜 액션, 댓글)
// =====================================================================

(function () {
  const { DOCTORS, VIDEOS, ALL_QAS, POPULAR_QUERIES, search, highlight, groupByVideo } = window.PBTT;

  // ====== Firebase 설정 (사용자가 README에 따라 채워 넣음) ======
  // 비어 있으면 댓글 기능은 "준비 중"으로 표시됩니다.
  const FIREBASE_CONFIG = {
    apiKey: "",
    authDomain: "",
    projectId: "",
    appId: ""
  };
  let firebaseEnabled = false;
  let db = null;

  // ====== 글로벌 좋아요 카운터 (무인증 무료 API) ======
  // abacus.jasoncameron.dev: 한 번 hit하면 +1, get으로 조회. 한 브라우저당 글당 1회만 hit.
  const COUNTER_NS = 'pbtt-search';
  const COUNTER_BASE = 'https://abacus.jasoncameron.dev';
  const COUNTER_CACHE = new Map();   // qaId -> like count
  const READ_CACHE = new Map();      // qaId -> read(more) count

  // ====== LocalStorage 헬퍼 ======
  const STORAGE = {
    LIKES: 'pbtt_likes',         // {qaId: true} - 본인 표시용
    LIKES_HIT: 'pbtt_likes_hit', // {qaId: true} - abacus에 +1 호출했는지 (영구)
    MORE_HIT: 'pbtt_more_hit',   // {qaId: true} - 더보기 카운트 +1 호출했는지
  };
  const ls = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key) || '{}'); }
      catch { return {}; }
    },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
  };

  // ====== 유틸 ======
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
  function showToast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function fmtDate(s) {
    // YYYY-MM-DD → YY.MM.DD
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return `${y.slice(2)}.${m}.${d}`;
  }
  async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ====== Firebase 동적 로드 (설정이 있을 때만) ======
  async function initFirebase() {
    if (!FIREBASE_CONFIG.apiKey) return false;
    try {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js');
      const fs = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
      const app = initializeApp(FIREBASE_CONFIG);
      db = fs.getFirestore(app);
      // expose for handlers
      window._fs = fs;
      firebaseEnabled = true;
      return true;
    } catch (e) {
      console.warn('[Firebase] init failed', e);
      return false;
    }
  }

  // ====== FAQ JSON-LD 동적 주입 (24개 Q&A) ======
  function injectFAQJsonLd() {
    const script = $('#faq-jsonld');
    if (!script) return;
    const data = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "name": "피부텐텐 써치엔진",
      "speakable": {
        "@type": "SpeakableSpecification",
        "cssSelector": [".qa-card .question", ".qa-card .answer"]
      },
      "mainEntity": ALL_QAS.map(qa => ({
        "@type": "Question",
        "name": qa.question,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": qa.answer,
          "author": {
            "@type": "Person",
            "name": qa.doctor + " 원장",
            "jobTitle": "피부과 전문의"
          }
        }
      }))
    };
    script.textContent = JSON.stringify(data);
  }

  // ====== Hash route 파싱 ======
  function parseRoute() {
    // ?q=...&qa=N or hash
    const params = new URLSearchParams(location.search);
    return {
      q: params.get('q') || '',
      qa: params.get('qa') ? parseInt(params.get('qa'), 10) : null,
    };
  }

  function setRoute({ q, qa }) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (qa) params.set('qa', String(qa));
    const newUrl = location.pathname + (params.toString() ? '?' + params.toString() : '');
    history.pushState({ q, qa }, '', newUrl);
  }

  // ====== 인기 검색어 칩 ======
  function renderChips() {
    const container = $('#chips-container');
    if (!container) return;
    container.innerHTML = POPULAR_QUERIES.map(q =>
      `<button type="button" class="chip" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`
    ).join('');
    // 칩 클릭은 document 레벨 핸들러(.tag, .chip 통합)에서 처리 - 중복 제거
    // 칩이 많으면 "더보기" 토글
    setupChipsExpand();
  }

  // 검색어와 일치하는 칩만 연분홍 강조 (display는 건드리지 않음 - 칩은 항상 그대로 노출)
  function highlightChips(query) {
    const container = $('#chips-container');
    if (!container) return;
    const chips = container.querySelectorAll('.chip');
    const norm = (window.PBTT.normalize || (s => (s||'').toLowerCase()))(query || '');
    chips.forEach(c => {
      if (!norm) { c.classList.remove('chip-match'); return; }
      const cn = (window.PBTT.normalize || (s => (s||'').toLowerCase()))(c.dataset.query || '');
      const match = cn.includes(norm) || norm.includes(cn);
      if (match) c.classList.add('chip-match');
      else c.classList.remove('chip-match');
    });
  }

  function setupChipsExpand() {
    const popular = $('#popular-chips');
    const chips = $('#chips-container');
    if (!popular || !chips) return;
    // 기존 더보기 버튼 제거
    popular.querySelector('.chips-more')?.remove();
    // 다음 프레임에 측정 (레이아웃 적용 후)
    requestAnimationFrame(() => {
      const overflows = chips.scrollHeight > chips.clientHeight + 4;
      if (!overflows) return;
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'chips-more';
      more.textContent = '더보기 ▾';
      popular.appendChild(more);
      more.addEventListener('click', () => {
        const expanded = popular.classList.toggle('expanded');
        more.textContent = expanded ? '접기 ▴' : '더보기 ▾';
      });
    });
  }

  // ====== 카드 HTML ======
  function cardHtml(qa, query, isSinglePage = false) {
    const doc = DOCTORS[qa.doctor];
    const likes = ls.get(STORAGE.LIKES);
    const reads = ls.get(STORAGE.MORE_HIT);
    const liked = !!likes[qa.id];
    // 캐시 우선, 없으면 본인 활동 fallback
    const initLike = COUNTER_CACHE.has(qa.id) ? COUNTER_CACHE.get(qa.id) : (likes[qa.id] ? 1 : 0);
    const initRead = READ_CACHE.has(qa.id) ? READ_CACHE.get(qa.id) : (reads[qa.id] ? 1 : 0);
    const fmtCount = c => c == null ? '0' : (c > 999 ? `${(c/1000).toFixed(1)}k` : String(c));
    // 검색어 토큰과 일치하는 키워드 식별 (tag-match 클래스로 핑크 강조)
    const queryNorm = (query || '').trim().toLowerCase().replace(/\s+/g, '');
    const tags = qa.keywords.map(k => {
      const kNorm = k.toLowerCase().replace(/\s+/g, '');
      const isMatch = queryNorm && (
        kNorm === queryNorm ||
        kNorm.includes(queryNorm) ||
        queryNorm.includes(kNorm)
      );
      const cls = isMatch ? 'tag tag-match' : 'tag';
      return `<span class="${cls}" data-query="${escapeHtml(k)}">${escapeHtml(k)}</span>`;
    }).join('');

    const answerHtml = highlight(qa.answer, query);
    const questionHtml = highlight(qa.question, query);
    const doctorHtml = highlight(qa.doctor, query);

    return `
      <article class="qa-card" data-qa-id="${qa.id}" data-video-id="${qa.videoId}" itemscope itemtype="https://schema.org/Question">
        <meta itemprop="name" content="${escapeHtml(qa.question)}">
        <a class="doctor-row" href="doctors.html?slug=${doc.slug}" data-doctor-link>
          <img class="avatar" src="${doc.photo}" alt="${doc.name} 원장 프로필" loading="lazy" width="44" height="44">
          <div class="doctor-info">
            <div class="doctor-name">
              ${doctorHtml} 원장님
              <span class="verified" title="피부과 전문의">✓</span>
            </div>
            <div class="doctor-meta">${doc.title} · ${escapeHtml(qa.videoTopic)} · ${fmtDate(qa.uploadDate)}</div>
          </div>
        </a>
        <h3 class="question">${questionHtml}</h3>
        <div class="answer ${isSinglePage ? '' : 'collapsed'}" itemprop="acceptedAnswer" itemscope itemtype="https://schema.org/Answer">
          <span itemprop="text">${answerHtml}</span>
        </div>
        ${isSinglePage ? '' : '<button type="button" class="toggle-more">더보기 ▾</button>'}
        <a class="yt-original" href="${qa.youtubeUrl}" target="_blank" rel="noopener">
          ▶ 영상 보러가기
        </a>
        <div class="tags">${tags}</div>
        <div class="actions">
          <div class="actions-left">
            <span class="action-btn read-stat" aria-label="조회수" title="조회수">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
              <span class="count read-count">${fmtCount(initRead)}</span>
            </span>
            <button class="action-btn like-btn ${liked ? 'active' : ''}" data-action="like" aria-label="좋아요" aria-pressed="${liked}">
              <svg viewBox="0 0 24 24" fill="${liked ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
              <span class="count like-count">${fmtCount(initLike)}</span>
            </button>
            <button class="action-btn comment-btn" data-action="comments" aria-label="댓글">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              <span class="count comment-count">0</span>
            </button>
          </div>
          <button class="action-btn share-btn" data-action="share" aria-label="공유">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
          </button>
        </div>
        <div class="comments-section" hidden>
          <div class="comments-list" data-qa-id="${qa.id}"></div>
          <form class="comment-form" data-qa-id="${qa.id}">
            <input type="text" name="author" placeholder="이름" maxlength="20" required>
            <input type="password" name="password" placeholder="비밀번호 (수정/삭제용)" maxlength="20" required>
            <textarea name="body" placeholder="댓글을 입력하세요..." maxlength="500" required></textarea>
            <button type="submit">댓글 등록</button>
          </form>
          <div class="comments-status"></div>
        </div>
      </article>
    `;
  }

  // ====== 결과 렌더링 ======
  function renderResults(query) {
    const root = $('#results');
    const headerEl = $('#results-header');
    if (!root) return;

    // 한글 자모 한 글자 등 무의미 입력은 검색 안 함 (전체 결과로)
    const meaningful = isMeaningfulQuery(query);
    const effectiveQuery = meaningful ? query : '';
    const results = search(effectiveQuery);
    // 검색어 있을 때: 영상별 그룹화 없이 개별 Q&A 점수순으로 (여러 원장 섞여 노출)
    // 빈 쿼리(전체 목록): 영상별 묶음 유지
    const groups = effectiveQuery
      ? results.map(r => ({
          videoId: r.qa.videoId,
          totalScore: r.score,
          items: [r],
          uploadDate: r.qa.uploadDate,
        }))
      : groupByVideo(results);

    // 헤더 표시 (의미 있는 쿼리일 때만)
    if (headerEl) {
      if (effectiveQuery) {
        headerEl.hidden = false;
        headerEl.innerHTML = `<strong>"${escapeHtml(effectiveQuery)}"</strong> 검색 결과 ${results.length}건`;
      } else {
        headerEl.hidden = true;
      }
    }

    if (results.length === 0) {
      root.innerHTML = `
        <div class="empty-state">
          <h3>"${escapeHtml(effectiveQuery)}"에 해당하는 Q&A를 찾지 못했어요</h3>
          <p>다른 키워드로 다시 검색해보세요.</p>
          <div class="chips" style="justify-content: center;">
            ${POPULAR_QUERIES.slice(0, 8).map(q =>
              `<button type="button" class="chip" data-query="${escapeHtml(q)}">${escapeHtml(q)}</button>`
            ).join('')}
          </div>
        </div>
      `;
      return;
    }

    // 무한 스크롤 (15개 초과면 12개씩 lazy)
    paginateRender(root, groups, results.length, effectiveQuery);
  }

  // ====== 무한 스크롤 페이지네이션 ======
  const PAGE_THRESHOLD = 20; // 20개 이상이면 페이지네이션 적용
  const PAGE_SIZE = 20;      // 한 번에 로드할 카드 수
  const _pager = { groups: [], cursor: 0, query: '', observer: null };

  function isMasonryViewport() {
    return window.innerWidth >= 900;
  }

  function ensureColumns(root) {
    if (!isMasonryViewport()) return null;
    let left = root.querySelector('.col-left');
    let right = root.querySelector('.col-right');
    if (!left || !right) {
      root.innerHTML = '<div class="col-left"></div><div class="col-right"></div>';
      left = root.querySelector('.col-left');
      right = root.querySelector('.col-right');
    }
    return { left, right };
  }

  // 카드 HTML 배열을 masonry로 root에 분배 (데스크탑) 또는 단일 컬럼 (모바일)
  function distributeCards(root, cardHtmls) {
    root.innerHTML = '';
    const cols = ensureColumns(root);
    cardHtmls.forEach(html => {
      if (cols) {
        const target = cols.left.offsetHeight <= cols.right.offsetHeight ? cols.left : cols.right;
        target.insertAdjacentHTML('beforeend', html);
      } else {
        root.insertAdjacentHTML('beforeend', html);
      }
    });
  }

  function paginateRender(root, groups, totalCount, query) {
    // 이전 옵저버 정리
    if (_pager.observer) { _pager.observer.disconnect(); _pager.observer = null; }
    _pager.groups = groups;
    _pager.cursor = 0;
    _pager.query = query;
    root.innerHTML = '';

    // 데스크탑: masonry 컬럼 div 준비
    ensureColumns(root);

    // 임계치 이하면 한 번에 모두
    if (totalCount <= PAGE_THRESHOLD) {
      appendBatch(root, Infinity);
      refreshCounts();
      return;
    }

    // 첫 12개 로드
    appendBatch(root, PAGE_SIZE);

    // sentinel
    const sentinel = document.createElement('div');
    sentinel.className = 'load-sentinel';
    sentinel.id = 'load-sentinel';
    sentinel.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    root.appendChild(sentinel);

    _pager.observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      if (_pager.cursor >= _pager.groups.length) {
        sentinel.remove();
        _pager.observer.disconnect();
        _pager.observer = null;
        return;
      }
      appendBatch(root, PAGE_SIZE, sentinel);
      if (_pager.cursor >= _pager.groups.length) {
        sentinel.remove();
        _pager.observer.disconnect();
        _pager.observer = null;
      }
    }, { rootMargin: '400px 0px' });
    _pager.observer.observe(sentinel);

    refreshCounts();
  }

  // Masonry: 카드 단위로 짧은 컬럼에 추가 (자연스러운 흐름)
  function appendBatch(root, targetCount, beforeEl) {
    const cols = ensureColumns(root);
    let added = 0;
    let stagger = 0;
    while (_pager.cursor < _pager.groups.length && added < targetCount) {
      const g = _pager.groups[_pager.cursor];
      g.items.forEach((r) => {
        const cardHTML = cardHtml(r.qa, _pager.query)
          .replace('<article ', `<article style="animation-delay:${stagger * 50}ms" `);
        stagger++;
        if (cols) {
          // 짧은 컬럼에 추가 (offsetHeight 측정으로 layout flush 강제)
          const target = cols.left.offsetHeight <= cols.right.offsetHeight ? cols.left : cols.right;
          target.insertAdjacentHTML('beforeend', cardHTML);
        } else if (beforeEl && beforeEl.parentNode) {
          beforeEl.insertAdjacentHTML('beforebegin', cardHTML);
        } else {
          root.insertAdjacentHTML('beforeend', cardHTML);
        }
      });
      added += g.items.length;
      _pager.cursor++;
    }
    refreshCounts();
  }

  // ====== 단일 Q&A 페이지 (?qa=N) ======
  function renderSingleQA(qaId) {
    const qa = ALL_QAS.find(q => q.id === qaId);
    const root = $('#results');
    const headerEl = $('#results-header');
    const hero = $('#hero');

    if (!qa) {
      root.innerHTML = `<div class="empty-state"><h3>Q&A를 찾을 수 없어요</h3></div>`;
      return;
    }

    if (hero) hero.style.display = 'none';
    if (headerEl) headerEl.hidden = true;

    // 동적 메타 업데이트 (소셜 공유 미리보기용)
    document.title = `${qa.question} | 피부텐텐 Q&A`;
    setMeta('description', qa.meta || qa.question);
    setMeta('og:title', qa.question, true);
    setMeta('og:description', qa.meta || '', true);

    root.innerHTML = `
      <div class="qa-detail">
        <a href="./" class="back-link" data-route-link>← 목록으로 돌아가기</a>
        ${cardHtml(qa, '', true)}
      </div>
    `;
    refreshCounts();
  }

  function setMeta(name, content, isProperty = false) {
    const attr = isProperty ? 'property' : 'name';
    let el = document.querySelector(`meta[${attr}="${name}"]`);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attr, name);
      document.head.appendChild(el);
    }
    el.setAttribute('content', content);
  }

  // ====== 인기글 페이지 ======
  // 인기 점수 = 글로벌 좋아요 수 + 펼침(더보기) 카운트 (모두 abacus에 누적)
  async function renderPopularPage() {
    const root = $('#results');
    if (!root) return;
    document.title = '인기글 | 피부텐텐 Q&A';
    root.innerHTML = '<div class="popular-loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>';

    // 모든 카드의 like + more 카운트 병렬 fetch
    const fetchCount = async (key) => {
      try {
        const res = await fetch(`${COUNTER_BASE}/get/${COUNTER_NS}/${key}`);
        if (res.ok) {
          const d = await res.json();
          return d.value ?? d.count ?? 0;
        }
      } catch {}
      return 0;
    };

    // 본인 활동(localStorage)도 카운트에 반영 (글로벌 fetch 실패해도 인기 표시)
    const myLikes = ls.get(STORAGE.LIKES);
    const myReads = ls.get(STORAGE.MORE_HIT);

    const scored = await Promise.all(ALL_QAS.map(async (qa) => {
      const [globalLike, globalMore] = await Promise.all([
        fetchCount(`qa-${qa.id}`),
        fetchCount(`qa-${qa.id}-more`),
      ]);
      // 캐시에 저장 (이후 cardHtml 그릴 때 활용)
      COUNTER_CACHE.set(qa.id, globalLike);
      READ_CACHE.set(qa.id, globalMore);
      // 글로벌 카운트 vs 본인 활동 중 큰 값 (본인은 0 또는 1)
      const like = Math.max(globalLike, myLikes[qa.id] ? 1 : 0);
      const more = Math.max(globalMore, myReads[qa.id] ? 1 : 0);
      // 좋아요는 더 비중 있게 (×2)
      return { qa, like, more, score: like * 2 + more };
    }));

    // 점수 0보다 큰 것만, 인기순 정렬
    const popular = scored.filter(c => c.score > 0).sort((a, b) =>
      b.score - a.score || b.qa.uploadDate.localeCompare(a.qa.uploadDate)
    );

    // 인기 카운트가 아직 모이지 않았으면 최신순으로 fallback
    let displayList = popular;
    let notice = '';
    if (popular.length === 0) {
      displayList = ALL_QAS.slice()
        .sort((a, b) => b.uploadDate.localeCompare(a.uploadDate) || a.id - b.id)
        .map(qa => ({ qa, score: 0 }));
      notice = `<div class="popular-notice">아직 인기 집계가 충분하지 않아 최신순으로 표시합니다.</div>`;
    }

    const cardHtmls = displayList.map(({ qa }, idx) =>
      cardHtml(qa, '').replace('<article ', `<article style="animation-delay:${idx * 30}ms" `)
    );
    root.innerHTML = notice;
    const wrap = document.createElement('div');
    wrap.id = 'pop-cards-wrap';
    root.appendChild(wrap);
    distributeCards(wrap, cardHtmls);
    refreshCounts();
  }

  // ====== 액션 핸들러 ======
  document.addEventListener('click', async (e) => {
    // 태그 클릭 → 검색 / 같은 검색어 재클릭 시 해제 (초기화)
    const tag = e.target.closest('.tag, .chip');
    if (tag && tag.dataset.query) {
      const q = tag.dataset.query;
      const input = $('#search-input');
      if (input) {
        const cur = input.value.trim();
        if (cur === q) {
          // 동일 검색어 재클릭 → 검색 해제
          input.value = '';
          runSearch('');
        } else {
          input.value = q;
          runSearch(q);
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        // 다른 페이지에서 칩/태그 누르면 홈으로
        location.href = `./?q=${encodeURIComponent(q)}`;
      }
      return;
    }

    // 더보기 버튼 또는 본문 클릭으로 토글 (펼침↔접힘)
    const more = e.target.closest('.toggle-more');
    const answer = e.target.closest('.qa-card .answer');
    if (more || (answer && !e.target.closest('a, button'))) {
      const card = (more || answer).closest('.qa-card');
      const ans = card.querySelector('.answer');
      const wasCollapsed = ans.classList.contains('collapsed');
      ans.classList.toggle('collapsed');
      const moreBtn = card.querySelector('.toggle-more');
      if (moreBtn) moreBtn.textContent = ans.classList.contains('collapsed') ? '더보기 ▾' : '접기 ▴';
      // 펼침 시에만 인기 카운트 (한 브라우저당 글당 1회)
      if (wasCollapsed) hitMoreCount(parseInt(card.dataset.qaId, 10));
      return;
    }

    // 라우트 링크
    const routeLink = e.target.closest('[data-route-link]');
    if (routeLink) {
      e.preventDefault();
      history.pushState({}, '', routeLink.getAttribute('href'));
      handleRoute();
      return;
    }

    // 액션 버튼
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      const card = actionBtn.closest('.qa-card');
      const qaId = parseInt(card.dataset.qaId, 10);
      const action = actionBtn.dataset.action;
      if (action === 'like') handleLike(qaId, actionBtn);
      else if (action === 'share') handleShare(qaId);
      else if (action === 'comments') toggleComments(card);
      return;
    }
  });

  // 더보기/펼침 글로벌 카운트 (펼칠 때마다 +1, 같은 브라우저 중복 허용)
  function hitMoreCount(qaId) {
    if (!qaId) return;
    // 본인 활동 표시는 유지 (인기글 점수 계산용 fallback)
    const hits = ls.get(STORAGE.MORE_HIT);
    hits[qaId] = true;
    ls.set(STORAGE.MORE_HIT, hits);
    fetch(`${COUNTER_BASE}/hit/${COUNTER_NS}/qa-${qaId}-more`).then(r => r.ok ? r.json() : null).then(data => {
      if (data) {
        const cnt = data.value ?? data.count ?? 0;
        READ_CACHE.set(qaId, cnt);
        updateReadCount(qaId, cnt);
      }
    }).catch(() => {});
  }

  function updateReadCount(qaId, count) {
    const cnt = (count == null) ? '0' : (count > 999 ? `${(count/1000).toFixed(1)}k` : String(count));
    document.querySelectorAll(`.qa-card[data-qa-id="${qaId}"] .read-count`).forEach(el => {
      el.textContent = cnt;
    });
  }

  async function handleLike(qaId, btn) {
    const likes = ls.get(STORAGE.LIKES);
    const newState = !likes[qaId];
    if (newState) likes[qaId] = true;
    else delete likes[qaId];
    ls.set(STORAGE.LIKES, likes);

    // UI 즉시 반영
    btn.classList.toggle('active', newState);
    btn.setAttribute('aria-pressed', newState);
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', newState ? 'currentColor' : 'none');

    // 글로벌 카운터: 처음 좋아요 누를 때만 +1 (한 브라우저당 글당 1회)
    const hits = ls.get(STORAGE.LIKES_HIT);
    if (newState && !hits[qaId]) {
      hits[qaId] = true;
      ls.set(STORAGE.LIKES_HIT, hits);
      try {
        const res = await fetch(`${COUNTER_BASE}/hit/${COUNTER_NS}/qa-${qaId}`);
        if (res.ok) {
          const data = await res.json();
          const cnt = data.value ?? data.count ?? 0;
          COUNTER_CACHE.set(qaId, cnt);
          updateLikeCount(qaId, cnt);
        }
      } catch (e) { console.warn('like hit failed', e); }
    } else {
      // 본인 좋아요 토글이지만 글로벌은 변하지 않음 → 캐시값 그대로 표시
      updateLikeCount(qaId, COUNTER_CACHE.get(qaId));
    }
  }

  function updateLikeCount(qaId, count) {
    const cnt = (count == null) ? '0' : (count > 999 ? `${(count/1000).toFixed(1)}k` : String(count));
    document.querySelectorAll(`.qa-card[data-qa-id="${qaId}"] .like-count`).forEach(el => {
      el.textContent = cnt;
    });
  }

  function handleShare(qaId) {
    // user-gesture context 유지를 위해 async/await 사용 안 함
    const url = `${location.origin}${location.pathname.replace(/saved\.html$/, '')}?qa=${qaId}`;
    const qa = ALL_QAS.find(q => q.id === qaId);
    const shareData = {
      title: qa ? qa.question : '피부텐텐 Q&A',
      text: '— 피부텐텐 Q&A',
      url
    };

    // 모바일/지원 환경: OS 공유 시트
    if (navigator.share && (!navigator.canShare || navigator.canShare(shareData))) {
      navigator.share(shareData).catch((err) => {
        // AbortError는 사용자가 취소한 것이므로 무시
        if (err && err.name !== 'AbortError') {
          // 시스템 공유 실패 시 클립보드로 폴백
          copyToClipboard(url);
        }
      });
      return;
    }

    // 데스크톱 등 미지원 환경: 클립보드 복사
    copyToClipboard(url);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => showToast('🔗 링크가 복사되었어요'),
        () => fallbackCopy(text)
      );
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('🔗 링크가 복사되었어요');
    } catch {
      prompt('링크 복사:', text);
    }
    document.body.removeChild(ta);
  }

  function toggleComments(card) {
    const sec = card.querySelector('.comments-section');
    if (!sec) return;
    sec.hidden = !sec.hidden;
    if (!sec.hidden) loadComments(parseInt(card.dataset.qaId, 10), card);
  }

  // ====== 댓글 ======
  async function loadComments(qaId, card) {
    const list = card.querySelector('.comments-list');
    const status = card.querySelector('.comments-status');
    if (!list || !status) return;

    if (!firebaseEnabled) {
      status.innerHTML = '댓글 기능은 준비 중입니다. (관리자 Firebase 설정 필요)';
      return;
    }

    status.textContent = '댓글을 불러오는 중...';
    try {
      const { collection, query, where, orderBy, getDocs } = window._fs;
      const q = query(
        collection(db, 'comments'),
        where('qaId', '==', qaId),
        orderBy('createdAt', 'desc')
      );
      const snap = await getDocs(q);
      const docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      list.innerHTML = docs.map(c => commentHtml(c)).join('') || '<div class="comments-status">아직 댓글이 없어요. 첫 댓글을 남겨보세요!</div>';
      status.textContent = '';
    } catch (e) {
      status.textContent = '댓글을 불러오지 못했어요.';
      console.error(e);
    }
  }

  function commentHtml(c) {
    const date = c.createdAt ? new Date(c.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return `
      <div class="comment" data-comment-id="${c.id}">
        <div class="comment-header">
          <span class="comment-author">${escapeHtml(c.author || '익명')}</span>
          <span class="comment-date">${escapeHtml(date)}</span>
        </div>
        <div class="comment-body">${escapeHtml(c.body || '')}</div>
        <div class="comment-actions">
          <button data-action="delete-comment">삭제</button>
        </div>
      </div>
    `;
  }

  document.addEventListener('submit', async (e) => {
    if (!e.target.classList.contains('comment-form')) return;
    e.preventDefault();
    const form = e.target;
    const qaId = parseInt(form.dataset.qaId, 10);
    const card = form.closest('.qa-card');
    const btn = form.querySelector('button[type="submit"]');
    const status = card.querySelector('.comments-status');

    if (!firebaseEnabled) {
      status.textContent = '댓글 기능이 아직 활성화되지 않았어요.';
      return;
    }

    const author = form.author.value.trim();
    const password = form.password.value;
    const body = form.body.value.trim();
    if (!author || !password || !body) return;

    btn.disabled = true;
    status.textContent = '등록 중...';
    try {
      const passHash = await sha256(password);
      const { collection, addDoc } = window._fs;
      await addDoc(collection(db, 'comments'), {
        qaId, author, body, passHash,
        createdAt: Date.now()
      });
      form.reset();
      status.textContent = '';
      await loadComments(qaId, card);
    } catch (e) {
      status.textContent = '등록 실패: ' + e.message;
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-action="delete-comment"]');
    if (!delBtn) return;
    if (!firebaseEnabled) return;
    const commentDiv = delBtn.closest('.comment');
    const commentId = commentDiv.dataset.commentId;
    const card = delBtn.closest('.qa-card');
    const qaId = parseInt(card.dataset.qaId, 10);
    const pw = prompt('댓글 비밀번호를 입력하세요');
    if (!pw) return;
    try {
      const passHash = await sha256(pw);
      const { doc, getDoc, deleteDoc } = window._fs;
      const ref = doc(db, 'comments', commentId);
      const snap = await getDoc(ref);
      if (!snap.exists() || snap.data().passHash !== passHash) {
        alert('비밀번호가 일치하지 않아요.'); return;
      }
      await deleteDoc(ref);
      await loadComments(qaId, card);
      showToast('댓글이 삭제되었어요');
    } catch (e) { alert('삭제 실패: ' + e.message); }
  });

  // ====== 좋아요/조회수 카운트 새로고침 (abacus API) ======
  async function refreshCounts() {
    const visibleIds = $$('.qa-card').map(c => parseInt(c.dataset.qaId, 10));
    // 캐시 우선 표시 → 실제 fetch
    visibleIds.forEach(id => {
      if (COUNTER_CACHE.has(id)) updateLikeCount(id, COUNTER_CACHE.get(id));
      if (READ_CACHE.has(id)) updateReadCount(id, READ_CACHE.get(id));
    });

    // 가시 카드들의 like + read(more) 카운트 병렬 조회
    await Promise.allSettled(visibleIds.flatMap(qaId => [
      // like
      (async () => {
        try {
          const res = await fetch(`${COUNTER_BASE}/get/${COUNTER_NS}/qa-${qaId}`);
          if (res.ok) {
            const data = await res.json();
            const cnt = data.value ?? data.count ?? 0;
            COUNTER_CACHE.set(qaId, cnt);
            updateLikeCount(qaId, cnt);
          } else if (res.status === 404) {
            COUNTER_CACHE.set(qaId, 0);
            updateLikeCount(qaId, 0);
          }
        } catch {}
      })(),
      // read(more)
      (async () => {
        try {
          const res = await fetch(`${COUNTER_BASE}/get/${COUNTER_NS}/qa-${qaId}-more`);
          if (res.ok) {
            const data = await res.json();
            const cnt = data.value ?? data.count ?? 0;
            READ_CACHE.set(qaId, cnt);
            updateReadCount(qaId, cnt);
          } else if (res.status === 404) {
            READ_CACHE.set(qaId, 0);
            updateReadCount(qaId, 0);
          }
        } catch {}
      })(),
    ]));

    // 댓글 카운트 (Firebase 활성화된 경우)
    $$('.comment-count').forEach(el => el.textContent = '0');
    if (firebaseEnabled) {
      try {
        for (const qaId of visibleIds) {
          const { collection, query, where, getCountFromServer } = window._fs;
          try {
            const q = query(collection(db, 'comments'), where('qaId', '==', qaId));
            const snap = await getCountFromServer(q);
            const cnt = snap.data().count;
            const card = document.querySelector(`.qa-card[data-qa-id="${qaId}"]`);
            if (card && cnt > 0) {
              const el = card.querySelector('.comment-count');
              if (el) el.textContent = cnt;
            }
          } catch {}
        }
      } catch {}
    }
  }

  // ====== 검색 실행 ======
  let _searchTimer;
  function runSearch(query) {
    setRoute({ q: query, qa: null });
    renderResults(query);
    highlightChips(query);
  }
  function debouncedSearch(query) {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => runSearch(query), 150);
  }

  // ====== 라우팅 ======
  function handleRoute() {
    const { q, qa } = parseRoute();

    // popular.html (인기글)
    if (location.pathname.endsWith('popular.html') || location.pathname.endsWith('saved.html')) {
      renderPopularPage();
      return;
    }
    // doctors.html (목록 또는 단일)
    if (location.pathname.endsWith('doctors.html')) {
      const slug = new URLSearchParams(location.search).get('slug');
      if (slug) renderDoctorPage(slug);
      else renderDoctorList();
      return;
    }

    const input = $('#search-input');
    if (input && input.value !== q) input.value = q;

    if (qa) {
      renderSingleQA(qa);
    } else {
      const hero = $('#hero');
      if (hero) hero.style.display = '';
      // 메타 복원
      document.title = '피부텐텐 Q&A. 피부과 전문의가 전하는 피부가 예뻐지는 모든 이야기';
      renderResults(q);
    }
    highlightChips(q);
  }

  // ====== 원장 목록 / 단일 페이지 ======
  function getDoctorLatestDate(doctorName) {
    let latest = '';
    for (const qa of ALL_QAS) {
      if (qa.doctor === doctorName) {
        if (qa.uploadDate > latest) latest = qa.uploadDate;
      }
    }
    return latest;
  }

  function renderDoctorList() {
    const root = $('#doctors-root');
    if (!root) return;
    document.title = '원장님 | 피부텐텐 Q&A';

    // 영상 데이터 있는 원장 우선, 그 안에서 최신 영상 순
    const list = Object.values(DOCTORS).map(d => ({
      ...d,
      latestDate: getDoctorLatestDate(d.name),
      qaCount: ALL_QAS.filter(q => q.doctor === d.name).length,
    }));
    list.sort((a, b) => {
      // 데이터 있는 사람 먼저
      if (!!a.latestDate !== !!b.latestDate) return a.latestDate ? -1 : 1;
      // 둘 다 있으면 최신순
      if (a.latestDate && b.latestDate) return b.latestDate.localeCompare(a.latestDate);
      // 둘 다 없으면 이름순
      return a.name.localeCompare(b.name);
    });

    root.innerHTML = `
      <header class="doctors-header">
        <h2>피부과 전문의</h2>
        <p class="doctors-sub">피부텐텐의 피부과 전문의들이 직접 답합니다.</p>
      </header>
      <div class="doctor-grid">
        ${list.map((d, i) => `
          <a href="doctors.html?slug=${d.slug}" class="doctor-card" data-doctor-link style="animation-delay:${i*40}ms">
            <img class="doctor-photo" src="${d.photo}" alt="${d.name} 원장" loading="lazy">
            <div class="doctor-card-body">
              <div class="doctor-card-name">${escapeHtml(d.name)}</div>
              <div class="doctor-card-title">피부과 전문의</div>
            </div>
          </a>
        `).join('')}
      </div>
    `;
  }

  // "강남점 대표원장" → "강남점"
  function shortBranch(b) {
    return (b || '').replace(/\s*대표원장\s*$/, '').trim();
  }

  function renderDoctorPage(slug) {
    const root = $('#doctors-root');
    if (!root) return;
    const doctor = Object.values(DOCTORS).find(d => d.slug === slug);
    if (!doctor) {
      root.innerHTML = `<div class="empty-state"><h3>원장님을 찾을 수 없어요</h3><p><a href="doctors.html">목록으로 돌아가기</a></p></div>`;
      return;
    }
    document.title = `${doctor.name} 원장님 | 피부텐텐 Q&A`;
    setMeta('description', `${doctor.name} 원장님 — ${doctor.intro || ''}`);

    const qas = ALL_QAS
      .filter(qa => qa.doctor === doctor.name)
      .sort((a, b) => b.uploadDate.localeCompare(a.uploadDate) || a.id - b.id);

    const affiliation = `힐하우스피부과 ${shortBranch(doctor.branch)}`;
    root.innerHTML = `
      <header class="doctor-hero">
        <div class="doctor-hero-info">
          <p class="doctor-hero-intro">${escapeHtml(doctor.intro || '')}</p>
          <div class="doctor-hero-meta">
            <h1 class="doctor-hero-name">${escapeHtml(doctor.name)}</h1>
            <div class="doctor-hero-branch">${escapeHtml(affiliation)}</div>
          </div>
        </div>
        <div class="doctor-hero-photo-wrap">
          <img class="doctor-hero-photo" src="images/doctors-large/${doctor.slug}.png" alt="${doctor.name} 원장" loading="eager"
               onerror="this.onerror=null;this.src='${doctor.photo}'">
        </div>
      </header>
      <h3 class="doctor-qa-heading">${escapeHtml(doctor.name)} 원장님의 Q&A ${qas.length > 0 ? `(${qas.length})` : ''}</h3>
      <section id="results"></section>
    `;

    const resultsEl = root.querySelector('#results');
    if (qas.length === 0) {
      resultsEl.innerHTML = `<div class="empty-state"><p>아직 등록된 Q&A가 없어요. 곧 만나보실 수 있습니다.</p></div>`;
    } else {
      const cardHtmls = qas.map((qa, i) =>
        cardHtml(qa, '').replace('<article ', `<article style="animation-delay:${i*60}ms" `)
      );
      distributeCards(resultsEl, cardHtmls);
    }
    refreshCounts();
  }

  // 검색어 의미성 판정: 완성형 한글 1자 이상 OR 영문/숫자 2자 이상
  function isMeaningfulQuery(q) {
    if (!q) return false;
    if (/[가-힣]/.test(q)) return true;
    if (/[a-zA-Z0-9]{2,}/.test(q)) return true;
    return false;
  }

  window.addEventListener('popstate', handleRoute);

  // ====== 검색창 자동 포커스 + 모바일 슬라이드 업 (akd-members 패턴) ======
  function setupSearchUX(input) {
    if (!input) return;
    const hero = $('#hero');
    const main = document.querySelector('main');

    // 데스크톱: 자동 포커스 (모바일은 가상 키보드 강제 호출 방지)
    if (window.innerWidth > 768) {
      setTimeout(() => input.focus({ preventScroll: true }), 50);
    }

    if (!hero || !main) return;

    let blurDelayTimer = null;
    let removeStyleTimer = null;
    const clearAllPending = () => {
      if (blurDelayTimer) { clearTimeout(blurDelayTimer); blurDelayTimer = null; }
      if (removeStyleTimer) { clearTimeout(removeStyleTimer); removeStyleTimer = null; }
    };

    // 모바일에서 main 전체(검색창 + 인기검색어 + 결과)를 살짝만 위로 슬라이드
    const slideSearchUp = () => {
      if (window.innerWidth > 768) return;
      if (hero.classList.contains('search-focused')) return;
      const searchBox = document.querySelector('.search-form');
      if (!searchBox) return;
      clearAllPending();
      // 정확한 위치 측정을 위해 일시적으로 transform 제거
      main.style.transition = 'none';
      main.style.transform = 'none';
      void main.offsetHeight;
      const rect = searchBox.getBoundingClientRect();
      // navbar(56) + 여유(24) = 80px 위치 — 살짝 더 위로
      const TARGET_TOP = 80;
      const shift = Math.min(0, -(rect.top - TARGET_TOP));
      main.style.transition = '';
      hero.classList.add('search-focused');
      main.style.transform = shift === 0 ? '' : `translate3d(0, ${shift}px, 0)`;
    };

    const revertIfEmpty = () => {
      if (input.value.trim()) return;
      if (!hero.classList.contains('search-focused')) return;
      hero.classList.remove('search-focused');
      main.style.transform = 'translate3d(0, 0, 0)';
      removeStyleTimer = setTimeout(() => {
        main.style.transform = '';
        removeStyleTimer = null;
      }, 400);
    };

    input.addEventListener('focus', slideSearchUp);
    // 재탭 폴백 (Android Chrome: blur 후에도 input이 포커스 유지될 수 있어 focus 이벤트가 안 뜸)
    const reTap = () => setTimeout(slideSearchUp, 30);
    input.addEventListener('pointerdown', reTap);
    input.addEventListener('click', reTap);

    input.addEventListener('blur', () => {
      blurDelayTimer = setTimeout(() => {
        revertIfEmpty();
        blurDelayTimer = null;
      }, 100);
    });

    // VisualViewport: 모바일 키보드 닫힘 감지 (Android 시스템 백버튼 등)
    if (window.visualViewport) {
      let lastKeyboardOpen = false;
      window.visualViewport.addEventListener('resize', () => {
        const keyboardOpen = (window.innerHeight - window.visualViewport.height) > 100;
        if (lastKeyboardOpen && !keyboardOpen) {
          if (!input.value.trim()) revertIfEmpty();
        }
        lastKeyboardOpen = keyboardOpen;
      });
    }
  }

  // ====== 초기화 ======
  document.addEventListener('DOMContentLoaded', async () => {
    injectFAQJsonLd();
    renderChips();

    // 검색 폼
    const form = $('#search-form');
    const input = $('#search-input');
    if (form && input) {
      form.addEventListener('submit', e => {
        e.preventDefault();
        input.blur(); // submit 시 키보드 내림
        runSearch(input.value.trim());
      });
      input.addEventListener('input', () => {
        const q = input.value.trim();
        highlightChips(q);
        debouncedSearch(q);
      });
    }

    setupSearchUX(input);

    await initFirebase();
    handleRoute();
  });
})();
