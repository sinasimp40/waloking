import "./_group.css";
import { TitleBar, SidebarBase, Header, FeaturedBanner, GameGrid, BottomMarquee, NetflixLogo } from "./_LauncherShell";

function NetflixSidebarPoster() {
  return (
    <div className="rounded-xl overflow-hidden mb-3 relative" style={{ background: "linear-gradient(180deg, #1a0306 0%, #4a0810 60%, #e50914 100%)", border: "1px solid #3a0a10", height: 200 }}>
      <div className="absolute inset-0 opacity-15" style={{ background: "repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,0.4) 3px 4px)" }} />
      <div className="absolute top-2 left-2 text-[9px] font-bold tracking-[0.2em] px-2 py-0.5 rounded" style={{ background: "rgba(0,0,0,0.5)", color: "#fff", backdropFilter: "blur(4px)" }}>STREAMING</div>

      <div className="absolute inset-0 flex flex-col items-center justify-center pt-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle, rgba(255,255,255,0.4) 0%, transparent 70%)", filter: "blur(12px)" }} />
          <NetflixLogo size={64} />
        </div>
        <div className="text-[10px] mt-2 tracking-[0.15em]" style={{ color: "rgba(255,255,255,0.85)" }}>SIGNED IN · READY</div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 p-2.5" style={{ background: "linear-gradient(0deg, rgba(0,0,0,0.85) 0%, transparent 100%)" }}>
        <button className="w-full h-9 rounded-md text-xs font-bold flex items-center justify-center gap-1.5" style={{ background: "white", color: "#e50914" }}>▶ WATCH NOW</button>
      </div>
    </div>
  );
}

export function SidebarPoster() {
  return (
    <div className="nf-launcher h-screen w-full flex flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <SidebarBase topSlot={<NetflixSidebarPoster />} />
        <main className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--bg-0)" }}>
          <Header />
          <div className="flex-1 overflow-y-auto nf-scroll">
            <FeaturedBanner />
            <GameGrid />
            <div className="h-6" />
          </div>
          <BottomMarquee />
        </main>
      </div>
    </div>
  );
}
