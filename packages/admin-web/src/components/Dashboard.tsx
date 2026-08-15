import { useAdminStore, type Section } from '../lib/store';
import { Toasts } from './Toasts';
import { Stats } from './Stats';
import { Settings } from '../pages/Settings';
import { DevicePairing } from '../pages/DevicePairing';
import { Players } from '../pages/Players';
import { PicksInspector } from '../pages/PicksInspector';
import { DeviceStatusPage } from '../pages/DeviceStatus';

const NAV: { id: Section; label: string }[] = [
  { id: 'stats', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
  { id: 'pairing', label: 'Device pairing' },
  { id: 'devices', label: 'Device status' },
  { id: 'players', label: 'Players' },
  { id: 'picks', label: 'Picks inspector' },
];

export function Dashboard() {
  const session = useAdminStore((state) => state.session);
  const section = useAdminStore((state) => state.section);
  const setSection = useAdminStore((state) => state.setSection);
  const signOut = useAdminStore((state) => state.signOut);

  if (session === null) {
    return null;
  }

  return (
    <div className="shell">
      <header className="shell__header">
        <span className="shell__brand">FanBoard Admin</span>
        <span className="shell__venue" title={session.venueId}>
          {session.name}
        </span>
        <button className="button button--ghost shell__logout" type="button" onClick={signOut}>
          Log out
        </button>
      </header>

      <div className="shell__body">
        <nav className="sidebar" aria-label="Sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`sidebar__item${section === item.id ? ' sidebar__item--active' : ''}`}
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => {
                setSection(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <main className="content">
          {section === 'stats' && <Stats venueId={session.venueId} />}
          {section === 'settings' && <Settings venueId={session.venueId} />}
          {section === 'pairing' && <DevicePairing venueId={session.venueId} />}
          {section === 'devices' && <DeviceStatusPage venueId={session.venueId} />}
          {section === 'players' && <Players venueId={session.venueId} />}
          {section === 'picks' && <PicksInspector venueId={session.venueId} />}
        </main>
      </div>

      <Toasts />
    </div>
  );
}
