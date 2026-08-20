import { ChevronRight, Gamepad2, Play, X } from 'lucide-react';
import './_group.css';

export function Current() {
  return (
    <main className="walok-picker-stage">
      <section className="walok-modal" aria-label="Current WALOK variation picker">
        <div style={{ height: 1, background: 'linear-gradient(90deg, transparent, #ff6a00, transparent)', opacity: 0.55 }} />
        <header style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 17px 14px' }}>
          <div className="walok-game-mark"><Gamepad2 size={21} /></div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="walok-title-font" style={{ margin: 0, color: '#ff741c', fontSize: 13, fontWeight: 700 }}>NBA Showdown</p>
            <p style={{ margin: '3px 0 0', color: 'rgba(255,255,255,.3)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }}>Select action</p>
          </div>
          <X size={15} color="rgba(255,255,255,.28)" />
        </header>
        <div style={{ height: 1, margin: '0 14px', background: 'linear-gradient(90deg, transparent, rgba(255,255,255,.09), transparent)' }} />
        <div style={{ padding: '9px 10px', display: 'grid', gap: 2 }}>
          {['NBA Showdown', 'qeqweqwe'].map((name) => (
            <button className="walok-option" type="button" key={name}>
              <span className="walok-play"><Play size={13} fill="currentColor" /></span>
              <span className="walok-option-title">{name}</span>
              <ChevronRight className="walok-chevron" size={15} />
            </button>
          ))}
        </div>
        <footer style={{ margin: '0 14px', padding: '12px 0 13px', borderTop: '1px solid rgba(255,255,255,.05)', color: 'rgba(255,255,255,.17)', fontSize: 10, letterSpacing: '.1em', textAlign: 'center', textTransform: 'uppercase' }}>2 launch options</footer>
      </section>
    </main>
  );
}