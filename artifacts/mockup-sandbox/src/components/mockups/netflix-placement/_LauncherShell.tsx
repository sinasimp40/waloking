import { Search, Settings, User, Gamepad2, Trophy, Star, Clock, Download, Wifi, Volume2, Tv, Music, Globe, Plus } from "lucide-react";
import "./_group.css";

const ART = {
  fc26: "linear-gradient(135deg,#0a3d2e,#1a8a5c)",
  cod: "linear-gradient(135deg,#1a1a1a,#3d3d3d)",
  fortnite: "linear-gradient(135deg,#5d1a8a,#a83dd9)",
  valorant: "linear-gradient(135deg,#8a1a1a,#d93d3d)",
  gta: "linear-gradient(135deg,#1a3d8a,#3d7dd9)",
  mc: "linear-gradient(135deg,#3d8a1a,#7dd93d)",
  efootball: "linear-gradient(135deg,#0a4d8a,#1a7dd9)",
  apex: "linear-gradient(135deg,#8a3d0a,#d97d1a)",
  rocket: "linear-gradient(135deg,#1a5d8a,#3da8d9)",
  forza: "linear-gradient(135deg,#1a1a3d,#3d3d8a)",
  csgo: "linear-gradient(135deg,#5d4d1a,#d9b53d)",
  league: "linear-gradient(135deg,#0a1a3d,#1a3d7d)",
};

export function TitleBar() {
  return (
    <div className="flex items-center justify-between px-4 h-9" style={{ background: "#06060a", borderBottom: "1px solid var(--line)" }}>
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded" style={{ background: "linear-gradient(135deg,#ff7a18,#ffb547)" }} />
        <span className="text-xs font-bold tracking-wider" style={{ color: "var(--text)" }}>NEXTREME GAMING HUB</span>
      </div>
      <div className="flex items-center gap-1">
        <button className="px-2 h-6 text-xs hover:bg-white/10 rounded">—</button>
        <button className="px-2 h-6 text-xs hover:bg-white/10 rounded">▢</button>
        <button className="px-2 h-6 text-xs hover:bg-red-500/30 rounded">×</button>
      </div>
    </div>
  );
}

export function SidebarBase({ topSlot, bottomSlot }: { topSlot?: React.ReactNode; bottomSlot?: React.ReactNode }) {
  return (
    <aside className="flex flex-col gap-1 p-3 nf-scroll overflow-y-auto" style={{ width: 220, background: "var(--bg-1)", borderRight: "1px solid var(--line)" }}>
      {topSlot}
      <div className="text-[10px] uppercase tracking-widest mt-2 mb-1 px-2" style={{ color: "var(--muted)" }}>Library</div>
      {[
        { icon: Gamepad2, label: "All Games", active: true },
        { icon: Star, label: "Favorites" },
        { icon: Clock, label: "Recently Played" },
        { icon: Trophy, label: "Top Apps" },
        { icon: Download, label: "Downloads" },
      ].map(({ icon: Icon, label, active }) => (
        <button key={label} className="flex items-center gap-3 px-3 h-9 rounded-md text-sm" style={{ background: active ? "var(--bg-3)" : "transparent", color: active ? "var(--text)" : "var(--muted)" }}>
          <Icon size={16} />
          <span>{label}</span>
        </button>
      ))}
      <div className="text-[10px] uppercase tracking-widest mt-3 mb-1 px-2" style={{ color: "var(--muted)" }}>Categories</div>
      {["Action", "Sports", "Racing", "Shooter", "Strategy"].map((c) => (
        <button key={c} className="flex items-center gap-3 px-3 h-8 rounded-md text-xs" style={{ color: "var(--muted)" }}>
          <span className="w-1 h-1 rounded-full" style={{ background: "var(--muted)" }} />
          <span>{c}</span>
        </button>
      ))}
      <div className="flex-1" />
      {bottomSlot}
    </aside>
  );
}

export function Header({ rightSlot }: { rightSlot?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between px-6 h-14" style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--line)" }}>
      <div className="flex items-center gap-4 flex-1 max-w-md">
        <div className="flex items-center gap-2 px-3 h-9 rounded-md flex-1" style={{ background: "var(--bg-2)", border: "1px solid var(--line)" }}>
          <Search size={14} style={{ color: "var(--muted)" }} />
          <input placeholder="Search games…" className="bg-transparent outline-none text-sm flex-1" style={{ color: "var(--text)" }} readOnly />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "var(--bg-3)", color: "var(--muted)" }}>⌘K</kbd>
        </div>
      </div>
      {rightSlot}
      <div className="flex items-center gap-2 ml-3">
        <button className="w-9 h-9 rounded-md flex items-center justify-center hover:bg-white/5"><Settings size={16} style={{ color: "var(--muted)" }} /></button>
        <button className="w-9 h-9 rounded-md flex items-center justify-center" style={{ background: "var(--bg-3)" }}><User size={16} /></button>
      </div>
    </header>
  );
}

export function FeaturedBanner({ override }: { override?: React.ReactNode }) {
  if (override) return <>{override}</>;
  return (
    <div className="relative mx-6 mt-4 rounded-xl overflow-hidden" style={{ height: 220, background: "linear-gradient(110deg,#0a3d2e 0%,#1a8a5c 50%,#0a3d2e 100%)", border: "1px solid var(--line)" }}>
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at right,transparent 30%,rgba(0,0,0,0.7) 100%)" }} />
      <div className="absolute left-8 top-1/2 -translate-y-1/2 max-w-md">
        <div className="text-[10px] tracking-[0.3em] mb-2" style={{ color: "var(--accent-2)" }}>FEATURED · NEW SEASON</div>
        <div className="text-3xl font-extrabold mb-1">EA SPORTS FC 26</div>
        <div className="text-sm mb-4" style={{ color: "var(--muted)" }}>Build your ultimate squad. Live the season.</div>
        <button className="px-5 h-10 rounded-md text-sm font-semibold" style={{ background: "var(--accent)", color: "#0a0a0e" }}>▶ Play Now</button>
      </div>
    </div>
  );
}

export function GameGrid({ leadTile }: { leadTile?: React.ReactNode }) {
  const games = [
    { name: "Call of Duty MW3", sub: "Activision", art: ART.cod },
    { name: "Fortnite", sub: "Epic Games", art: ART.fortnite },
    { name: "Valorant", sub: "Riot Games", art: ART.valorant },
    { name: "GTA V", sub: "Rockstar", art: ART.gta },
    { name: "Minecraft", sub: "Mojang", art: ART.mc },
    { name: "eFootball 2026", sub: "Konami", art: ART.efootball },
    { name: "Apex Legends", sub: "EA / Respawn", art: ART.apex },
    { name: "Rocket League", sub: "Psyonix", art: ART.rocket },
    { name: "Forza Horizon 5", sub: "Microsoft", art: ART.forza },
    { name: "CS2", sub: "Valve", art: ART.csgo },
    { name: "League of Legends", sub: "Riot Games", art: ART.league },
    { name: "EA SPORTS FC 26", sub: "Electronic Arts", art: ART.fc26 },
  ];
  return (
    <section className="px-6 mt-5">
      <div className="flex items-center justify-between mb-3">
        <div className="nf-section-title">TOP APPS</div>
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
          <span>12 games</span>
          <span>·</span>
          <button>View all</button>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-3">
        {leadTile}
        {games.slice(0, leadTile ? 11 : 12).map((g) => (
          <div key={g.name} className="nf-tile">
            <div className="nf-tile-art" style={{ background: g.art }} />
            <div className="nf-tile-meta">
              <div className="nf-tile-title truncate">{g.name}</div>
              <div className="nf-tile-sub truncate">{g.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function BottomMarquee() {
  const items = ["LIVE STREAMS", "PRO TOURNAMENTS", "NEW RELEASES", "WIN PRIZES", "CLAN BATTLES", "DAILY MISSIONS"];
  const doubled = [...items, ...items];
  return (
    <div className="mt-auto h-10 flex items-center overflow-hidden border-t" style={{ background: "var(--bg-1)", borderColor: "var(--line)" }}>
      <div className="nf-marquee-track">
        {doubled.map((it, i) => (
          <span key={i} className="text-[11px] tracking-[0.25em]" style={{ color: i % 2 ? "var(--accent)" : "var(--muted)" }}>◆ {it}</span>
        ))}
      </div>
    </div>
  );
}

export function NetflixLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-label="Netflix">
      <path fill="#e50914" d="M250 80h150l250 700v160H600L450 540v320H250V80z" />
      <path fill="#831010" d="M400 80h150v780h-100L400 80z" />
      <path fill="#831010" d="M650 80h150v780h-150V80z" />
      <path fill="#e50914" d="M650 80l150 420V80H650z" opacity="0.0" />
    </svg>
  );
}

export function StatusBar() {
  return (
    <div className="flex items-center gap-3 text-[10px]" style={{ color: "var(--muted)" }}>
      <span className="flex items-center gap-1"><Wifi size={11} /> Online</span>
      <span className="flex items-center gap-1"><Volume2 size={11} /> 80%</span>
      <span>v2.4.1</span>
    </div>
  );
}
