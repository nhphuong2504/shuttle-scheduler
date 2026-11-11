import { Link } from "@tanstack/react-router";

export function EntryDataNotice({ organiser = false }: { organiser?: boolean }) {
  return (
    <p className="text-sm leading-6 text-muted-foreground">
      {organiser
        ? "Tell players how their information will be used before entering it. For a child, arrange appropriate permission with their parent or guardian and use an adult contact. Collect only what the event needs."
        : "This form is for adults registering themselves. Ask the organiser to arrange a child’s entry. Before entering a partner’s details, explain their use and get appropriate permission; use an adult contact for a child."}{" "}
      Public tournament views use generated player labels. Operators can read entrant names and
      relevant contacts. Read the{" "}
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
