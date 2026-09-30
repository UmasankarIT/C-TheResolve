/**
 * C - TheResolve Prioritization Scoring Engine
 * Computes dynamic urgency rank based on multi-factor weighted inputs:
 * 
 * Priority = (ML_Severity * 0.35) + (log10(Report_Count + 1) * 0.30) 
 *          + (Community_Upvotes * 0.20) + (Urgency_Decay_Factor * 0.15)
 */

export interface PriorityParameters {
  mlSeverity: number;          // 1.0 to 5.0
  reportCount: number;         // Count of aggregated citizen reports (>= 1)
  communityUpvotes: number;    // "I also faced this" endorsements (>= 0)
  createdAt: string | Date;    // Timestamp when issue was first reported
}

export interface PriorityBreakdown {
  totalScore: number;
  components: {
    mlSeverityContribution: number;
    reportCountContribution: number;
    upvotesContribution: number;
    urgencyDecayContribution: number;
  };
  urgencyLevel: 'low' | 'medium' | 'high' | 'critical';
}

export function calculatePriorityScore(params: PriorityParameters): PriorityBreakdown {
  const { mlSeverity, reportCount, communityUpvotes, createdAt } = params;

  // 1. ML Severity Component (Scale 1.0 - 5.0) -> Max 1.75
  const clampedSeverity = Math.min(Math.max(mlSeverity || 2.5, 1.0), 5.0);
  const mlSeverityContribution = clampedSeverity * 0.35;

  // 2. Report Count Component -> Logarithmic damping: log10(N + 1) * 0.30
  // e.g. 1 report -> 0.09, 5 reports -> 0.23, 20 reports -> 0.39, 100 reports -> 0.60
  const normalizedReportCount = Math.max(reportCount || 1, 1);
  const logReports = Math.log10(normalizedReportCount + 1);
  const reportCountContribution = logReports * 0.30;

  // 3. Upvotes Component -> Soft cap at 25 upvotes (contributes up to 1.0)
  const normalizedUpvotes = Math.min((communityUpvotes || 0) * 0.2, 5.0);
  const upvotesContribution = normalizedUpvotes * 0.20;

  // 4. Urgency Decay Factor -> Days elapsed since creation
  // Unresolved issues age and gradually increase in urgency (0.5 pts per day, capped at 5.0)
  const createdTime = typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt.getTime();
  const elapsedDays = Math.max(0, (Date.now() - createdTime) / (1000 * 60 * 60 * 24));
  const ageFactor = Math.min(elapsedDays * 0.5, 5.0);
  const urgencyDecayContribution = ageFactor * 0.15;

  // Total Priority Score (typically spans 1.0 to 4.5+)
  const rawTotal =
    mlSeverityContribution +
    reportCountContribution +
    upvotesContribution +
    urgencyDecayContribution;

  const totalScore = Number(rawTotal.toFixed(2));

  // Determine urgency tier
  let urgencyLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
  if (totalScore >= 3.2) urgencyLevel = 'critical';
  else if (totalScore >= 2.4) urgencyLevel = 'high';
  else if (totalScore >= 1.6) urgencyLevel = 'medium';

  return {
    totalScore,
    components: {
      mlSeverityContribution: Number(mlSeverityContribution.toFixed(2)),
      reportCountContribution: Number(reportCountContribution.toFixed(2)),
      upvotesContribution: Number(upvotesContribution.toFixed(2)),
      urgencyDecayContribution: Number(urgencyDecayContribution.toFixed(2)),
    },
    urgencyLevel,
  };
}
