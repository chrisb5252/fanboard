import { useState, type FormEvent } from 'react';
import { joinVenue } from '../lib/api';
import { toFriendlyError } from '../lib/error-handler';

/**
 * Mirrors the server's rules so a bad nickname is caught before a round trip.
 *
 * The server is still the authority — these numbers exist to give instant
 * feedback, not to be trusted. They track validateNickname in the backend: 2-30
 * characters, letters/numbers/spaces and a few joiners.
 */
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 30;

const ALLOWED = /^[\p{L}\p{N} '._-]+$/u;
const RESERVED = /\b(?:admin|administrator|moderator|system|root|staff|fanboard)\b/iu;
const ONLY_DIGITS = /^\d+$/u;
const DIGIT_RUN = /\d{5,}/u;
const REPEATED = /(.)\1{5,}/u;

export function validateNicknameLocally(raw: string): string | null {
  const value = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();

  if (value.length < NICKNAME_MIN) {
    return `Use at least ${NICKNAME_MIN} characters.`;
  }
  if (value.length > NICKNAME_MAX) {
    return `Keep it to ${NICKNAME_MAX} characters or fewer.`;
  }
  if (!ALLOWED.test(value)) {
    return 'Letters, numbers, spaces and . _ - only.';
  }
  if (ONLY_DIGITS.test(value)) {
    return 'Add some letters, not just numbers.';
  }
  if (DIGIT_RUN.test(value)) {
    return 'That is a lot of digits in a row. Try something shorter.';
  }
  if (REPEATED.test(value)) {
    return 'Too many repeated characters.';
  }
  if (RESERVED.test(value)) {
    return 'That name is reserved. Pick another.';
  }
  return null;
}

export interface NicknameModalProps {
  venueId: string;
  onJoined: (player: { playerId: string; nickname: string }) => void;
  onCancel: () => void;
}

export function NicknameModal({ venueId, onJoined, onCancel }: NicknameModalProps) {
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const localProblem = validateNicknameLocally(nickname);
    if (localProblem !== null) {
      setError(localProblem);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const player = await joinVenue(venueId, nickname.trim());
      onJoined(player);
    } catch (caught) {
      setError(toFriendlyError(caught).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="join-title">
      <div className="modal">
        <h2 className="title" id="join-title">
          Pick a nickname
        </h2>
        <p className="lede">This is how you appear on the big screen.</p>

        <form className="stack" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <label className="label" htmlFor="nickname">
            Nickname
          </label>
          <input
            id="nickname"
            className="input"
            type="text"
            autoComplete="nickname"
            maxLength={NICKNAME_MAX}
            value={nickname}
            disabled={submitting}
            onChange={(event) => {
              setNickname(event.target.value);
              setError(null);
            }}
            aria-invalid={error !== null}
            aria-describedby={error === null ? 'nickname-hint' : 'nickname-error'}
          />
          <p className="hint" id="nickname-hint">
            {nickname.trim().length}/{NICKNAME_MAX}
          </p>
          {error !== null && (
            <p className="error" id="nickname-error" role="alert">
              {error}
            </p>
          )}

          <button className="button button--primary" type="submit" disabled={submitting}>
            {submitting ? 'Joining…' : 'Join'}
          </button>
          <button
            className="button button--ghost"
            type="button"
            onClick={onCancel}
            disabled={submitting}
          >
            Use a different venue
          </button>
        </form>
      </div>
    </div>
  );
}
