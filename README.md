# C - TheResolve 🇮🇳

**AI-powered civic infrastructure reporting for Indian municipalities.**

C - TheResolve is a mobile-first Progressive Web App that lets citizens report localized hazards (potholes, open manholes, sewage overflow, garbage dumps, dark streetlights, burst water pipes) with a photo and voice note in their own language. Google Gemini AI analyzes severity, the system deduplicates reports within 25 meters, and a transparent priority formula surfaces what matters most to department staff and city administrators.

**Live demo:** https://c-theresolve.onrender.com

---

## Key Features

- **Voice-First Reporting** — Citizens report hazards in 8 Indian languages (Hindi, Tamil, Telugu, Kannada, Bengali, Marathi, Gujarati, English) via photo + voice note. No app install needed.

- **AI Severity Scoring** — Google Gemini multimodal vision API analyzes photos to score structural severity (1.0–5.0), detects spam, and transcribes/translates voice notes automatically.

- **Smart Deduplication** — Reports within 25 meters are merged using PostGIS geospatial queries, eliminating duplicate municipal work orders.

- **Transparent Prioritization** — Priority = (AI Severity × 0.35) + (Report Volume × 0.30) + (Citizen Upvotes × 0.20) + (SLA Urgency × 0.15). Every ranking is explainable.

- **Real RBAC** — Three role-gated personas (Citizen, Department Staff, City Admin) with server-side enforcement. A Water Supply staff member cannot touch a Roads ticket.

- **Works Everywhere** — Mobile-first PWA optimized for low-end Android. Photos auto-compress to 1280px WebP; EXIF GPS is validated against reported location.

- **Multi-State Ready** — Live across 13 Andhra Pradesh districts with seed data across 5 Indian states. Department structures are generic and data-driven, so onboarding a new state is a configuration change.

---

## Getting Started

### Local Development (5 min)

```bash
# Install & run dev server
npm install
npm run dev
```

Open **http://localhost:3000** in your browser.

**Demo accounts:**
- Citizen: Use any 10-digit phone number; demo OTP is shown on screen.
- Staff: `water@city.gov` / `demo1234` (Water Supply department)
- Staff: `roads@city.gov` / `demo1234` (Public Works department)
- Admin: `admin@city.gov` / `admin1234` (City Admin)

Try signing in as Water and opening a Roads ticket — you'll get a hard `403`. Real RBAC, enforced server-side.

### With Database & Storage (10 min)

For a full local environment with persistent storage:

```bash
docker compose up -d
```

This starts:
- App on **http://localhost:3010**
- PostgreSQL 16 + PostGIS on **port 5455**
- MinIO S3-compatible object storage on **port 9010** (console at **:9011**, login: `minioadmin` / `miniopassword`)

### Live Deployment

The app is deployed on **Render** at https://c-theresolve.onrender.com and auto-deploys on every push to `main`.

To deploy your own:
1. Create a [Render](https://render.com) account
2. Connect your GitHub repo
3. Create a Web Service, point it to this repo
4. Render auto-detects the Dockerfile and deploys

---

## Configuration

### Environment Variables

```bash
# Required for production
CIVRES_JWT_SECRET=<random-40-char-string>  # Session signing key
SESSION_COOKIE_SECURE=true                  # Set to 'false' for HTTP-only LAN deployments

# Optional: Live Gemini AI (falls back to heuristic engine if unset)
GEMINI_API_KEY=<your-key>                   # Get free from https://aistudio.google.com

# Optional: Firebase Auth (falls back to demo OTP if unset)
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY=...

# Optional: Real-time open data (falls back to curated baseline if unset)
DATA_GOV_IN_API_KEY=...
DATA_GOV_IN_PCA_RESOURCE=...

# Optional: S3-compatible object storage for photos (falls back to inline data URLs if unset)
S3_ENDPOINT=https://your-s3-provider.com
S3_BUCKET=civic-photos
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

---

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Next.js 14, React 18, Tailwind CSS | Mobile-first PWA with role-based UI |
| **Backend** | Next.js API Routes, Node.js | Stateless server with JWT auth |
| **Database** | PostgreSQL 16 + PostGIS | Persistent issue storage + geospatial queries |
| **AI** | Google Gemini Multimodal Vision | Photo analysis, severity scoring, transcription |
| **Maps** | OpenStreetMap + Leaflet | Issue location visualization |
| **Storage** | S3-compatible (MinIO/AWS) | Citizen photos and proof-of-work images |
| **Auth** | Firebase Auth (optional) | Multi-provider sign-in; falls back to OTP |

### Key Code Paths

- **Frontend PWA:** [`src/app/page.tsx`](src/app/page.tsx)
- **Gemini AI Integration:** [`src/lib/gemini.ts`](src/lib/gemini.ts)
- **Priority Scoring:** [`src/lib/demand.ts`](src/lib/demand.ts)
- **Spatial Deduplication:** [`src/lib/postgresStore.ts`](src/lib/postgresStore.ts) (SQL) + [`src/lib/spatial.ts`](src/lib/spatial.ts) (in-memory fallback)
- **Admin Portal:** [`src/components/AdminPortal.tsx`](src/components/AdminPortal.tsx)
- **Database Schema:** [`database/migrations/`](database/migrations) (authoritative)
- **CI/CD:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (typecheck, lint, test, build)

---

## Testing & Quality

```bash
# Typecheck
npm run typecheck

# Lint
npm run lint

# Unit tests (56 tests across spatial, workflow, demand, geocoding)
npm run test

# All checks together (runs in CI on every push)
npm run verify
```

Tests focus on critical data paths where silent regressions impact most: spatial deduplication, workflow state machines, priority scoring, geocoding.

---

## Limitations & Roadmap

**Current Scope:**
- Live across 13 Andhra Pradesh districts + seed data in 4 other states
- 8 Indian languages supported
- Mobile-first; desktop admin portal exists but not optimized
- Offline fallback to heuristic engine (no crashes even without Gemini API or database)

**To Extend:**
- **Multi-state:** Expand geographic seed data in `src/lib/seedIssues.ts`
- **Real-time open data:** Configure `DATA_GOV_IN_*` env vars to fuse data.gov.in census data
- **Payment gateway:** Integrate for citizen donations toward fixes
- **SMS integration:** Send status updates via SMS instead of in-app notifications
- **Offline-first mobile app:** Build React Native version for airplane mode

---

## Support & Contributing

**Found a bug?**  
Open an issue on GitHub with a description and steps to reproduce.

**Want to contribute?**  
Fork the repo, create a branch, and send a pull request. All PRs run through CI (typecheck, lint, test, build) automatically.

**Questions about deployment or configuration?**  
Check the environment variables section above or open an issue.

---

## License

MIT License — see LICENSE file for details.

---

## Why This Matters

India's municipalities handle millions of civic complaints annually, but fragmented reporting channels, duplicate tickets, and no prioritization mean critical hazards — open manholes, burst water mains, road craters — go unresolved for weeks. Citizens have no visibility into whether their report was even received.

C - TheResolve closes that gap: one transparent, multilingual channel from street to action. Duplicate complaints collapse automatically. Severity is scored objectively. Staff see exactly what to fix and why. Citizens track their own reports. The result: faster fixes, optimized budgets, and a visible civic system that citizens actually trust.

---

**Deployed and ready to serve.** 🚀
