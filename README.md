# C - TheResolve 🇮🇳
### AI-Powered Community Infrastructure Intelligence & Rapid Municipal Redressal

**C - TheResolve** is a production-grade, responsive Progressive Web Application (PWA) that empowers citizens across India to report localized civic infrastructure failures (potholes, open manholes, sewage overflow, garbage dumps, dark streetlights, and burst water pipes).

---

## ✅ Feature Highlights

| Focus | C - TheResolve Implementation |
| :---: | :--- |
| **AI / Technical Execution** | **Google Gemini Multimodal Vision API** (`gemini-3.5-flash`, with runtime fallback across the model catalog so a retired model name cannot break a live demo) analyzes civic damage photos, evaluates structural severity (1.0 to 5.0), detects spam/non-civic uploads, and recommends civil remediation. Voice notes are transcribed and translated by the same API. |
| **Depth & Reach Across India** | **Seeded pilot across all 13 Andhra Pradesh districts**, so state, district and category demand rollups are exercised on real geography rather than one city. **8 Indian languages** (Hindi, Tamil, Telugu, Kannada, Bengali, Marathi, Gujarati, English) + **Voice-First reporting** via Web Speech API so rural/semi-urban citizens can report issues naturally in their mother tongue. Department structures are generic, so onboarding another state is a seed-data change. |
| **Problem-Solution Fit** | **25 m spatial deduplication** stops duplicate ticket flood. Locations are stored as PostGIS `GEOGRAPHY(Point, 4326)`; the proximity match runs geodesically in the app. Automatically recalculates dynamic priority: $\text{Priority} = (\text{ML\_Severity} \times 0.35) + (\log_{10}(\text{Reports}+1) \times 0.30) + (\text{Upvotes} \times 0.20) + (\text{SLA\_Decay} \times 0.15)$. |
| **Deployability & Scalability** | **Mobile-First PWA**: No app store install barriers. Works on low-end Android smartphones: the browser resizes every upload to a 1280px WebP before it is sent, and EXIF GPS is checked against the reported position. Citizen photos and proof-of-work images live in S3-compatible object storage, so Postgres holds only a reference. Includes Municipal Officer Command Portal. |
| **Impact Potential** | Eliminates duplicate municipal work orders, optimizes road maintenance budget dispatch, and prioritizes fatal open manholes and road craters within 24h SLA. |

---

## 🚀 Quick Start (Running Locally)

### 1. Install & Run Dev Server
```bash
npm install
npm run dev
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser.

### 2. (Optional) Configure Google Gemini API Key
To connect directly to live Google Gemini AI, copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```
Add your Gemini API key from [Google AI Studio](https://aistudio.google.com/):
```env
GEMINI_API_KEY=AIzaSy...
```
*(Note: If no API key is provided, the platform automatically uses a high-fidelity civic heuristic engine so live judging and offline demos never crash!)*

### 3. (Optional) Run PostGIS Database & Object Storage
```bash
docker compose up -d
```
Spins up the full stack: the app on **http://localhost:3010**, PostgreSQL 16 + PostGIS on **port 5455**, and MinIO object storage on **ports 9010** (S3 API) / **9011** (console, default login `minioadmin` / `miniopassword`).

Citizen photos and proof-of-work images are written to the MinIO bucket and served back through `/api/images/<key>`; Postgres stores only that path. Docker Compose creates the bucket automatically on first upload.

### 4. Try the 3-Tier Role-Personas (Real RBAC — no shared access)

The app ships with **three strictly-separated personas**, each with its own account and permissions enforced **server-side** (JWT cookie + per-route role guards + department isolation — not just hidden buttons).

| Persona | How to sign in | What you get |
| :--- | :--- | :--- |
| **Citizen** | `Sign in → Citizen (OTP)` — enter any 10-digit mobile number; the demo OTP is shown on screen | Report hazards (photo + voice note), upvote **once** per report, track own reports, live status notifications |
| **Department Staff** | `Sign in → Staff / Admin` — one-tap demo accounts | Department-scoped task queue (`Start Work → upload proof-of-work → Mark Resolved`), reassignment requests |
| **City Admin** | Same one-tap panel, `admin@city.gov` | Full console: **Triage** (verify/reject), **Dispatch** (assign dept + worker, merge duplicates, reject), **Departments** CRUD, **Analytics** (KPIs, SLA breaches, audit trail) |

Demo accounts:
```
water@city.gov  / demo1234    -> Water Supply & Sanitation (DEPT_WATER)
roads@city.gov  / demo1234    -> Public Works & Roads (DEPT_PWD)
admin@city.gov  / admin1234   -> City Admin (super-admin; verifies, dispatches, never self-resolves)
```

Try signing in as **Water** and opening a Roads ticket — you'll get a hard `403`. The workflow state machine runs `reported → in_review → verified → assigned → in_progress → resolved` (proof photo required before `resolved`), plus `rejected` and `merged` for duplicates folded into another ticket.

### 5. Verify the Checkout
```bash
npm run verify   # typecheck + lint + tests
npm run build
```
The same three checks run on every push to `main` and on every pull request. `npm run test:watch` for the tests alone.

---

## 📂 Architecture & Key Code

- **Frontend PWA & UI:** [`src/app/page.tsx`](src/app/page.tsx)
- **Google Gemini Multimodal Vision & Speech Service:** [`src/lib/gemini.ts`](src/lib/gemini.ts)
- **Dynamic Prioritization Algorithm:** [`src/lib/scoring.ts`](src/lib/scoring.ts)
- **Spatial Deduplication:** indexed `ST_DWithin` in [`src/lib/postgresStore.ts`](src/lib/postgresStore.ts), with the in-memory counterpart in [`src/lib/spatial.ts`](src/lib/spatial.ts) used only when `DATABASE_URL` is unset
- **Reverse Geocoding (real addresses):** [`src/lib/geocoding.ts`](src/lib/geocoding.ts)
- **Object Storage (citizen photos / proof images):** [`src/lib/objectStore.ts`](src/lib/objectStore.ts)
- **Image Streaming Route:** [`src/app/api/images/[...key]/route.ts`](src/app/api/images/%5B...key%5D/route.ts)
- **Postgres/PostGIS Persistence Layer:** [`src/lib/postgresStore.ts`](src/lib/postgresStore.ts)
- **Migrations (authoritative schema):** [`database/migrations/`](database/migrations)
- **Multilingual Indian Languages (8 Langs):** [`src/lib/languages.ts`](src/lib/languages.ts)
- **Multi-state seed data (5 states, 24 districts):** [`src/lib/seedIssues.ts`](src/lib/seedIssues.ts)
- **Demand & Hotspot Intelligence:** [`src/lib/demand.ts`](src/lib/demand.ts)
- **data.gov.in Public-Data Fusion:** [`src/lib/publicData.ts`](src/lib/publicData.ts)
- **Municipal Command Console (admin):** [`src/components/AdminPortal.tsx`](src/components/AdminPortal.tsx)
- **Tests:** `src/lib/*.test.ts` (Vitest) — spatial, workflow, demand, geocoding
- **CI:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — typecheck, lint, test, build

> `database/schema.sql` is a reference document regenerated from the live database and verified against it. The schema the app actually creates and queries is `database/migrations/*.sql`, applied once in filename order and recorded in `schema_migrations`.

---

## ⚠️ Known Limitations

Documented deliberately rather than papered over, so the current state is auditable:

- **data.gov.in fusion is config-gated.** The transport is implemented and fails soft, but it stays dormant until `DATA_GOV_IN_API_KEY` and `DATA_GOV_IN_PCA_RESOURCE` are set. Without them the demand engine runs on a curated contextual baseline. The configured `DATA_GOV_IN_PCA_STATE` also still names Andhra Pradesh, so a census join would return one state's indicators even though the seeded dataset now spans five.
- **Report submission is not covered end to end by tests.** Gemini's civic classifier correctly rejects synthetic test images, so `POST /api/reports` cannot be exercised in an automated test without a real civic photo. The geocoder it calls is verified against the live service and `formatAddress` has unit coverage, but the full path from multipart request to stored issue is only verified by hand.
- **Unit tests cover the pure logic, not the React tree or the HTTP layer.** 56 tests across spatial, workflow, demand and geocoding, which is where silent regressions have actually bitten. Components, routes and both store implementations are exercised by hand against a live container, not by the suite.
- **Local Docker volumes keep application data on your machine.** `docker compose up` writes Postgres and MinIO data into named volumes on the local disk. "Zero application data on the laptop" holds for anything not committed to git, but not for a local Docker run; only a hosted deployment satisfies it literally.
- **Issue images are served without authentication.** `/api/images/<key>` is public by design so the anonymous feed can render photos. Keys are random UUIDs and there is no directory listing, but anyone holding a URL can read that image, and a citizen's photo is linked from the public feed.
- **Voice recordings are not retained.** Only the Gemini-generated transcript is persisted, matching the published privacy policy. Staff see the text, never playback.
- **Session cookies require HTTPS in production.** The production cookie carries the `Secure` flag, so a plain-HTTP LAN or IP deployment will not keep a session. `SESSION_COOKIE_SECURE=false` relaxes this for an HTTP pilot and is the only supported way to run one; see `.env.example`.
- **Geographic coverage is uneven by design.** Andhra Pradesh is a full 13-district pilot. Karnataka, Telangana, Maharashtra and Delhi contribute 3–4 districts each, chosen to exercise the cross-state rollups, not to represent real coverage. Every seeded coordinate is a district headquarters or a representative locality, not an official ward boundary.
- **`cloudrun.yaml` is an unedited template.** The image is still the `gcr.io/YOUR_PROJECT_ID/...` placeholder and no managed PostGIS instance is provisioned.

### Resolved since the last revision

Kept here so the gaps that have been closed are visible rather than quietly forgotten:

- ~~Spatial deduplication runs in the application, not in SQL.~~ Now an indexed `ST_DWithin` query against `idx_issues_location_gist`, with `merged` correctly treated as terminal so a new report can never be absorbed into a closed issue. The in-memory store still loops, but only runs when `DATABASE_URL` is unset.
- ~~Street-level addresses are synthetic.~~ `generateMockAddress()` could emit only six fixed strings and is gone. Addresses now come from Nominatim at building zoom, and a point with no mapped road is reported as such rather than given an invented one.
- ~~No automated test suite or CI.~~ 56 Vitest tests, an ESLint config, and a GitHub Actions workflow running typecheck, lint, test and build. `npm run verify` runs the same three checks locally.
- ~~The database is recreated from scratch on every boot.~~ Migrations are applied once and recorded in `schema_migrations`. `database/schema.sql` is now regenerated from the live database and verified against it; `database/migrations/*.sql` remains authoritative.
