import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { AppShell, Panel } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSession } from "@/hooks/useSession";
import { inviteStaff, removeStaff } from "@/lib/tournament/actions";
import { useStaffRoles, type StaffRoleName } from "@/lib/tournament/data";

export const Route = createFileRoute("/staff")({
  head: () => ({
    meta: [{ title: "Staff | ShuttleNet Tournament Ops" }],
  }),
  component: StaffPage,
});

function StaffPage() {
  const qc = useQueryClient();
  const { isAdmin } = useSession();
  const { data: roles } = useStaffRoles();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRoleName>("scorer");

  return (
    <AppShell title="Staff access" subtitle="Invite-only accounts with registrar, scorer, scheduler, or admin roles.">
      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
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
                  {(["admin", "registrar", "scorer", "scheduler"] as const).map((r) => (
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
        <Panel title="Current staff">
          <ul className="divide-y divide-hairline text-sm">
            {(roles ?? []).map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  {row.email} <span className="text-muted-foreground">· {row.role}</span>
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
        </Panel>
      </div>
    </AppShell>
  );
}
