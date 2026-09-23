import { LogOut, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MeResponse } from "@/types";

export function UserMenu({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const initials = (me.username || "?").slice(0, 2).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="h-8 w-8 rounded-full bg-emerald-600 text-white text-[11px] font-semibold flex items-center justify-center hover:bg-emerald-700 transition-colors">
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="text-sm flex items-center gap-1.5">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            {me.username || "anonymous"}
          </div>
          <div className="text-[11px] text-muted-foreground font-normal mt-0.5">
            groups: {(me.groups || []).join(", ") || "—"}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={onLogout}>
          <LogOut className="h-4 w-4 mr-2" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
