import "./_group.css";
import { TitleBar, SidebarBase, Header, GameGrid, BottomMarquee, NetflixLogo } from "./_LauncherShell";

function NetflixHeroBanner() {
  return (
    <div className="relative mx-6 mt-4 rounded-xl overflow-hidden" style={{ height: 240, border: "1px solid #3a0a10" }}>
      <div className="absolute inset-0" style={{ background: "linear-gradient(110deg, #0a0103 0%, #1a0306 35%, #4a0810 70%, #e50914 100%)" }} />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 80% 50%, rgba(229,9,20,0.5) 0%, transparent 60%)" }} />
      <div className="absolute inset-0 opacity-10" style={{ background: "repeating-linear-gradient(90deg, transparent 0 2px, rgba(255,255,255,0.3) 2px 3px)" }} />

      <div className="absolute left-8 top-1/2 -translate-y-1/2 max-w-lg">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-[10px] tracking-[0.3em] px-2 py-1 rounded" style={{ background: "rgba(229,9,20,0.2)", color: "#ff5560", border: "1px solid #e50914" }}>STREAMING</div>
          <div className="text-[10px] tracking-[0.3em]" style={{ color: "var(--muted)" }}>READY TO WATCH</div>
        </div>
        <div className="text-4xl font-extrabold mb-2 leading-tight">Movies, shows, and more.<br/><span style={{ color: "#e50914" }}>Right from your launcher.</span></div>
        <div className="text-sm mb-5" style={{ color: "#c0c0d0" }}>Auto-signed in on this PC. Pick up where you left off.</div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-5 h-11 rounded-md text-sm font-bold" style={{ background: "#e50914", color: "white" }}>▶ Open Netflix</button>
          <button className="px-4 h-11 rounded-md text-sm font-medium" style={{ background: "rgba(255,255,255,0.1)", color: "white", backdropFilter: "blur(8px)" }}>My List</button>
        </div>
      </div>

      <div className="absolute right-8 top-1/2 -translate-y-1/2 flex items-center justify-center" style={{ width: 180, height: 180 }}>
        <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle, rgba(229,9,20,0.6) 0%, transparent 70%)", filter: "blur(20px)" }} />
        <NetflixLogo size={120} />
      </div>

      <div className="absolute bottom-3 right-4 flex items-center gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-full" style={{ width: i === 0 ? 20 : 6, height: 6, background: i === 0 ? "#e50914" : "rgba(255,255,255,0.3)" }} />
        ))}
      </div>
    </div>
  );
}

export function BannerHero() {
  return (
    <div className="nf-launcher h-screen w-full flex flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <SidebarBase />
        <main className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--bg-0)" }}>
          <Header />
          <div className="flex-1 overflow-y-auto nf-scroll">
            <NetflixHeroBanner />
            <GameGrid />
            <div className="h-6" />
          </div>
          <BottomMarquee />
        </main>
      </div>
    </div>
  );
}
