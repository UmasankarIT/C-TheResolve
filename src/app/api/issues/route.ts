import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { Issue } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * The issue feed is intentionally public and unauthenticated, so reporter
 * identity must not travel with it. citizenUserId is a phone-linked pseudonymous
 * handle and citizenName is a real name, and together they pin a person to a
 * street address -- so both are stripped here.
 *
 * A citizen's own reports are served by /api/citizen/my-reports, which scopes by
 * the authenticated session instead of shipping every reporter to every caller.
 * Staff still see reporter identity via the admin endpoints.
 */
function toPublicIssue(issue: Issue): Omit<Issue, 'citizenUserId' | 'citizenName'> {
  const { citizenUserId: _userId, citizenName: _name, ...rest } = issue;
  return rest;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const categoryId = searchParams.get('categoryId');
    const status = searchParams.get('status');
    const department = searchParams.get('department');
    const search = searchParams.get('search')?.toLowerCase();

    let issues = await civicStore.getIssues();
    const categories = await civicStore.getCategories();

    if (categoryId && categoryId !== 'all') {
      issues = issues.filter((i) => i.categoryId === categoryId || i.category.code === categoryId);
    }

    if (status && status !== 'all') {
      issues = issues.filter((i) => i.status === status);
    }

    if (department && department !== 'all') {
      issues = issues.filter((i) => i.category.responsibleDepartment.toLowerCase().includes(department.toLowerCase()));
    }

    if (search) {
      issues = issues.filter(
        (i) =>
          i.title.toLowerCase().includes(search) ||
          i.description.toLowerCase().includes(search) ||
          i.formattedAddress.toLowerCase().includes(search)
      );
    }

    return NextResponse.json({
      issues: issues.map(toPublicIssue),
      categories,
      totalCount: issues.length,
    });
  } catch (error: unknown) {
    console.error('Error querying issues:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error querying issues.' },
      { status: 500 }
    );
  }
}
