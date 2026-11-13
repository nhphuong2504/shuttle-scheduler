import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { SERVICE_NAME, SUPPORT_EMAIL } from "@/lib/legal/policy";

export const Route = createFileRoute("/contact")({
  head: () => ({ meta: [{ title: "Contact | Tournova" }] }),
  component: ContactPage,
});

function ContactPage() {
  return (
    <PolicyPage title="Contact and data requests">
      <PolicySection title="Contact Tournova">
        <p>
          {SERVICE_NAME} is operated from Iowa, United States. Email{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="break-all font-semibold underline underline-offset-4"
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          for support, privacy requests, accessibility issues or reports of inappropriate content.
        </p>
        <p>
          For entries, scores, schedules or venue safety, contact the tournament organiser
          directly.
        </p>
      </PolicySection>
      <PolicySection title="Data requests">
        <p>
          To view, correct, hide or delete information, include the following. You do not need an
          account.
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>The tournament link</li>
          <li>The player or account concerned</li>
          <li>The change you are requesting</li>
          <li>Whether you are the player, a parent or guardian, or an authorised organiser</li>
        </ul>
        <p>
          We may ask for reasonable information to verify your authority. Do not send passwords,
          identity documents, payment information or a child’s full date of birth. If a child’s
          identity is exposed, say so in your message so we can consider restricting visibility
          while we review it.
        </p>
      </PolicySection>
      <PolicySection title="Security issues">
        <p>
          Send the affected page and a brief description. Do not access other people’s data or
          include secrets in your report. This inbox is not an emergency service.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
