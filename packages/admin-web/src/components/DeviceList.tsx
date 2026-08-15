import type { DeviceStatus } from '../lib/api';

export function formatWhen(iso: string | null): string {
  if (iso === null) {
    return 'Never';
  }
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return 'Unknown';
  }

  const minutes = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) {
    return 'Just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return at.toLocaleString();
}

export interface DeviceListProps {
  devices: DeviceStatus[];
  onPreview?: ((device: DeviceStatus) => void) | undefined;
}

export function DeviceList({ devices, onPreview }: DeviceListProps) {
  if (devices.length === 0) {
    return <p className="state">No displays paired yet.</p>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Display</th>
            <th scope="col">Status</th>
            <th scope="col">Last seen</th>
            <th scope="col">Fire TV device ID</th>
            {onPreview !== undefined && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {devices.map((device) => (
            <tr key={device.deviceId}>
              <td>{device.displayName}</td>
              <td>
                <span className={`badge ${device.online ? 'badge--online' : 'badge--offline'}`}>
                  {device.online ? '◉ Online' : '◯ Offline'}
                </span>
              </td>
              <td>{formatWhen(device.lastHeartbeat)}</td>
              <td className="mono">{device.fireTvDeviceId ?? '—'}</td>
              {onPreview !== undefined && (
                <td>
                  <button
                    className="button button--small"
                    type="button"
                    onClick={() => {
                      onPreview(device);
                    }}
                  >
                    View display
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
