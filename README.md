# CivicResolve (सिविक रिज़ॉल्व) 🇮🇳
### AI-Powered Community Infrastructure Intelligence & Rapid Municipal Redressal

Built for the **Google AI Challenge / Hackathon**, **CivicResolve** is a production-grade, responsive Progressive Web Application (PWA) that empowers citizens across India to report localized civic infrastructure failures (potholes, open manholes, sewage overflow, garbage dumps, dark streetlights, and burst water pipes).

---

## 🏆 Hackathon Evaluation Criteria Alignment (100%)

| Weight | Criteria | CivicResolve Implementation |
| :---: | :--- | :--- |
| **25%** | **AI / Technical Execution** | **Google Gemini Multimodal Vision API** (`gemini-3.5-flash`, with runtime fallback across the model catalog so a retired model name cannot break a live demo) analyzes civic damage photos, evaluates structural severity (1.0 to 5.0), detects spam/non-civic uploads, and recommends civil remediation. Voice notes are transcribed and translated by the same API. |
| **20%** | **Depth & Reach Across India** | **Seeded pilot across all 13 Andhra Pradesh districts**, so state, district and category demand rollups are exercised on real geography rather than one city. **8 Indian languages** (Hindi, Tamil, Telugu, Kannada, Bengali, Marathi, Gujarati, English) + **Voice-First reporting** via Web Speech API so rural/semi-urban citizens can report issues naturally in their mother tongue. Department structures are generic, so onboarding another state is a seed-data change. |
| **20%** | **Problem-Solution Fit** | **25 m spatial deduplication** stops duplicate ticket flood. Locations are stored as PostGIS `GEOGRAPHY(Point, 4326)`; the proximity match runs geodesically in the app. Automatically recalculates dynamic priority: $\text{Priority} = (\text{ML\_Severity} \times 0.35) + (\log_{10}(\text{Reports}+1) \times 0.30) + (\text{Upvotes} \times 0.20) + (\text{SLA\_Decay} \times 0.15)$. |
| **20%** | **Deployability & Scalability** | **Mobile-First PWA**: No app store install barriers. Works on low-end Android smartphones: the browser resizes every upload to a 1280px WebP before it is sent, and EXIF GPS is checked against the reported position. Citizen photos and proof-of-work images live in S3-compatible object storage, so Postgres holds only a reference. Includes Municipal Officer Command Portal. |
| **15%** | **Impact Potential** | Eliminates duplicate municipal work orders, optimizes road maintenance budget dispatch, and prioritizes fatal open manholes and road craters within 24h SLA. |

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

---

## 📂 Architecture & Key Code

- **Frontend PWA & UI:** [`src/app/page.tsx`](src/app/page.tsx)
- **Google Gemini Multimodal Vision & Speech Service:** [`src/lib/gemini.ts`](src/lib/gemini.ts)
- **Dynamic Prioritization Algorithm:** [`src/lib/scoring.ts`](src/lib/scoring.ts)
- **Spatial Deduplication Engine:** [`src/lib/spatial.ts`](src/lib/spatial.ts)
- **Object Storage (citizen photos / proof images):** [`src/lib/objectStore.ts`](src/lib/objectStore.ts)
- **Image Streaming Route:** [`src/app/api/images/[...key]/route.ts`](src/app/api/images/%5B...key%5D/route.ts)
- **Postgres/PostGIS Persistence Layer:** [`src/lib/postgresStore.ts`](src/lib/postgresStore.ts)
- **Migrations (authoritative schema):** [`database/migrations/`](database/migrations)
- **Multilingual Indian Languages (8 Langs):** [`src/lib/languages.ts`](src/lib/languages.ts)
- **Andhra Pradesh 13-district seed data:** [`src/lib/seedIssues.ts`](src/lib/seedIssues.ts)
- **Demand & Hotspot Intelligence:** [`src/lib/demand.ts`](src/lib/demand.ts)
- **data.gov.in Public-Data Fusion:** [`src/lib/publicData.ts`](src/lib/publicData.ts)
- **Municipal Command Console (admin):** [`src/components/AdminPortal.tsx`](src/components/AdminPortal.tsx)

> `database/schema.sql` is kept as an original design reference. The schema the app actually creates and queries is `database/migrations/*.sql`, which the store applies in filename order on boot.

---

## ⚠️ Known Limitations

Documented deliberately rather than papered over, so the current state is auditable:

- **data.gov.in fusion is config-gated.** The transport is implemented and fails soft, but it stays dormant until `DATA_GOV_IN_API_KEY` and `DATA_GOV_IN_PCA_RESOURCE` are set. Without them the demand engine runs on a curated contextual baseline. It also defaults to Andhra Pradesh only, so the "national" rollup is not yet exercised across states.
- **Spatial deduplication runs in the application, not in SQL.** Coordinates *are* stored as PostGIS `GEOGRAPHY(Point, 4326)`, but the 25 m proximity match is a geodesic loop over the fetched issue set rather than an indexed `ST_DWithin` query. That is fine at pilot volume and is the next thing to change for national volume.
- **Street-level addresses are synthetic.** `generateMockAddress()` derives a plausible-sounding street name from a hash of the coordinates, so `formattedAddress` is decorative. The administrative context shown to citizens (state / district / mandal / PIN) *is* real, resolved live through Nominatim.
- **Voice recordings are not retained.** Only the Gemini-generated transcript is persisted, matching the published privacy policy. Staff see the text, never playback.
- **Session cookies require HTTPS outside localhost.** The production cookie carries the `Secure` flag, so a plain-HTTP LAN or IP deployment will not keep a session.
- **No automated test suite or CI yet.** `tsc --noEmit` and `next build` are clean, and every change so far has been verified against a live container, but nothing is asserted in code.
- **`cloudrun.yaml` is an unedited template.** The image is still the `gcr.io/YOUR_PROJECT_ID/...` placeholder and no managed PostGIS instance is provisioned.
