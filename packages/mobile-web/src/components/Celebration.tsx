import { useEffect, useState } from 'react';

/**
 * Confetti for a win, and nothing else.
 *
 * Three rules this follows, because a celebration that ignores them stops being
 * a reward and becomes an obstacle:
 *
 *  - It never blocks input. `pointer-events: none` throughout, so a player can
 *    keep picking straight through it.
 *  - It respects prefers-reduced-motion by not rendering at all. Not a shorter
 *    animation — none. The banner still appears, so the news is not lost.
 *  - It clears itself. No confetti outlives its timer, even if the parent
 *    forgets to unmount it.
 *
 * Pieces are plain divs rather than a canvas: two dozen elements animating on
 * transform and opacity stay on the compositor, and the Fire TV lesson applies
 * to cheap phones too.
 */

const PIECE_COUNT = 24;
const DURATION_MS = 2200;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface CelebrationProps {
  /** Changes to a new value each time something is worth celebrating. */
  trigger: string | null;
  message?: string;
}

export function Celebration({ trigger, message = 'Nice call! +10' }: CelebrationProps) {
  const [showing, setShowing] = useState<string | null>(null);

  useEffect(() => {
    if (trigger === null) {
      return;
    }
    setShowing(trigger);
    const timer = setTimeout(() => setShowing(null), DURATION_MS);
    return () => clearTimeout(timer);
  }, [trigger]);

  if (showing === null) {
    return null;
  }

  const reduced = prefersReducedMotion();

  return (
    <div className="celebrate" aria-hidden="true">
      {!reduced &&
        Array.from({ length: PIECE_COUNT }, (_, i) => (
          <span
            key={`${showing}-${i}`}
            className="celebrate__piece"
            style={{
              // Deterministic spread from the index rather than Math.random, so
              // the same win looks the same on a re-render.
              left: `${(i * 97) % 100}%`,
              animationDelay: `${(i % 6) * 90}ms`,
              background: i % 3 === 0 ? 'var(--warn)' : i % 3 === 1 ? 'var(--accent)' : '#f1f5f9',
            }}
          />
        ))}
      <p className="celebrate__banner" role="status">
        {message}
      </p>
    </div>
  );
}
