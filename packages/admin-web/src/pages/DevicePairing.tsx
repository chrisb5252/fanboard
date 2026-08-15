import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { fetchDeviceStatus, pairDevice, type DeviceStatus, type PairedDevice } from '../lib/api';
import { toAdminError } from '../lib/api-error';
import { useAdminStore } from '../lib/store';
import { DeviceList } from '../components/DeviceList';

/**
 * Pair a display, then show its key exactly once.
 *
 * The server stores only a SHA-256 hash of the key, so this response is the one
 * and only time it exists in readable form — there is no endpoint that can
 * return it again. That is why it is never written to storage here, and why
 * leaving the page discards it: a copy kept anywhere else would quietly become
 * a second place the credential lives.
 */
export function DevicePairing({ venueId }: { venueId: string }) {
  const pushToast = useAdminStore((state) => state.pushToast);

  const [displayName, setDisplayName] = useState('');
  const [fireTvDeviceId, setFireTvDeviceId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<PairedDevice | null>(null);
  const [copied, setCopied] = useState(false);

  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);

  const loadDevices = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const list = await fetchDeviceStatus(venueId, signal);
      setDevices(list);
    } catch {
      // The list is secondary to pairing; a failure here is reported by the
      // device status page rather than blocking this form.
    } finally {
      setLoadingDevices(false);
    }
  }, [venueId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDevices(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadDevices]);

  async function handlePair(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }

    setSubmitting(true);
    setCopied(false);
    try {
      const device = await pairDevice(venueId, displayName.trim(), fireTvDeviceId.trim());
      setIssued(device);
      setDisplayName('');
      setFireTvDeviceId('');
      pushToast('Device paired successfully', 'ok');
      await loadDevices();
    } catch (caught) {
      pushToast(toAdminError(caught).message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  async function copyKey(): Promise<void> {
    if (issued === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(issued.displayKey);
      setCopied(true);
    } catch {
      // Clipboard blocked (insecure origin, or permission denied). The key is
      // on screen and selectable, so this is a convenience, not the only path.
      pushToast('Could not copy — select the key and copy it manually.', 'error');
    }
  }

  return (
    <section className="page">
      <h1 className="page__title">Device pairing</h1>

      <form className="card" onSubmit={(event) => void handlePair(event)} noValidate>
        <h2 className="card__title">Pair a new display</h2>

        <label className="label" htmlFor="display-name">
          Display name
        </label>
        <input
          id="display-name"
          className="input"
          value={displayName}
          disabled={submitting}
          placeholder="Front Bar TV"
          maxLength={64}
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
        />

        <label className="label" htmlFor="firetv-id">
          Fire TV device ID
        </label>
        <input
          id="firetv-id"
          className="input"
          value={fireTvDeviceId}
          disabled={submitting}
          placeholder="G070VM1234567890"
          maxLength={128}
          onChange={(event) => {
            setFireTvDeviceId(event.target.value);
          }}
        />
        <p className="hint">
          On the Fire TV: Settings → My Fire TV → About → Device. One display per device ID
          per venue.
        </p>

        <button className="button button--primary" type="submit" disabled={submitting}>
          {submitting ? 'Pairing…' : 'Pair device'}
        </button>
      </form>

      {issued !== null && (
        <div className="card card--key" role="alert">
          <h2 className="card__title">Save this display key now</h2>
          <p className="hint hint--warn">
            This is the only time it can be shown. The server keeps a hash, not the key — if it
            is lost, the display has to be paired again.
          </p>

          <code className="keybox">{issued.displayKey}</code>

          <div className="row">
            <button className="button button--primary" type="button" onClick={() => void copyKey()}>
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                setIssued(null);
                setCopied(false);
              }}
            >
              I&rsquo;ve saved it
            </button>
          </div>

          <p className="hint">
            Enter it on <strong>{issued.displayName}</strong> as the display key, along with device
            ID <code>{issued.deviceId}</code>.
          </p>
        </div>
      )}

      <div className="card">
        <h2 className="card__title">Paired displays</h2>
        {loadingDevices ? (
          <p className="state" role="status">Loading displays…</p>
        ) : (
          <DeviceList devices={devices} />
        )}
      </div>
    </section>
  );
}
