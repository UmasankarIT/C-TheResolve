import { Category, Issue, IssueStatus, MLAnalysis, ProofOfWork, ReportIntent } from './types';
import { INITIAL_CATEGORIES } from './categories';
import { departmentForCategory } from './departments';
import { calculatePriorityScore } from './scoring';

export interface SeedCity {
  city: string;
  state: string;
  district: string;
  lat: number;
  lng: number;
  wardCode: string;
  wardName: string;
}

// Deep-coverage pilot: one entry per district for all 13 Andhra Pradesh
// districts, anchored on the district headquarters. This is the unit a state
// government would actually pilot C - TheResolve in — a whole state, not a
// sample. Coordinates are HQ points and `wardName` is a representative
// locality, not the official AP ward/delimitation list.
//
// The additional states below are a deliberate contrast: several districts each,
// not full coverage. The point of including them is to exercise the multi-state
// machinery — the indexed `state` column, cross-state demand rollups, and the
// national summary's state ranking — which a single-state dataset can never
// demonstrate. Claiming exhaustive coverage for these would mean listing 31
// Karnataka and 33 Telangana districts, most of them with no realistic
// coordinates worth seeding. Andhra Pradesh is the reference pilot; these show
// the platform generalises.
export const SEED_CITIES: SeedCity[] = [
  { city: 'Anantapur', state: 'Andhra Pradesh', district: 'Anantapur', lat: 14.6819, lng: 77.6006, wardCode: 'ATP', wardName: 'Court Road' },
  { city: 'Tirupati', state: 'Andhra Pradesh', district: 'Tirupati', lat: 13.6288, lng: 79.4192, wardCode: 'TPT', wardName: 'Sarakalavari' },
  { city: 'Rajahmundry', state: 'Andhra Pradesh', district: 'East Godavari', lat: 17.0005, lng: 81.804, wardCode: 'EGD', wardName: 'Gowri Nagar' },
  { city: 'Guntur', state: 'Andhra Pradesh', district: 'Guntur', lat: 16.3067, lng: 80.4365, wardCode: 'GNT', wardName: 'Brodru' },
  { city: 'Machilipatnam', state: 'Andhra Pradesh', district: 'Krishna', lat: 16.1902, lng: 81.0948, wardCode: 'KRN', wardName: 'Gandhi Nagar' },
  { city: 'Kurnool', state: 'Andhra Pradesh', district: 'Kurnool', lat: 15.8281, lng: 78.0373, wardCode: 'KNL', wardName: 'Main Road' },
  { city: 'Vijayawada', state: 'Andhra Pradesh', district: 'NTR', lat: 16.5062, lng: 80.648, wardCode: 'NTR', wardName: 'Benz Circle' },
  { city: 'Ongole', state: 'Andhra Pradesh', district: 'Prakasam', lat: 15.5053, lng: 80.0949, wardCode: 'PKM', wardName: 'Gandhi Nagar' },
  { city: 'Nellore', state: 'Andhra Pradesh', district: 'Sri Potti Sriramulu Nellore', lat: 14.4426, lng: 79.9865, wardCode: 'NLR', wardName: 'Venkateswara Nagar' },
  { city: 'Srikakulam', state: 'Andhra Pradesh', district: 'Sri Srikakulam', lat: 18.3349, lng: 83.9025, wardCode: 'SKM', wardName: 'Pedda Junction' },
  { city: 'Visakhapatnam', state: 'Andhra Pradesh', district: 'Visakhapatnam', lat: 17.6868, lng: 83.2185, wardCode: 'VZM', wardName: 'MVP Colony' },
  { city: 'Vizianagaram', state: 'Andhra Pradesh', district: 'Vizianagaram', lat: 18.1132, lng: 83.5977, wardCode: 'VZN', wardName: 'Fort Area' },
  { city: 'Kadapa', state: 'Andhra Pradesh', district: 'YSR Kadapa', lat: 14.4674, lng: 78.8241, wardCode: 'KDP', wardName: 'YSR Statue' },

  // --- Karnataka ---
  { city: 'Bengaluru', state: 'Karnataka', district: 'Bengaluru Urban', lat: 12.9716, lng: 77.5946, wardCode: 'BLR', wardName: 'Koramangala' },
  { city: 'Mysuru', state: 'Karnataka', district: 'Mysuru', lat: 12.2958, lng: 76.6394, wardCode: 'MYS', wardName: 'Gandhi Bazaar' },
  { city: 'Hubballi', state: 'Karnataka', district: 'Dharwad', lat: 15.3647, lng: 75.124, wardCode: 'DHW', wardName: 'Market Yard' },
  { city: 'Mangaluru', state: 'Karnataka', district: 'Dakshina Kannada', lat: 12.9141, lng: 74.856, wardCode: 'DKD', wardName: 'Bendorewell' },

  // --- Telangana ---
  { city: 'Hyderabad', state: 'Telangana', district: 'Hyderabad', lat: 17.385, lng: 78.4867, wardCode: 'HYD', wardName: 'Banjara Hills' },
  { city: 'Warangal', state: 'Telangana', district: 'Warangal', lat: 17.9689, lng: 79.5941, wardCode: 'WGL', wardName: 'Kakatiya Nagar' },
  { city: 'Nizamabad', state: 'Telangana', district: 'Nizamabad', lat: 18.6725, lng: 78.094, wardCode: 'NZB', wardName: 'Vasantha Nagar' },

  // --- Maharashtra ---
  { city: 'Mumbai', state: 'Maharashtra', district: 'Mumbai Suburban', lat: 19.076, lng: 72.8777, wardCode: 'MUM', wardName: 'Andheri West' },
  { city: 'Pune', state: 'Maharashtra', district: 'Pune', lat: 18.5204, lng: 73.8567, wardCode: 'PNQ', wardName: 'Kothrud' },
  { city: 'Nagpur', state: 'Maharashtra', district: 'Nagpur', lat: 21.1458, lng: 79.0882, wardCode: 'NAG', wardName: 'Dharampeth' },

  // --- National Capital Territory (union territory, single district) ---
  { city: 'New Delhi', state: 'Delhi', district: 'New Delhi', lat: 28.6139, lng: 77.209, wardCode: 'DEL', wardName: 'Connaught Place' },
];

interface CategoryProfile {
  categoryId: string;
  titles: string[];
  hazards: string[];
  baseSeverity: number;
  weight: number;
  tint: string;
}

const CATEGORY_PROFILES: CategoryProfile[] = [
  {
    categoryId: 'cat-road-pothole',
    titles: [
      'Deep crater on the main road surface',
      'Road surface crumbled after monsoon digging',
      'Unmarked pothole chain near the junction',
      'Broken asphalt patch causing wheel damage',
    ],
    hazards: ['wheel_damage_risk', 'two_wheeler_skid_danger', 'traffic_bottleneck'],
    baseSeverity: 3.8,
    weight: 30,
    tint: '#334155',
  },
  {
    categoryId: 'cat-drainage-overflow',
    titles: [
      'Open manhole with sewage spilling on the road',
      'Storm drain blocked, waterlogging across the lane',
      'Raw sewage overflow near the residential entrance',
      'Broken storm gutter dumping water onto the footpath',
    ],
    hazards: ['biohazard_contamination', 'open_manhole_risk', 'pedestrian_submersion'],
    baseSeverity: 4.2,
    weight: 22,
    tint: '#0f766e',
  },
  {
    categoryId: 'cat-water-burst',
    titles: [
      'Clean water pipeline burst flooding the corridor',
      'Running water pipeline leaking continuously',
      'Mainline water leak gushing under the footpath',
      'Pipeline burst with water running into the road',
    ],
    hazards: ['potable_water_wastage', 'foundation_erosion', 'subsurface_cavity'],
    baseSeverity: 4.6,
    weight: 14,
    tint: '#1d4ed8',
  },
  {
    categoryId: 'cat-garbage-dump',
    titles: [
      'Illegal garbage dump blocking the road edge',
      'Community bin overflowing with mixed waste',
      'Debris pile dumped on the pedestrian walkway',
      'Municipal waste heap with stray animals around it',
    ],
    hazards: ['pest_vector_breeding', 'foul_odor_spread', 'sidewalk_blockage'],
    baseSeverity: 3.1,
    weight: 16,
    tint: '#a16207',
  },
  {
    categoryId: 'cat-streetlight-outage',
    titles: [
      'Streetlight dead for over two weeks',
      'Entire stretch unlit creating a dark spot',
      'Streetlight pole with dangling live wiring',
      'Night-time dark patch near the bus stop',
    ],
    hazards: ['pedestrian_safety_risk', 'crime_hotspot_blindspot', 'exposed_wiring'],
    baseSeverity: 2.8,
    weight: 12,
    tint: '#7c2d12',
  },
  {
    categoryId: 'cat-others',
    titles: [
      'Broken public handrail beside the footpath',
      'Fallen tree blocking the pedestrian path',
      'Damaged public bench and unsegregated waste nearby',
    ],
    hazards: ['general_civic_concern', 'requires_department_review'],
    baseSeverity: 2.5,
    weight: 6,
    tint: '#4b5563',
  },
];

const CITIZEN_FIRST = [
  'Anitha', 'Ravi', 'Meera', 'Suresh', 'Kavya', 'Imran', 'Deepa', 'Rohit',
  'Farida', 'Sanjay', 'Nikhil', 'Priya', 'Arjun', 'Lakshmi', 'Vikram', 'Sneha',
  'Rahul', 'Pooja', 'Manoj', 'Kiran', 'Aditya', 'Shreya', 'Ganesh', 'Rekha',
];

const CITIZEN_LAST = [
  'Reddy', 'Sharma', 'Naidu', 'Patel', 'Iyer', 'Khan', 'Menon', 'Das',
  'Pillai', 'Rathore', 'Yadav', 'Kulkarni', 'Bose', 'Chowdhury', 'Gowda', 'Joshi',
];

const WORKERS: Record<string, string[]> = {
  DEPT_PWD: ['K. Srinivas', 'M. Bharathi', 'R. Prasad'],
  DEPT_DRAINAGE: ['S. Fakir', 'A. Joseph', 'N. Ramesh'],
  DEPT_WATER: ['T. Anil', 'P. Suresh', 'V. Kumar'],
  DEPT_WASTE: ['B. Lakshmi', 'D. Naik', 'H. Suresh'],
  DEPT_ELECTRICITY: ['J. Thomas', 'L. Prasad', 'C. Rao'],
  DEPT_UNASSIGNED: ['City Triage Desk'],
};

const RESOLUTION_NOTES: Record<string, string> = {
  'cat-road-pothole': 'Cold-patch repair completed and compacted; carriageway resurfaced to level.',
  'cat-drainage-overflow': 'Manhole resealed with heavy-duty cover, gutter desilted and cleared of debris.',
  'cat-water-burst': 'Pipeline section replaced, joint re-coupled and pressure tested; no leakage observed.',
  'cat-garbage-dump': 'Waste lifted by tipper truck, spot mechanised-swept and sealed with barricades.',
  'cat-streetlight-outage': 'Faulty ballast and lamp replaced, feeder energised and night inspection done.',
  'cat-others': 'Site attended and the obstruction removed with a follow-up inspection logged.',
};

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, list: T[]): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

function pickWeighted(rand: () => number, profiles: CategoryProfile[]): CategoryProfile {
  const total = profiles.reduce((acc, p) => acc + p.weight, 0);
  let roll = rand() * total;
  for (const profile of profiles) {
    roll -= profile.weight;
    if (roll <= 0) return profile;
  }
  return profiles[profiles.length - 1];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function placeholderImage(label: string, tint: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">` +
    `<rect width="320" height="240" fill="${tint}"/>` +
    `<rect x="8" y="8" width="304" height="224" fill="none" stroke="#ffffff" stroke-opacity="0.25" stroke-width="2"/>` +
    `<text x="160" y="118" font-family="Segoe UI,Arial,sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">${label}</text>` +
    `<text x="160" y="150" font-family="Segoe UI,Arial,sans-serif" font-size="13" fill="#ffffff" fill-opacity="0.72" text-anchor="middle">C - TheResolve sample grievance</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function categoryById(id: string): Category {
  const found = INITIAL_CATEGORIES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown seed category: ${id}`);
  return found;
}

function pickStatus(rand: () => number): IssueStatus {
  const roll = rand();
  if (roll < 0.22) return 'reported';
  if (roll < 0.42) return 'in_review';
  if (roll < 0.52) return 'verified';
  if (roll < 0.72) return 'assigned';
  if (roll < 0.87) return 'in_progress';
  return 'resolved';
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

export function buildSeedIssues(seed = 20260925): Issue[] {
  const rand = mulberry32(seed);
  const issues: Issue[] = [];
  let seq = 0;

  const emit = (
    city: SeedCity,
    profile: CategoryProfile,
    lat: number,
    lng: number,
    wardNum: number,
    ageHours: number,
    overrides?: {
      intent?: ReportIntent;
      title?: string;
      description?: string;
      status?: IssueStatus;
    }
  ): void => {
    seq += 1;
    const category = categoryById(profile.categoryId);
    const department = departmentForCategory(category);
    const status = overrides?.status ?? pickStatus(rand);
    const createdAt = hoursAgo(ageHours);
    const severity = Number(
      Math.min(5, Math.max(1.2, profile.baseSeverity + (rand() - 0.5) * 1.1)).toFixed(1)
    );
    const reportCount = 1 + Math.floor(rand() * rand() * 9);
    const communityUpvotes = Math.floor(rand() * reportCount * 5);
    const citizenName = `${pick(rand, CITIZEN_FIRST)} ${pick(rand, CITIZEN_LAST)}`;
    const wardId = `${city.wardCode}-${String(wardNum).padStart(3, '0')}`;
    const title = overrides?.title ?? `${pick(rand, profile.titles)} at ${city.wardName}`;
    const priorityScore = calculatePriorityScore({
      mlSeverity: severity,
      reportCount,
      communityUpvotes,
      createdAt,
    }).totalScore;

    const mlAnalysis: MLAnalysis = {
      predictedCategory: category.code,
      categoryConfidence: Number((0.72 + rand() * 0.25).toFixed(2)),
      estimatedSeverity: severity,
      isCivicIssue: true,
      detectedHazards: profile.hazards,
      inferenceLatencyMs: 320 + Math.floor(rand() * 1500),
    };

    const issue: Issue = {
      id: `seed-${slugify(city.city)}-${String(seq).padStart(4, '0')}`,
      categoryId: category.id,
      category,
      intent: overrides?.intent ?? 'complaint',
      title,
      description:
        overrides?.description ??
        `${title}. Reported by residents of ${city.wardName}, ${city.district}. Repeated complaints from the same stretch have not received a response within the published SLA.`,
      latitude: Number(lat.toFixed(6)),
      longitude: Number(lng.toFixed(6)),
      formattedAddress: `${city.wardName}, ${city.district}, ${city.state}`,
      wardId,
      locationDetails: {
        state: city.state,
        district: city.district,
        mandal: city.wardName,
      },
      // Set directly rather than relying on the migration backfill: seeds are
      // deleted and re-inserted on refresh, which runs after migrations, so a
      // backfill alone would be discarded every time the dataset is rebuilt.
      state: city.state,
      jurisdictionCode: city.wardName,
      status,
      citizenUserId: `usr-seed-${slugify(city.city)}-${seq}`,
      citizenName,
      reportCount,
      communityUpvotes,
      mlSeverityScore: severity,
      priorityScore,
      imageUrl: placeholderImage(category.name, profile.tint),
      mlAnalysis,
      createdAt,
      updatedAt: hoursAgo(Math.max(0, ageHours - rand() * 36)),
    };

    if (status === 'verified' || status === 'assigned' || status === 'in_progress' || status === 'resolved') {
      issue.departmentId = department.id;
      issue.assignedDepartment = department.name;
      issue.verifiedAt = hoursAgo(Math.max(0, ageHours - rand() * 12));
      issue.slaDeadlineAt = new Date(
        new Date(createdAt).getTime() + department.slaHours * 3600 * 1000
      ).toISOString();
    }

    if (status === 'assigned' || status === 'in_progress' || status === 'resolved') {
      const crew = WORKERS[department.id] || WORKERS.DEPT_UNASSIGNED;
      issue.assignedWorkerName = pick(rand, crew);
    }

    if (status === 'resolved') {
      const resolutionHours = Math.max(1, ageHours * (0.3 + rand() * 0.4));
      const resolvedAt = hoursAgo(resolutionHours);
      issue.resolvedAt = resolvedAt;
      issue.updatedAt = resolvedAt;
      issue.resolutionNotes = RESOLUTION_NOTES[category.id];
      const proofUrl = placeholderImage('Proof of work', '#166534');
      issue.resolutionProofUrl = proofUrl;
      const proof: ProofOfWork = {
        id: `proof-${issue.id}`,
        issueId: issue.id,
        departmentId: department.id,
        submittedBy: issue.assignedWorkerName || 'Field Staff',
        photoUrl: proofUrl,
        latitude: issue.latitude,
        longitude: issue.longitude,
        notes: issue.resolutionNotes || 'Work completed and verified on site.',
        submittedAt: resolvedAt,
      };
      issue.proof = proof;
    }

    issues.push(issue);
  };

  SEED_CITIES.forEach((city, cityIdx) => {
    const clusterCount = 2 + Math.floor(rand() * 2);
    for (let c = 0; c < clusterCount; c++) {
      const angle = ((c / clusterCount) * Math.PI * 2) + (cityIdx % 5) * 0.35;
      const radius = 0.012 + c * 0.007;
      const centerLat = city.lat + Math.sin(angle) * radius;
      const centerLng = city.lng + Math.cos(angle) * radius;
      const clusterSize = 3 + Math.floor(rand() * 4);
      const clusterCategory = pickWeighted(rand, CATEGORY_PROFILES);
      for (let i = 0; i < clusterSize; i++) {
        const jitterLat = centerLat + (rand() - 0.5) * 0.0022;
        const jitterLng = centerLng + (rand() - 0.5) * 0.0022;
        const ageHours = 12 + Math.floor(rand() * rand() * 2100);
        emit(
          city,
          rand() < 0.72 ? clusterCategory : pickWeighted(rand, CATEGORY_PROFILES),
          jitterLat,
          jitterLng,
          100 + Math.floor(rand() * 240),
          ageHours
        );
      }
    }

    const scattered = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < scattered; i++) {
      const angle = rand() * Math.PI * 2;
      const radius = 0.045 + rand() * 0.03;
      emit(
        city,
        pickWeighted(rand, CATEGORY_PROFILES),
        city.lat + Math.sin(angle) * radius,
        city.lng + Math.cos(angle) * radius,
        300 + Math.floor(rand() * 150),
        24 + Math.floor(rand() * rand() * 2100)
      );
    }
  });

  // --- Development requests -------------------------------------------------
  // Handcrafted multi-member groups: several citizens in the same district
  // asking for infrastructure that does not exist yet (a pipeline, a canal, a
  // bus shelter). Each group shares a district and category, so Stage 1
  // buckets them together and the near-identical wording lets the embedding
  // pass merge them into one development demand — the seeded counterpart of
  // citizens independently filing the same request. Statuses are forced open:
  // the build scopes its corpus to open issues, so a request seeded as
  // resolved would never appear in the pipeline.
  const cityBy = (name: string): SeedCity => {
    const found = SEED_CITIES.find((c) => c.city === name);
    if (!found) throw new Error(`Unknown seed city: ${name}`);
    return found;
  };

  const DEV_REQUEST_SEEDS: Array<{
    city: string;
    categoryId: string;
    title: string;
    body: string;
    count: number;
    ageHours: number;
  }> = [
    {
      city: 'Visakhapatnam',
      categoryId: 'cat-water-burst',
      title: 'Water pipeline extension requested for the Bheemili coastal road',
      body: 'Residents request that the municipal water supply main be extended along this stretch, which still depends on tanker deliveries. A new pipeline is requested here.',
      count: 3,
      ageHours: 40,
    },
    {
      city: 'Visakhapatnam',
      categoryId: 'cat-others',
      title: 'Bus shelter requested on the Airport Road service lane',
      body: 'Commuters wait in the open at this stop with no shade or seating. A bus shelter is requested on the service lane here.',
      count: 2,
      ageHours: 70,
    },
    {
      city: 'Vijayawada',
      categoryId: 'cat-drainage-overflow',
      title: 'Stormwater drainage canal requested for the Gunadala low-lying belt',
      body: 'The belt floods every monsoon because there is no stormwater drain to carry the runoff away. A drainage canal is requested for this area.',
      count: 3,
      ageHours: 55,
    },
    {
      city: 'Tirupati',
      categoryId: 'cat-streetlight-outage',
      title: 'New streetlight connection requested on the Renigunta bypass footpath',
      body: 'The bypass footpath has no lighting at all after dark. New streetlight connections are requested along this stretch.',
      count: 3,
      ageHours: 90,
    },
    {
      city: 'Bengaluru',
      categoryId: 'cat-road-pothole',
      title: 'Service road construction requested on the Outer Ring approach',
      body: 'The approach stretch is an unpaved track with no kerb or footpath. A proper service road is requested for this stretch.',
      count: 2,
      ageHours: 120,
    },
    {
      city: 'Hyderabad',
      categoryId: 'cat-streetlight-outage',
      title: 'Streetlight poles requested for the Osmanagar service stretch',
      body: 'This stretch has no poles at all, so vehicles cross unlit at night. Streetlight poles are requested for the stretch here.',
      count: 2,
      ageHours: 150,
    },
  ];

  const DEV_OPEN_STATUSES: IssueStatus[] = ['reported', 'in_review', 'in_progress'];

  DEV_REQUEST_SEEDS.forEach((request, requestIdx) => {
    const city = cityBy(request.city);
    const profile =
      CATEGORY_PROFILES.find((p) => p.categoryId === request.categoryId) ??
      CATEGORY_PROFILES[CATEGORY_PROFILES.length - 1];
    for (let i = 0; i < request.count; i++) {
      const angle = (i / request.count) * Math.PI * 2;
      const radius = 0.006 + i * 0.004;
      emit(
        city,
        profile,
        city.lat + Math.sin(angle) * radius,
        city.lng + Math.cos(angle) * radius,
        500 + requestIdx * 10 + i,
        request.ageHours + i * 6,
        {
          intent: 'development_request',
          title: request.title,
          description: `${request.title}. ${request.body} Filed by residents of ${city.wardName}, ${city.district}.`,
          status: DEV_OPEN_STATUSES[i % DEV_OPEN_STATUSES.length],
        }
      );
    }
  });

  return issues;
}
