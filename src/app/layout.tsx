import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Webvirt — web virt-manager",
  description:
    "Web-based virt-manager: Python FastAPI + React + TypeScript, libvirt-python over qemu+ssh, noVNC console, OIDC auth. Dockerized, single INI config, no database.",
  keywords: [
    "virt-manager",
    "libvirt",
    "qemu",
    "KVM",
    "FastAPI",
    "React",
    "TypeScript",
    "noVNC",
    "OIDC",
  ],
  authors: [{ name: "Webvirt" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
