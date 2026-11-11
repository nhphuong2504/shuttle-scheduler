import { createFileRoute } from "@tanstack/react-router";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { OPERATOR_NAME, SUPPORT_EMAIL } from "@/lib/legal/policy";

export const Route = createFileRoute("/contact")({
  head: () => ({ meta: [{ title: "Contact | Tournova" }] }),
  component: ContactPage,
});

function ContactPage() {
  return (
    <PolicyPage title="Contact and data requests">
      <PolicySection title="Contact the operator">
        <p>Tournova is operated by {OPERATOR_NAME} in Iowa, United States.</p>
        <p>
          Email{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="break-all font-semibold underline underline-offset-4"
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          for support, privacy requests, accessibility barriers or reports of inappropriate content.
        </p>
        <p>
          The email address is a contact address only. Tournova is not represented as an Iowa State
          University service or as endorsed by the university.
        </p>
      </PolicySection>
      <PolicySection title="Ask to view, correct, hide or delete data">
        <p>
          Include the tournament link, the player or account concerned, what you want changed and
          whether you are the player, a parent or guardian, or an authorised organiser. You do not
          need an account to make a request.
        </p>
        <p>
          Do not send passwords, identity documents, payment information or a child’s full date of
          birth. We may ask for proportionate information to verify authority before changing
          private records. Requests are handled manually; account removal and removal of tournament
          records are separate steps.
        </p>
        <p>
          If a child’s identity is exposed, say so in your message so we can assess restricting
          visibility while reviewing the request. Contact the organiser separately for event entry,
          scores, schedules or venue safety.
        </p>
      </PolicySection>
      <PolicySection title="Report a security issue">
        <p>
          Send the affected page and a brief description. Do not access other people’s records or
          include secrets in the report. This inbox is not an emergency service.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
