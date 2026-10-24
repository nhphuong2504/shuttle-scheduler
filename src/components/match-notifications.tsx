import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useSession } from "@/hooks/useSession";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface MatchNotification {
  id: string;
  read_at: string | null;
  message: string;
  created_at: string;
  tournament_id: string;
  tournament_name: string;
  court_number: number;
  outdated: boolean;
}

/** Account-scoped inbox persists across routes. Polling also catches up after reconnects. */
export function MatchNotifications() {
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const key = ["my-match-notifications", session?.userId];
  const query = useQuery({
    queryKey: key,
    enabled: !!session,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_match_notifications");
      if (error) throw error;
      return data as unknown as MatchNotification[];
    },
    refetchInterval: 5_000,
  });
  const read = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("read_match_notification", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: key });
    },
  });
  if (!session) return null;
  const unread = query.data?.filter((n) => !n.read_at).length ?? 0;
  return (
    <>
      <Button
        variant="ghost"
        className="relative size-11 shrink-0 rounded-full p-0 text-muted-foreground hover:text-foreground [&_svg]:size-5"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Notifications"
        onClick={() => {
          setOpen(true);
          void query.refetch();
        }}
      >
        <Bell aria-hidden="true" />
        {unread ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-xs font-semibold tabular-nums text-primary-foreground ring-2 ring-surface"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Button>
      <span role="status" className="sr-only">
        {unread ? `${unread} unread match notifications` : ""}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Notifications</DialogTitle>
            <DialogDescription>
              Your latest 100 match calls. Updates while Tournova is open.
            </DialogDescription>
          </DialogHeader>
          {query.isPending ? <p role="status">Loading notifications…</p> : null}
          {query.isError ? (
            <div role="alert">
              <p>Could not update notifications.</p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : null}
          {query.data?.length === 0 ? <p>No match calls yet.</p> : null}
          {read.isError ? (
            <p role="alert">Could not mark this notification as read. Try again.</p>
          ) : null}
          <ul className="space-y-3">
            {query.data?.map((n) => (
              <li key={n.id} className="space-y-2 rounded-lg border border-hairline p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 font-semibold">{n.tournament_name}</p>
                  {!n.read_at ? <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-sm font-medium">Unread</span> : null}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  <span>Court {n.court_number}</span>
                  <time dateTime={n.created_at}>{new Intl.DateTimeFormat(undefined, {
                    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
                  }).format(new Date(n.created_at))}</time>
                </div>
                <p className="whitespace-pre-wrap break-words">{n.message}</p>
                {n.outdated ? (
                  <p className="text-sm font-medium">
                    This match has changed or is no longer waiting. Check the current board.
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                  <Link
                    to="/tournaments/$tournamentId/desk"
                    params={{ tournamentId: n.tournament_id }}
                    className="inline-flex min-h-11 items-center underline"
                    onClick={() => setOpen(false)}
                  >
                    View court board
                  </Link>
                  {!n.read_at ? (
                    <Button
                      variant="outline"
                      disabled={read.isPending}
                      onClick={() => read.mutate(n.id)}
                    >
                      Mark as read
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
