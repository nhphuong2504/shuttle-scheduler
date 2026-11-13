import { Link } from "@tanstack/react-router";

export function EntryDataNotice() {
  return (
    <p className="text-sm leading-6 text-muted-foreground">
      This form is for account holders aged 18 or older registering themselves. Players under 18
      can still participate: a parent or guardian should arrange their entry with the organiser.
      Before entering a partner’s details, explain their use and get appropriate permission; use
      an adult contact for a child. Public tournament views use generated player labels. Operators
      can read entrant names and relevant contacts. Read the{" "}
      <Link to="/privacy" className="underline underline-offset-4">
        Privacy Policy
      </Link>{" "}
      or{" "}
      <Link to="/contact" className="underline underline-offset-4">
        request a correction or removal
      </Link>
      .
    </p>
  );
}
