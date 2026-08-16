import type { MyPick } from '@/lib/types';
import { formatKickoff } from '@/lib/stats';

/**
 * The player's own picks, newest first.
 *
 * Three states have to be distinguishable at a glance, and two of them look
 * alike in the data: a voided pick has `gradedAt` set like a graded one, but
 * `correct` is null. Showing it as a loss would be wrong — a cancelled game is
 * neither.
 */
export function MyPicksList({ picks }: { picks: readonly MyPick[] }) {
  if (picks.length === 0) {
    return (
      <p className="rounded-xl border border-dark-700 bg-dark-800 p-8 text-center text-dark-400">
        No picks yet. Head to Games and make your first one!
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {picks.map((pick) => {
        const team = pick.predictedWinner === 'home' ? pick.homeTeam : pick.awayTeam;
        const voided = pick.gradedAt !== null && pick.correct === null;

        return (
          <li key={pick.pickId} className="rounded-xl border border-dark-700 bg-dark-800 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-bold">
                  {pick.homeTeam} vs {pick.awayTeam}
                </div>
                <div className="text-sm text-dark-400">
                  You picked {team} · {formatKickoff(pick.scheduledAt)}
                </div>
              </div>

              <div className="shrink-0 text-right">
                {pick.gradedAt === null && (
                  <span className="font-bold text-accent-amber">⏳ Pending</span>
                )}
                {voided && <span className="font-bold text-dark-400">Void</span>}
                {pick.correct === true && (
                  <span className="font-bold text-accent-green">+{pick.points ?? 10} pts</span>
                )}
                {pick.correct === false && <span className="font-bold text-dark-400">0 pts</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
