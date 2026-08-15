import { useMemo, useState } from 'react';
import type { MyPick } from '../lib/api';
import type { FriendlyError } from '../lib/error-handler';

type Filter = 'all' | 'pending' | 'graded';

/**
 * Three outcomes, not two.
 *
 * A voided pick (cancelled game) has null points *and* a gradedAt stamp — it is
 * settled but scored neither way. Splitting only on "points is null" would file
 * every voided pick under Pending and leave a patron waiting for a result that
 * is never coming.
 */
export function pickState(pick: MyPick): 'pending' | 'graded' | 'void' {
  if (pick.gradedAt === null) {
    return 'pending';
  }
  return pick.correct === null ? 'void' : 'graded';
}

function outcomeLabel(pick: MyPick): string {
  switch (pickState(pick)) {
    case 'pending':
      return 'Pending';
    case 'void':
      return 'Void';
    default:
      return pick.correct === true ? 'Won' : 'Lost';
  }
}

export interface MyPicksProps {
  picks: MyPick[];
  loading: boolean;
  error: FriendlyError | null;
}

export function MyPicks({ picks, loading, error }: MyPicksProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(() => {
    if (filter === 'all') {
      return picks;
    }
    if (filter === 'pending') {
      return picks.filter((pick) => pickState(pick) === 'pending');
    }
    return picks.filter((pick) => pickState(pick) !== 'pending');
  }, [picks, filter]);

  const total = useMemo(
    () => picks.reduce((sum, pick) => sum + (pick.points ?? 0), 0),
    [picks],
  );

  if (loading && picks.length === 0) {
    return <p className="state" role="status">Loading your picks…</p>;
  }

  if (error !== null && picks.length === 0) {
    return (
      <p className="state state--error" role="alert">
        {error.message}
      </p>
    );
  }

  if (picks.length === 0) {
    return <p className="state">No picks yet. Choose a game to get started.</p>;
  }

  return (
    <div className="page">
      <p className="total">
        {total} {total === 1 ? 'point' : 'points'} from {picks.length}{' '}
        {picks.length === 1 ? 'pick' : 'picks'}
      </p>

      <div className="tabs" role="tablist" aria-label="Filter picks">
        {(['all', 'pending', 'graded'] as const).map((id) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={filter === id}
            className={`tab${filter === id ? ' tab--active' : ''}`}
            onClick={() => {
              setFilter(id);
            }}
          >
            {id === 'all' ? 'All' : id === 'pending' ? 'Pending' : 'Graded'}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="state">Nothing here yet.</p>
      ) : (
        <table className="table">
          <caption className="visually-hidden">Your picks</caption>
          <thead>
            <tr>
              <th scope="col">Game</th>
              <th scope="col">Your pick</th>
              <th scope="col">Result</th>
              <th scope="col">Pts</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((pick) => {
              const state = pickState(pick);
              return (
                <tr key={pick.pickId} className={`row row--${state}`}>
                  <td>
                    <span className="matchup">
                      {pick.homeTeam} v {pick.awayTeam}
                    </span>
                  </td>
                  <td>{pick.predictedWinner === 'home' ? pick.homeTeam : pick.awayTeam}</td>
                  <td>{outcomeLabel(pick)}</td>
                  <td className="numeric">{pick.points ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
