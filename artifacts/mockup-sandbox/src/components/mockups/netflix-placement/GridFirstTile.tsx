import "./_group.css";
import { TitleBar, SidebarBase, Header, FeaturedBanner, GameGrid, BottomMarquee, NetflixLogo } from "./_LauncherShell";

function NetflixGridTile() {
  return (
    <div className="nf-tile" style={{ background: "linear-gradient(160deg,#1a0306 0%,#0a0103 100%)", borderColor: "#3a0a10" }}>
      <div className="nf-tile-art relative flex items-center justify-center" style={{ background: "radial-gradient(ellipse at center, #4a0810 0%, #0a0103 80%)" }}>
        <div className="absolute inset-0 opacity-20" style={{ background: "repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,0.05) 3px 4px)" }} />
        <NetflixLogo size={56} />
        <div className="absolute top-2 right-2 text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: "#e50914", color: "white" }}>HD</div>
      </div>
      <div className="nf-tile-meta">
        <div className="nf-tile-title truncate">Netflix</div>
        <div className="nf-tile-sub truncate" style={{ color: "#e50914" }}>● Streaming · Ready</div>
      </div>
    </div>
  );
}

export function GridFirstTile() {
  return (
    <div className="nf-launcher h-screen w-full flex flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <SidebarBase />
        <main className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--bg-0)" }}>
          <Header />
          <div className="flex-1 overflow-y-auto nf-scroll">
            <FeaturedBanner />
            <GameGrid leadTile={<NetflixGridTile />} />
            <div className="h-6" />
          </div>
          <BottomMarquee />
        </main>
      </div>
    </div>
  );
}
