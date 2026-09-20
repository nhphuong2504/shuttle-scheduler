import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, EmptyState, Panel, StatTile } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/hooks/useSession";
import { inviteStaff, removeStaff } from "@/lib/tournament/actions";
import { useStaffRoles, type StaffRoleName } from "@/lib/tournament/data";

const ROLES = ["admin", "registrar", "scorer", "scheduler"] as const;

const STAFF_DESCRIPTION =
  "Invite desk accounts and manage registrar, scorer, scheduler and admin access for the tournament.";

export const Route = createFileRoute("/staff")({
  head: () => ({
    meta: [
      { title: "Staff | ShuttleNet Tournament Ops" },
      { name: "description", content: STAFF_DESCRIPTION },
      { property: "og:title", content: "Staff | ShuttleNet Tournament Ops" },
      { property: "og:description", content: STAFF_DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StaffPage,
});

function StaffPage() {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const { data: roles } = useStaffRoles();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRoleName>("scorer");

  const rows = roles ?? [];
  const countOf = (name: StaffRoleName) => rows.filter((r) => r.role === name).length;

  return (
    <AppShell
      title="Staff access"
      subtitle="Invite-only accounts with registrar, scorer, scheduler, or admin roles."
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatTile label="Accounts" value={rows.length} hint="Total invited" />
        {ROLES.map((r) => (
          <StatTile key={r} label={r} value={countOf(r)} tone={r === "admin" ? "good" : "normal"} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Panel title="Invite staff">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(v) => setRole(v as StaffRoleName)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              className="w-full"
              disabled={!isAdmin || !email}
              onClick={async () => {
                try {
                  await inviteStaff(email, role);
                  setEmail("");
                  toast.success("Invite saved");
                  qc.invalidateQueries({ queryKey: ["staff_roles"] });
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : "Could not invite");
                }
              }}
            >
              Add invite
            </Button>
          </div>
        </Panel>
        <Panel
          title="Current staff"
          right={
            <span className="font-score text-t2 text-muted-foreground">
              {rows.length} account{rows.length === 1 ? "" : "s"}
            </span>
          }
          bodyClassName="p-0"
        >
          {rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No staff invited yet"
                hint="Invite a desk account to give them access."
              />
            </div>
          ) : (
            <ul className="divide-y divide-hairline text-sm">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{row.email}</span>
                    <span className="inline-flex shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-score text-t4 uppercase tracking-wider text-primary">
                      {row.role}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!isAdmin}
                    onClick={async () => {
                      await removeStaff(row.id);
                      qc.invalidateQueries({ queryKey: ["staff_roles"] });
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
