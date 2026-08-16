import { NextResponse } from 'next/server';
import { AUDIT_ACTIONS, auditLog } from '../../../../../../../../lib/audit';
import { adminMiddleware, assertVenueScope } from '../../../../../../../../lib/auth';
import { ApiError, toErrorBody } from '../../../../../../../../lib/errors';
import { computeLeaderboard } from '../../../../../../../../lib/leaderboard';
import { logger as rootLogger } from '../../../../../../../../lib/logger';
import {
  parseJsonBody,
  validateOptionalUuid,
  validateVenueId,
} from '../../../../../../../../lib/validators';
import { gradeGameManually, type ManualOutcome } from '../../../../../../../../services/ops';

export const dynamic = 'force-dynamic';

const log = rootLogger.child({ route: '/api/admin/venues/[venueId]/games/[gameId]/grade' });
const requireAdmin = adminMiddleware();

const WINNERS = ['home', 'away', 'draw'] as const;
const MAX_SCORE = 999;

/**
 * Validates the operator-supplied result.
 *
 * Strict on purpose. This writes to the same columns the automatic path does,
 * and the database CHECK that a settled game must have a winner would turn a
 * typo into a constraint violation and a 500. Rejecting it here means the
 * operator gets a sentence telling them what to fix.
 */
function parseOutcome(body: Record<string, unknown>): ManualOutcome {
  const status = body['status'];

  if (status === 'cancelled') {
    // Voids every pick on the game: neither a win nor a loss for anybody.
    return { status: 'cancelled' };
  }

  if (status !== 'final') {
    throw ApiError.badRequest("status must be 'final' or 'cancelled'", { field: 'status' });
  }

  const winner = body['winner'];
  if (typeof winner !== 'string' || !(WINNERS as readonly string[]).includes(winner)) {
    throw ApiError.badRequest("winner must be 'home', 'away' or 'draw' for a final game", {
      field: 'winner',
    });
  }

  const score = (value: unknown, field: string): number | undefined => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_SCORE) {
      throw ApiError.badRequest(`${field} must be a whole number between 0 and ${MAX_SCORE}`, {
        field,
      });
    }
    return value;
  };

  const homeScore = score(body['homeScore'], 'homeScore');
  const awayScore = score(body['awayScore'], 'awayScore');

  return {
    status: 'final',
    winner: winner as 'home' | 'away' | 'draw',
    ...(homeScore === undefined ? {} : { homeScore }),
    ...(awayScore === undefined ? {} : { awayScore }),
  };
}

/**
 * Settles a game the provider never reported.
 *
 * Runs the real grading worker against a one-game provider built from the
 * supplied result, so the manual path and the automatic path cannot drift —
 * see services/ops.ts.
 *
 * Refuses an already-settled game with `alreadyGraded: true` rather than
 * restating history. To correct a wrong result, void the affected picks: that
 * leaves a trail, and silently rewriting a settled game does not.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ venueId: string; gameId: string }> },
): Promise<NextResponse> {
  try {
    const { venueId: rawVenueId, gameId: rawGameId } = await params;
    const venueId = validateVenueId(rawVenueId);
    const gameId = validateOptionalUuid('gameId', rawGameId);
    if (gameId === undefined) {
      return NextResponse.json(
        { error: { code: 'invalid_request', message: 'gameId must be a UUID' } },
        { status: 400 },
      );
    }

    const admin = await requireAdmin(request);
    assertVenueScope(admin, venueId);

    const body = await parseJsonBody(request);
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (reason === '' || reason.length > 500) {
      return NextResponse.json(
        {
          error: {
            code: 'invalid_request',
            message: 'A reason of 1-500 characters is required',
            details: { field: 'reason' },
          },
        },
        { status: 400 },
      );
    }

    const outcome = parseOutcome(body);
    const result = await gradeGameManually(venueId, gameId, outcome);

    await auditLog(AUDIT_ACTIONS.gameGradedManually, undefined, venueId, {
      gameId,
      outcome,
      reason,
      picksGraded: result.picksGraded,
      alreadyGraded: result.alreadyGraded,
    });

    // Rebuild the board straight away rather than waiting out the five minute
    // worker: an operator settling a game by hand is doing it because a room
    // is looking at a screen that is wrong.
    if (result.gamesGraded > 0 || result.gamesVoided > 0) {
      await computeLeaderboard(venueId, 'all_time');
    }

    return NextResponse.json(result, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorBody(error, log);
    return NextResponse.json(body, { status });
  }
}
