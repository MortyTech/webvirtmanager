"use client";

import * as React from "react";
import { MonitorPlay, ShieldCheck, Github, Info } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DashboardView } from "@/components/showcase/dashboard-view";
import { ConfigView, ArchitectureView, DeployView } from "@/components/showcase/info-views";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";

export default function Page() {
  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      {/* Header */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 h-14 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white">
              <MonitorPlay className="h-4.5 w-4.5" />
            </div>
            <div className="leading-tight">
              <div className="font-semibold text-sm">Webvirt</div>
              <div className="text-[11px] text-muted-foreground -mt-0.5">web virt-manager</div>
            </div>
          </div>

          <Badge variant="secondary" className="hidden sm:inline-flex text-[10px] gap-1 ml-1">
            <ShieldCheck className="h-3 w-3" /> OIDC-protected
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            <a
              href="#"
              className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="h-3.5 w-3.5" /> repo
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger className="outline-none">
                <Avatar className="h-8 w-8 border">
                  <AvatarFallback className="bg-emerald-600 text-white text-[11px]">TJ</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm">tunoo@example.com</div>
                  <div className="text-[11px] text-muted-foreground font-normal mt-0.5">groups: admins, virt-ops</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled>Profile</DropdownMenuItem>
                <DropdownMenuItem disabled>Settings</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">Sign out (RP-initiated logout)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Preview banner */}
      <div className="border-b bg-emerald-50 dark:bg-emerald-950/30">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-1.5 flex items-center gap-2 text-[12px] text-emerald-800 dark:text-emerald-300">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>
            Live interactive preview of the dashboard UI (mock data). The deployable Docker app — FastAPI +
            libvirt + noVNC — lives in <code className="font-mono text-[11px] bg-emerald-100 dark:bg-emerald-900/50 px-1 rounded">backend/</code> and <code className="font-mono text-[11px] bg-emerald-100 dark:bg-emerald-900/50 px-1 rounded">frontend/</code>.
          </span>
        </div>
      </div>

      {/* Main */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 py-4">
        <Tabs defaultValue="dashboard" className="w-full">
          <div className="flex items-center justify-between mb-4">
            <TabsList>
              <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
              <TabsTrigger value="config">Configuration</TabsTrigger>
              <TabsTrigger value="architecture">Architecture</TabsTrigger>
              <TabsTrigger value="deploy">Deploy</TabsTrigger>
            </TabsList>
            <span className="hidden sm:block text-[11px] text-muted-foreground">
              virt-manager, in your browser
            </span>
          </div>

          <TabsContent value="dashboard" className="mt-0">
            <DashboardView />
          </TabsContent>
          <TabsContent value="config" className="mt-0">
            <ConfigView />
          </TabsContent>
          <TabsContent value="architecture" className="mt-0">
            <ArchitectureView />
          </TabsContent>
          <TabsContent value="deploy" className="mt-0">
            <DeployView />
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t bg-background">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[12px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <MonitorPlay className="h-3.5 w-3.5 text-emerald-600" />
            <span>Webvirt — Python FastAPI · React + TypeScript · libvirt-python · noVNC</span>
          </div>
          <div className="flex items-center gap-3">
            <span>qemu+ssh · WS-to-VNC proxy · single INI config · no DB</span>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <span>MIT</span>
          </div>
        </div>
      </footer>

      <SonnerToaster position="bottom-right" richColors />
    </div>
  );
}
