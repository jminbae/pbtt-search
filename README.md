# 피부텐텐 써치엔진 (pbtt-search)

피부과 전문의가 답변한 피부시술 Q&A를 검색하는 정적 웹사이트입니다.

- **GitHub Pages 배포**: https://`{username}`.github.io/pbtt-search/
- **기술 스택**: 순수 HTML / CSS / Vanilla JS (프레임워크 없음)
- **데이터**: 6개 영상 × 4개 Q&A = 총 24개 (5인 원장)

## 주요 기능

- **퍼지 검색**: 동의어 사전 + Levenshtein 편집거리 + n-gram 부분매칭으로 오타 허용
- **쓰레드 그룹핑**: 같은 영상 Q&A를 트위터 쓰레드처럼 시각적으로 묶어 표시
- **카드 인터랙션**: 좋아요(❤) / 저장(🔖) / 공유(⤴) / 댓글(💬)
  - 좋아요·저장: localStorage (본인 브라우저에 저장)
  - 공유: Web Share API + URL 복사 (단일 Q&A 딥링크 `?qa=N`)
  - 댓글: Firebase Firestore (이름·비번 입력, SHA-256 해시로 비번 검증)
- **검색어 하이라이트**: `<mark>` 태그로 매칭 부분 강조
- **반응형**: 모바일 풀폭, 데스크톱 680px 컨테이너
- **SEO/AEO/GEO 최적화**:
  - `schema.org/FAQPage` JSON-LD (24개 Q&A 모두 포함)
  - `Speakable` 어노테이션 (음성 검색)
  - `WebSite + SearchAction` (구글 사이트링크 검색박스)
  - `MedicalOrganization` 구조화
  - 시맨틱 HTML + `itemscope/itemtype` 마이크로데이터 (Question/Answer)
  - `og:*` / `twitter:card` 메타
  - 자연어 메타 키워드 (사람들이 실제로 검색하는 표현 위주)
  - sitemap.xml / robots.txt

## 파일 구조

```
pbtt-search/
├── index.html          # 메인 검색 페이지
├── saved.html          # 저장한 Q&A 페이지
├── css/style.css       # 디자인 시스템
├── js/
│   ├── data.js         # 24개 Q&A + 동의어 사전
│   ├── search.js       # 검색 엔진 (퍼지/동의어/하이라이트)
│   └── app.js          # 렌더링/라우팅/소셜/댓글
├── images/doctors/     # 5인 원장 프로필 (200×200 WebP)
├── sitemap.xml
├── robots.txt
└── .nojekyll           # GitHub Pages Jekyll 비활성화
```

## 댓글 활성화 (Firebase 설정 가이드)

댓글 기능을 켜려면 무료 Firebase Firestore를 연결하세요. (5분 소요, 트래픽이 적으면 비용 0원)

### 1) Firebase 프로젝트 생성

1. [Firebase Console](https://console.firebase.google.com/) → "프로젝트 추가"
2. 프로젝트 이름: `pbtt-search` (자유)
3. Google Analytics는 비활성화해도 무방

### 2) Firestore Database 생성

1. 좌측 메뉴 → "Firestore Database" → "데이터베이스 만들기"
2. 위치: `asia-northeast3 (서울)` 선택
3. **테스트 모드**로 시작 (이후 보안 규칙 수정 권장)

### 3) 웹 앱 등록 & 키 발급

1. 프로젝트 설정(⚙) → "내 앱" → 웹(`</>`) 아이콘 클릭
2. 앱 닉네임 입력 → 등록
3. 표시되는 `firebaseConfig` 객체를 복사

### 4) `js/app.js`에 키 입력

`js/app.js` 상단의 `FIREBASE_CONFIG`를 교체합니다:

```js
const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "pbtt-search.firebaseapp.com",
  projectId: "pbtt-search",
  appId: "1:1234:web:abc..."
};
```

### 5) Firestore 보안 규칙 (권장)

Firestore → 규칙 탭에서 아래로 교체:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /comments/{id} {
      allow read: if true;
      allow create: if request.resource.data.author is string
                    && request.resource.data.author.size() <= 20
                    && request.resource.data.body.size() <= 500;
      allow delete: if true;  // 클라이언트에서 비번 해시로 확인
      allow update: if false;
    }
    match /qa_likes/{id} {
      allow read, write: if true;
    }
  }
}
```

### 6) 도메인 등록

Firebase 콘솔 → Authentication → Settings → "승인된 도메인"에 GitHub Pages 도메인을 추가하세요.
(예: `username.github.io`)

설정 후 페이지를 새로고침하면 댓글이 활성화됩니다.

## 로컬 실행

```bash
# Python
python -m http.server 8000

# Node.js
npx serve

# 또는 그냥 index.html을 브라우저로 열어도 동작 (Firebase는 file:// 에서 안 됨)
```

## 라이선스

콘텐츠 저작권은 피부텐텐에 있습니다.
