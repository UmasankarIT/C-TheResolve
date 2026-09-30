import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { calculateGeodesicDistanceMeters } from '@/lib/spatial';
import { reverseGeocode, formatAddress, type ReverseGeocodeResult } from '@/lib/geocoding';
import { calculatePriorityScore } from '@/lib/scoring';
import { analyzeReportPhoto } from '@/lib/gemini';
import { storeImageDataUrl } from '@/lib/objectStore';
import { CreateReportRequest, Issue, IssueReport, LocationDetails, MLAnalysis, ReportIntent } from '@/lib/types';
import { getSession, unauthorized } from '@/lib/auth';
import { departmentForCategory } from '@/lib/departments';
import { slaDeadlineFor } from '@/lib/workflow';
import { logAction, notifyUser } from '@/lib/events';
import { CITY_ADMIN_USER_ID } from '@/lib/auth';

export async function POST(req: NextRequest) {
  try {
    // RBAC: every report must come from a signed-in actor. Citizens report on
    // their own behalf; staff/admin may also surface issues they spot in field.
    const user = await getSession(req);
    if (!user) {
      return unauthorized('Sign in to submit a report.');
    }

    const body = (await req.json()) as CreateReportRequest;

    // A complaint is an existing problem (photo required); a development
    // request asks for something that does not exist yet — an empty plot or a
    // missing bus stop is exactly what the citizen wants to show, and often
    // there is no photo to take, so text (or voice) alone is accepted.
    const intent: ReportIntent =
      body.intent === 'development_request' ? 'development_request' : 'complaint';
    const photoRequired = intent === 'complaint';

    if (!body.categoryId || body.latitude === undefined || body.longitude === undefined || (photoRequired && !body.imageUrl)) {
      return NextResponse.json(
        {
          error: photoRequired
            ? 'Missing required parameters: categoryId, latitude, longitude, and imageUrl are required.'
            : 'Missing required parameters: categoryId, latitude, and longitude are required.',
        },
        { status: 400 }
      );
    }

    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return NextResponse.json(
        { error: 'Invalid coordinates. Confirm the location on the map and try again.' },
        { status: 400 }
      );
    }
    body.latitude = latitude;
    body.longitude = longitude;

    const category = await civicStore.getCategoryById(body.categoryId);
    if (!category) {
      return NextResponse.json({ error: 'Invalid category specified.' }, { status: 400 });
    }

    // Automatic department routing — ambiguous/OTHERS land in triage (DEPT_UNASSIGNED)
    const dept = departmentForCategory(category);

    // 1. Process EXIF metadata and detect any coordinate tampering/spoofing
    const exif = body.exif || { hasGps: false };
    if (exif.hasGps && exif.exifLatitude && exif.exifLongitude) {
      const delta = calculateGeodesicDistanceMeters(
        body.latitude,
        body.longitude,
        exif.exifLatitude,
        exif.exifLongitude
      );
      exif.deltaMeters = Math.round(delta * 10) / 10;
      // If photo GPS is more than 300m away from device reporting GPS, flag spoofing warning
      exif.isSpoofed = delta > 300;
    }

    // 2. Run the Computer Vision pipeline for categorization and severity.
    // Uses Google Gemini when GEMINI_API_KEY is configured (engine='gemini'),
    // else falls back to the deterministic keyword classifier.
    //
    // Skipped entirely when there is no photo: there is nothing to analyse, and
    // the heuristic classifier must not be asked to verdict an empty string.
    // The severity then comes from the category's own base weight — the same
    // fallback the novel-incident path already used when a photo analysed to 0.
    let mlAnalysis: MLAnalysis;
    if (body.imageUrl) {
      const photo = await analyzeReportPhoto(body.imageUrl, category.code, body.citizenNotes);
      mlAnalysis = photo.analysis;
      // The spam gate applies to complaints only. A development request
      // legitimately photographs a site where nothing exists yet — an empty
      // plot, a field without a road — and that is precisely what the vision
      // model was trained to flag as non-civic. Rejecting it would make the
      // photo-optional path impossible for its most natural use.
      if (!mlAnalysis.isCivicIssue && intent === 'complaint') {
        return NextResponse.json(
          {
            error: 'Uploaded image was flagged by ML as non-civic or spam.',
            mlAnalysis,
          },
          { status: 422 }
        );
      }
    } else {
      mlAnalysis = {
        predictedCategory: category.code,
        categoryConfidence: 1,
        estimatedSeverity: category.baseSeverityWeight * 2.5,
        isCivicIssue: true,
        detectedHazards: [],
        inferenceLatencyMs: 0,
      };
    }

    // Resolve the address server-side rather than trusting the client label.
    // The citizen's browser already reverse-geocodes for display, but that value
    // is optional, can be stale, and never reaches this handler for a report
    // filed without it. A geocoder outage must not block a report, so a failure
    // degrades to coordinates instead of rejecting the submission.
    let resolvedGeo: ReverseGeocodeResult | null = null;
    try {
      resolvedGeo = await reverseGeocode(body.latitude, body.longitude);
    } catch (err) {
      console.error('[Reports] Reverse geocode failed, using coordinate-only address:', err);
    }

    // Prefer the geocoder, fall back to whatever the client resolved.
    const locationDetails: LocationDetails = {
      state: resolvedGeo?.state ?? body.locationDetails?.state,
      district: resolvedGeo?.district ?? body.locationDetails?.district,
      mandal: resolvedGeo?.mandal ?? body.locationDetails?.mandal,
      pincode: resolvedGeo?.pincode ?? body.locationDetails?.pincode,
    };

    // The photo has now been analysed and accepted, so it is safe to move the
    // bytes out of the request and into object storage. Deliberately after the
    // ML gate: a rejected or spammy upload should not leave an orphan object
    // behind. Gemini already has what it needs from the in-memory data URL
    // above, so nothing here changes the AI path. A photo-less development
    // request stores an empty image URL rather than a placeholder URL that
    // would claim a picture exists.
    const storedImageUrl = body.imageUrl
      ? await storeImageDataUrl(String(body.imageUrl), 'issue')
      : '';

    // 3. Spatial dedup (25m threshold). The Postgres store answers this with an
    // indexed ST_DWithin query, so submission cost does not grow with the
    // size of the issues table. Scoped to the report's own intent: two
    // citizens asking for the same missing water line in the same spot must
    // aggregate, but a request must never attach to a pothole complaint
    // (or vice versa) just because they share coordinates and category.
    const match = await civicStore.findNearbyActiveIssue(
      body.latitude,
      body.longitude,
      category.id,
      25.0,
      intent
    );

    const reportId = `rep-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    if (match) {
      // --- DUPLICATE ACTIVE INCIDENT FOUND WITHIN 25M ---
      const existingIssue = match.issue;

      const report: IssueReport = {
        id: reportId,
        issueId: existingIssue.id,
        citizenUserId: user.userId,
        latitude: body.latitude,
        longitude: body.longitude,
        accuracyMeters: body.accuracyMeters || 10,
        isOnSite: body.isOnSite,
        imageUrl: storedImageUrl,
        citizenNotes: body.citizenNotes,
        transcript: body.transcript,
        exif,
        locationDetails,
        createdAt: new Date().toISOString(),
      };

      // Add report + recalculate priority atomically (single DB transaction)
      const updatedIssue = await civicStore.withTransaction(async () => {
        await civicStore.addReport(report);
        const updated = await civicStore.incrementIssueReport(existingIssue.id, report);
        await logAction(
          user,
          'reports.submit.duplicate',
          `Matched existing incident ${existingIssue.id} within ${match.distanceMeters}m.`,
          existingIssue.id
        );
        return updated;
      });

      return NextResponse.json({
        issueId: existingIssue.id,
        isDuplicate: true,
        intent,
        proximityDistanceMeters: match.distanceMeters,
        reportCount: updatedIssue ? updatedIssue.reportCount : existingIssue.reportCount + 1,
        status: existingIssue.status,
        priorityScore: updatedIssue ? updatedIssue.priorityScore : existingIssue.priorityScore,
        mlAnalysis,
        message: `Linked to existing active incident (${match.distanceMeters}m away). Priority rank escalated to ${updatedIssue?.priorityScore}.`,
      });
    }

    // --- NOVEL CIVIC INCIDENT ---
    const issueId = `iss-${Date.now()}`;
    const initialSeverity = mlAnalysis.estimatedSeverity || category.baseSeverityWeight * 2.5;

    const priorityBreakdown = calculatePriorityScore({
      mlSeverity: initialSeverity,
      reportCount: 1,
      communityUpvotes: 0,
      createdAt: new Date(),
    });

    const newReport: IssueReport = {
      id: reportId,
      issueId,
      citizenUserId: user.userId,
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters: body.accuracyMeters || 10,
      isOnSite: body.isOnSite,
      imageUrl: storedImageUrl,
      citizenNotes: body.citizenNotes,
      transcript: body.transcript,
      exif,
      locationDetails,
      createdAt: new Date().toISOString(),
    };

    const newIssue: Issue = {
      id: issueId,
      categoryId: category.id,
      category,
      intent,
      title:
        body.title ||
        (intent === 'development_request'
          ? `${category.name} Development Request`
          : `${category.name} Reported`),
      description:
        body.citizenNotes ||
        (intent === 'development_request'
          ? `Citizen requested new ${category.name.toLowerCase()} infrastructure requiring municipal attention.`
          : `Citizen reported ${category.name.toLowerCase()} requiring municipal attention.`),
      latitude: body.latitude,
      longitude: body.longitude,
      formattedAddress: formatAddress(
        resolvedGeo,
        body.latitude,
        body.longitude
      ),
      locationDetails,
      departmentId: dept.id,
      jurisdictionCode: locationDetails.mandal || locationDetails.pincode,
      state: locationDetails.state,
      citizenUserId: user.userId,
      citizenName: user.name,
      slaDeadlineAt: slaDeadlineFor(dept.slaHours),
      transcript: body.transcript,
      status: 'reported',
      reportCount: 1,
      communityUpvotes: 0,
      mlSeverityScore: initialSeverity,
      priorityScore: priorityBreakdown.totalScore,
      imageUrl: storedImageUrl,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reports: [newReport],
      mlAnalysis,
    };

    // Persist issue + first report + audit + admin ping in one transaction
    await civicStore.withTransaction(async () => {
      await civicStore.addIssue(newIssue);
      await civicStore.addReport(newReport);
      await logAction(user, 'reports.submit', `${category.name} routed to ${dept.name}.`, issueId);
      await notifyUser(
        CITY_ADMIN_USER_ID,
        'New report in triage',
        `${category.name} near ${newIssue.formattedAddress} — routed to ${dept.name}.`,
        issueId
      );
    });

    return NextResponse.json({
      issueId,
      isDuplicate: false,
      intent,
      reportCount: 1,
      status: 'reported',
      departmentId: dept.id,
      priorityScore: priorityBreakdown.totalScore,
      mlAnalysis,
      message: `New incident logged and routed to ${dept.name}.`,
    });
  } catch (error: unknown) {
    console.error('Error submitting report:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error processing report.' },
      { status: 500 }
    );
  }
}
