export type TabId = 'games' | 'picks' | 'leaderboard';

const TABS: { id: TabId; label: string; glyph: string }[] = [
  { id: 'games', label: 'Games', glyph: '🏈' },
  { id: 'picks', label: 'My picks', glyph: '✓' },
  { id: 'leaderboard', label: 'Leaderboard', glyph: '🏆' },
];

export interface BottomNavProps {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`bottom-nav__item${active === tab.id ? ' bottom-nav__item--active' : ''}`}
          aria-current={active === tab.id ? 'page' : undefined}
          onClick={() => {
            onChange(tab.id);
          }}
        >
          <span className="bottom-nav__glyph" aria-hidden="true">
            {tab.glyph}
          </span>
          <span className="bottom-nav__label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
