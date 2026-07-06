import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Capixelate — Admin Dashboard",
  description: "Manage your portfolio projects, islands, and enemies",
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
