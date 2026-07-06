"use client";
import dynamic from "next/dynamic";

const AdminDashboard = dynamic(() => import("@/components/admin/AdminDashboard"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-cyan-400 text-xl tracking-widest font-mono animate-pulse">
        Loading Dashboard...
      </div>
    </div>
  ),
});

export default function AdminPage() {
  return <AdminDashboard />;
}
