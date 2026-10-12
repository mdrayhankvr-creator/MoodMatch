import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { PersonalProvider } from "@/components/personal-provider";
import { authConfigured } from "@/lib/supabase/config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "MoodMatch — Find a film for the feeling",
  description: "Describe your mood and discover real films through semantic search.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col"><PersonalProvider enabled={authConfigured()}>{children}</PersonalProvider></body>
    </html>
  );
}
