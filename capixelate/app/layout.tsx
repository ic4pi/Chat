import type { Metadata } from "next";
import { Cinzel, Space_Mono } from "next/font/google";
import "./globals.css";

const cinzel = Cinzel({
  subsets: ["latin"],
  variable: "--font-cinzel",
  weight: ["400", "700", "900"],
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  variable: "--font-space-mono",
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Capixelate — Portfolio Seas",
  description:
    "An immersive pirate sailing portfolio experience. Navigate the seas, discover islands, and explore web projects.",
  openGraph: {
    title: "Capixelate",
    description: "Sail the portfolio seas",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${cinzel.variable} ${spaceMono.variable}`}>
      <body className="bg-slate-950 text-white antialiased overflow-hidden">
        {children}
      </body>
    </html>
  );
}
