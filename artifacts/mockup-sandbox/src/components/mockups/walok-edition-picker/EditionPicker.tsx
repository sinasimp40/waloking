import { ChevronRight, Gamepad2, Play, X } from 'lucide-react';
import './_group.css';

const editions = [
  { kind: 'Base game', name: 'NBA Showdown', detail: 'Default installation', variation: false },
  { kind: 'Variation', name: 'qeqweqwe', detail: 'Custom launch setup', variation: true },
];

export function EditionPicker() {
  return (
    <main className="walok-picker-stage">
      <section className="walok-modal" aria-label="Redesigned WALOK edition picker">
        <div style={{ height: 2, background: 'linear-gradient(90deg, transparent, #ff6a00 30%, #ffc4a1 50%, #ff6a00 70%, transparent)' }} />
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 18px 16px' }}>
          <div className="walok-game-mark"><Gamepad2 size={21} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="walok-title-font" style={{ margin: 0, color: '#ff7a28', fontSize: 13, fontWeight: 700 }}>NBA Showdown</p>
            <p style={{ margin: '4px 0 0', color: 'rgba(255,255,255,.45)', fontSize: 12, fontWeight: 600, letterSpacing: '.05em' }}>Choose an edition to launch</p>
          </div>
          <button type="button" aria-label="Close picker" style={{ border: 0, background: 'transparent', padding: 5, color: 'rgba(255,255,255,.34)' }}><X size={16} /></button>
        </header>
        <div style={{ margin: '0 18px', height: 1, background: 'linear-gradient(90deg, #ff6a0040, rgba(255,255,255,.08), transparent)' }} />
        <div style={{ padding: '12px 12px 10px', display: 'grid', gap: 7 }}>
          {editions.map((edition) => (
            <button className="walok-option" type="button" key={edition.name}>
              <span className="walok-play"><Play size={13} fill="currentColor" /></span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span className={`walok-option-tag${edition.variation ? ' walok-option-tag--variation' : ''}`}>{edition.kind}</span>
                <span className="walok-option-title">{edition.name}</span>
                <span className="walok-meta">{edition.detail}</span>
              </span>
              <ChevronRight className="walok-chevron" size={17} />
            </button>
          ))}
        </div>
        <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 18px', padding: '13px 0 15px', borderTop: '1px solid rgba(255,255,255,.06)' }}>
          <span style={{ color: 'rgba(255,255,255,.29)', fontSize: 11, letterSpacing: '.07em', textTransform: 'uppercase' }}>2 editions available</span>
          <span style={{ color: '#ff7a28', fontSize: 11, fontWeight: 700 }}>Select to play</span>
        </footer>
      </section>
    </main>
  );
}