"use client";
import dynamic from "next/dynamic";

const GameCanvas = dynamic(() => import("@/components/game/GameCanvas"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950">
      <div
        className="text-5xl font-bold tracking-[0.3em] text-cyan-400 mb-4"
        style={{ fontFamily: "serif", textShadow: "0 0 30px #00ffcc" }}
      >
        CAPIXELATE
      </div>
      <div className="text-slate-500 text-sm tracking-widest">Loading the seas...</div>
    </div>
  ),
});

export default function Home() {
  return (
    <main className="w-screen h-screen overflow-hidden bg-slate-950">
      <GameCanvas />
      <a
        href="/admin"
        className="absolute top-4 right-4 z-50 text-xs text-slate-600 hover:text-cyan-500 transition-colors font-mono tracking-wide opacity-50 hover:opacity-100"
        title="Admin Dashboard"
      >
        ⚙ Admin
      </a>
    </main>
  );
}
