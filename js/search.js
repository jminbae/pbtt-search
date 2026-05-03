// =====================================================================
// 피부텐텐 써치엔진 - 검색 엔진
// 동의어 정규화 + n-gram + Levenshtein 퍼지 매칭 + 가중치 스코어링
// =====================================================================

(function (global) {
  const { SYNONYMS, ALL_QAS, DOCTORS } = global.PBTT;

  // 모든 동의어 → 표준 키워드 역매핑 인덱스 생성
  const SYNONYM_INDEX = {};
  for (const [canonical, variants] of Object.entries(SYNONYMS)) {
    for (const variant of variants) {
      SYNONYM_INDEX[normalize(variant)] = canonical;
    }
  }

  // 공백/특수문자 제거 + 소문자
  function normalize(str) {
    return (str || '').toLowerCase().replace(/[\s\-_·,.!?'"()「」『』]/g, '');
  }

  // Levenshtein distance (편집 거리)
  function levenshtein(a, b) {
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
    }
    return dp[a.length][b.length];
  }

  // 질의어 → 동의어 정규화 + 퍼지 매칭으로 표준 키워드 후보 추가
  function expandQuery(query) {
    const norm = normalize(query);
    const tokens = new Set([norm]);

    // 1) 직접 동의어 매핑
    if (SYNONYM_INDEX[norm]) {
      tokens.add(normalize(SYNONYM_INDEX[norm]));
    }

    // 2) 퍼지 매칭: 동의어 사전의 모든 변형과 편집거리 비교
    //    한국어 짧은 단어(2~5자)는 거리 1, 긴 단어는 2까지 허용
    for (const variant of Object.keys(SYNONYM_INDEX)) {
      if (variant === norm) continue;
      const maxDist = variant.length <= 4 ? 1 : 2;
      // 길이 차이가 크면 스킵 (성능)
      if (Math.abs(variant.length - norm.length) > maxDist) continue;
      const dist = levenshtein(norm, variant);
      if (dist <= maxDist) {
        tokens.add(variant);
        tokens.add(normalize(SYNONYM_INDEX[variant]));
      }
    }

    return Array.from(tokens).filter(Boolean);
  }

  // n-gram 생성 (한국어 부분 검색용)
  function ngrams(str, n = 2) {
    const s = normalize(str);
    if (s.length < n) return [s];
    const grams = [];
    for (let i = 0; i <= s.length - n; i++) {
      grams.push(s.slice(i, i + n));
    }
    return grams;
  }

  // 한 Q&A 항목에 대해 점수 계산
  function scoreQA(qa, queryTokens, rawQuery) {
    const rawNorm = normalize(rawQuery);
    if (!rawNorm) return 0;

    let score = 0;
    const topicNorm = normalize(qa.videoTopic);
    const questionNorm = normalize(qa.question);
    const answerNorm = normalize(qa.answer);
    const doctorNorm = normalize(qa.doctor);
    const keywordsNorm = qa.keywords.map(normalize);

    for (const token of queryTokens) {
      if (!token) continue;

      // 영상 주제 일치
      if (topicNorm.includes(token)) score += 100;

      // 키워드 배열 일치
      for (const kw of keywordsNorm) {
        if (kw === token) score += 60;
        else if (kw.includes(token) || token.includes(kw)) score += 35;
      }

      // 질문 텍스트 일치
      if (questionNorm.includes(token)) score += 40;

      // 답변 빈도
      const occurrences = (answerNorm.match(new RegExp(escapeRegex(token), 'g')) || []).length;
      score += Math.min(occurrences * 5, 25);

      // 원장님 이름 일치
      if (doctorNorm.includes(token)) score += 30;
    }

    // 보너스: 원본 검색어가 그대로 포함되어 있으면 가중치
    if (rawNorm.length >= 2) {
      if (questionNorm.includes(rawNorm)) score += 50;
      if (topicNorm.includes(rawNorm)) score += 50;
    }

    // n-gram bigram fallback (오타/부분어 보강)
    if (score === 0 && rawNorm.length >= 2) {
      const queryBigrams = ngrams(rawNorm, 2);
      const haystack = topicNorm + questionNorm + answerNorm + keywordsNorm.join('');
      let hits = 0;
      for (const bg of queryBigrams) {
        if (haystack.includes(bg)) hits++;
      }
      if (hits >= Math.max(1, queryBigrams.length / 2)) {
        score += hits * 8;
      }
    }

    return score;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 메인 검색 함수
  function search(query) {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      // 빈 검색어 → 전체 Q&A를 영상 ID + 글 순서대로 반환
      return ALL_QAS.map(qa => ({ qa, score: 1 }));
    }

    const tokens = expandQuery(trimmed);
    const results = [];

    for (const qa of ALL_QAS) {
      const sc = scoreQA(qa, tokens, trimmed);
      if (sc > 0) results.push({ qa, score: sc });
    }

    results.sort((a, b) => b.score - a.score || a.qa.id - b.qa.id);
    return results;
  }

  // 검색어 하이라이트용: HTML-safe + <mark> 래핑
  function highlight(text, query) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    if (!query) return escaped;
    const trimmed = query.trim();
    if (!trimmed) return escaped;

    const tokens = expandQuery(trimmed);
    // 원본 검색어의 모든 부분도 추가 (하이라이트는 원본 표기 우선)
    const allTokens = new Set([trimmed, ...tokens]);
    // 길이가 긴 것부터 매칭하도록 정렬
    const sorted = Array.from(allTokens)
      .filter(t => t && t.length >= 1)
      .sort((a, b) => b.length - a.length);

    if (sorted.length === 0) return escaped;

    const pattern = sorted.map(escapeRegex).join('|');
    const re = new RegExp(`(${pattern})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 결과를 영상별로 그룹핑 (쓰레드 렌더링용)
  // 빈 검색어인 경우 영상 순서대로, 검색 결과인 경우 점수 합 기준으로 정렬
  function groupByVideo(results) {
    const groups = new Map();
    for (const r of results) {
      const vid = r.qa.videoId;
      if (!groups.has(vid)) {
        groups.set(vid, { videoId: vid, totalScore: 0, items: [] });
      }
      const g = groups.get(vid);
      g.items.push(r);
      g.totalScore += r.score;
    }
    // 영상 내부는 q.id 오름차순 (원본 순서)
    for (const g of groups.values()) {
      g.items.sort((a, b) => a.qa.id - b.qa.id);
    }
    return Array.from(groups.values()).sort((a, b) => b.totalScore - a.totalScore || a.videoId - b.videoId);
  }

  global.PBTT.search = search;
  global.PBTT.highlight = highlight;
  global.PBTT.groupByVideo = groupByVideo;
  global.PBTT.expandQuery = expandQuery;
  global.PBTT.normalize = normalize;
})(window);
