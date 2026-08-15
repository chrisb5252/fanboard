import { useEffect, useState } from 'react';
import { LEAGUES, LEAGUE_LABELS, fetchConfig, saveConfig, type League } from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { useAdminStore } from '../lib/store';

export function Settings({ venueId }: { venueId: string }) {
  const pushToast = useAdminStore((state) => state.pushToast);
  const setSession = useAdminStore((state) => state.setSession);
  const session = useAdminStore((state) => state.session);

  const [selected, setSelected] = useState<Set<League>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const config = await fetchConfig(venueId);
        if (!cancelled) {
          setSelected(new Set(config.enabledLeagues));
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(toAdminError(caught).message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  function toggle(league: League): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(league)) {
        next.delete(league);
      } else {
        next.add(league);
      }
      return next;
    });
  }

  async function handleSave(): Promise<void> {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      // Sent in whitelist order so the stored value is canonical; the server
      // canonicalises too, but matching it keeps the audit diff clean.
      const chosen = LEAGUES.filter((league) => selected.has(league));
      const saved = await saveConfig(venueId, [...chosen]);
      setSelected(new Set(saved.enabledLeagues));
      if (session !== null) {
        setSession({ ...session, enabledLeagues: saved.enabledLeagues });
      }
      pushToast('Settings saved', 'ok');
    } catch (caught) {
      pushToast(toAdminError(caught).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="state" role="status">Loading settings…</p>;
  }

  return (
    <section className="page">
      <h1 className="page__title">Settings</h1>
      <p className="page__lede">Choose which leagues this venue shows.</p>

      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <fieldset className="card">
        <legend className="card__title">Enabled leagues</legend>
        <div className="checks">
          {LEAGUES.map((league) => (
            <label className="check" key={league}>
              <input
                type="checkbox"
                checked={selected.has(league)}
                disabled={saving}
                onChange={() => {
                  toggle(league);
                }}
              />
              <span>{LEAGUE_LABELS[league]}</span>
            </label>
          ))}
        </div>

        {selected.size === 0 && (
          <p className="hint">
            With nothing selected this venue ingests every league — that is the current default,
            not a broken state.
          </p>
        )}

        {/*
          Worth saying plainly: nothing consumes this yet. poll-games already
          accepts a league filter, but it is not wired to venue config, so
          saving here changes stored settings and not what appears on the TV.
        */}
        <p className="hint hint--warn">
          Not yet applied to ingestion — the poller still fetches every league.
        </p>

        <button
          className="button button--primary"
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </fieldset>
    </section>
  );
}
