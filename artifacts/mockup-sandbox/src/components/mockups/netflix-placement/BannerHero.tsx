import { ChevronLeft, ChevronRight } from "lucide-react";
import "./_group.css";
import { TitleBar, SidebarBase, Header, GameGrid, BottomMarquee, NetflixLogo } from "./_LauncherShell";

function ShopHeaderStrip() {
  return (
    <div className="relative overflow-hidden border-b" style={{ borderColor: "rgba(255,122,24,0.15)", height: 88, background: "linear-gradient(90deg, #0a0a0e 0%, #14141c 50%, #0a0a0e 100%)" }}>
      <div className="absolute inset-0 opacity-30" style={{ background: "radial-gradient(ellipse at center, rgba(255,122,24,0.18) 0%, transparent 60%)" }} />
      <div className="absolute top-0 inset-x-0 h-px" style={{ background: "linear-gradient(90deg, transparent, rgba(255,122,24,0.4), transparent)" }} />
      <div className="absolute bottom-0 inset-x-0 h-px" style={{ background: "linear-gradient(90deg, transparent, rgba(255,122,24,0.2), transparent)" }} />

      <div className="relative h-full flex items-center px-6 gap-5">
        <div className="w-1.5 h-14 rounded-full" style={{ background: "linear-gradient(180deg, #ff7a18, rgba(255,122,24,0.4), transparent)", boxShadow: "0 0 12px rgba(255,122,24,0.6)" }} />
        <div className="flex-1 min-w-0">
          <h1 className="font-extrabold text-3xl tracking-[0.2em] leading-none" style={{ color: "#ff7a18", textShadow: "0 2px 4px rgba(0,0,0,0.8)", fontFamily: "'Bebas Neue', sans-serif" }}>EXAMPLE CAFE</h1>
          <p className="text-[10px] tracking-[0.3em] uppercase mt-1.5" style={{ color: "rgba(255,255,255,0.65)" }}>JUST SIT, PLAY, RELAX &amp; ENJOY</p>
          <div className="flex gap-2 mt-2">
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md" style={{ background: "rgba(255,122,24,0.1)", border: "1px solid rgba(255,122,24,0.25)" }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#ff7a18", boxShadow: "0 0 6px #ff7a18" }} />
              <span className="text-[9px] font-bold tracking-wider" style={{ color: "#ff7a18" }}>ONLINE</span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md" style={{ background: "linear-gradient(90deg, rgba(245,158,11,0.2), rgba(245,158,11,0.1))", border: "1px solid rgba(245,158,11,0.4)" }}>
              <span className="text-[9px]">⭐</span>
              <span className="text-[9px] font-black tracking-widest" style={{ color: "#f59e0b", textShadow: "0 0 10px rgba(245,158,11,0.4)" }}>PREMIUM</span>
            </div>
          </div>
        </div>
      </div>
      <div className="absolute top-1.5 right-2 w-4 h-4 border-t-2 border-r-2" style={{ borderColor: "rgba(255,122,24,0.5)" }} />
      <div className="absolute bottom-1.5 left-2 w-4 h-4 border-b-2 border-l-2" style={{ borderColor: "rgba(255,122,24,0.5)" }} />
    </div>
  );
}

function NetflixHeroSlide() {
  return (
    <div className="absolute inset-0">
      <div className="absolute inset-0" style={{ background: "linear-gradient(110deg, #0a0103 0%, #1a0306 35%, #4a0810 70%, #e50914 100%)" }} />
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 80% 50%, rgba(229,9,20,0.5) 0%, transparent 60%)" }} />
      <div className="absolute inset-0 opacity-10" style={{ background: "repeating-linear-gradient(90deg, transparent 0 2px, rgba(255,255,255,0.3) 2px 3px)" }} />

      <div className="absolute left-8 top-1/2 -translate-y-1/2 max-w-lg">
        <div className="flex items-center gap-2 mb-3">
          <div className="text-[10px] tracking-[0.3em] px-2 py-1 rounded" style={{ background: "rgba(229,9,20,0.2)", color: "#ff5560", border: "1px solid #e50914" }}>STREAMING</div>
          <div className="text-[10px] tracking-[0.3em]" style={{ color: "var(--muted)" }}>READY TO WATCH</div>
        </div>
        <div className="text-3xl font-extrabold mb-2 leading-tight">Movies, shows, and more.<br/><span style={{ color: "#fff" }}>Right from your launcher.</span></div>
        <div className="text-sm mb-4" style={{ color: "#e0d0d5" }}>Auto-signed in on this PC. Pick up where you left off.</div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-2 px-5 h-10 rounded-md text-sm font-bold" style={{ background: "#fff", color: "#e50914" }}>▶ Open Netflix</button>
          <button className="px-4 h-10 rounded-md text-sm font-medium" style={{ background: "rgba(255,255,255,0.15)", color: "white", backdropFilter: "blur(8px)" }}>My List</button>
        </div>
      </div>

      <div className="absolute right-12 top-1/2 -translate-y-1/2 flex items-center justify-center" style={{ width: 140, height: 140 }}>
        <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle, rgba(229,9,20,0.6) 0%, transparent 70%)", filter: "blur(20px)" }} />
        <NetflixLogo size={100} />
      </div>
    </div>
  );
}

function FeaturedBannerSlider() {
  const slides = [
    { label: "NETFLIX", active: true },
    { label: "EA SPORTS FC 26", active: false },
    { label: "CALL OF DUTY", active: false },
    { label: "WEEKLY TOURNAMENT", active: false },
  ];
  return (
    <div className="relative mx-6 mt-4 rounded-xl overflow-hidden" style={{ height: 220, border: "1px solid #3a0a10" }}>
      <NetflixHeroSlide />

      <button className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/20" style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }} aria-label="Previous slide">
        <ChevronLeft size={18} color="white" />
      </button>
      <button className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/20" style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }} aria-label="Next slide">
        <ChevronRight size={18} color="white" />
      </button>

      <div className="absolute top-3 right-3 flex items-center gap-1.5 text-[10px] font-bold tracking-wider px-2.5 py-1 rounded" style={{ background: "rgba(0,0,0,0.5)", color: "white", backdropFilter: "blur(4px)" }}>
        <span style={{ color: "#e50914" }}>1</span>
        <span style={{ opacity: 0.5 }}>/ {slides.length}</span>
      </div>

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2">
        {slides.map((s, i) => (
          <div key={s.label} className="rounded-full transition-all" style={{
            width: s.active ? 24 : 6,
            height: 6,
            background: s.active ? "#fff" : "rgba(255,255,255,0.4)",
          }} />
        ))}
      </div>

      <div className="absolute bottom-3 right-3 flex items-center gap-1.5 text-[9px] tracking-wider" style={{ color: "rgba(255,255,255,0.7)" }}>
        <span className="w-1 h-1 rounded-full animate-pulse" style={{ background: "#fff" }} />
        <span>AUTO · 6s</span>
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
          <ShopHeaderStrip />
          <div className="flex-1 overflow-y-auto nf-scroll">
            <FeaturedBannerSlider />
            <GameGrid />
            <div className="h-6" />
          </div>
          <BottomMarquee />
        </main>
      </div>
    </div>
  );
}
