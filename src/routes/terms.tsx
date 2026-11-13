import { createFileRoute, Link } from "@tanstack/react-router";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { SERVICE_NAME } from "@/lib/legal/policy";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms | Tournova" }] }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <PolicyPage title="Pilot terms of use">
      <PolicySection title="Eligibility and accounts">
        <p>
          These terms govern your use of {SERVICE_NAME}, a free tournament management service
          offered as a pilot. No payments are taken. You must be at least 18 to create an account.
          Keep your password confidential and your account details accurate.
        </p>
        <p>
          Players of all ages may participate in tournaments, subject to each event’s rules.
          Players under 18 take part through an authorised adult organiser, as described in the{" "}
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          . Approval to play in a tournament does not grant permission to operate it.
        </p>
      </PolicySection>
      <PolicySection title="Organiser responsibilities">
        <p>
          Organisers are responsible for their events, venues, entry decisions, communications with
          participants and the information they enter. Before entering someone else’s information,
          tell them how Tournova uses it and obtain appropriate permission, including from a parent
          or guardian where required. Keep personal information, especially about children, out of
          public text such as titles, descriptions and venue fields.
        </p>
      </PolicySection>
      <PolicySection title="Acceptable use and content">
        <p>
          Do not submit unlawful, abusive, infringing or unnecessarily sensitive information, or
          attempt to access data you are not authorised to see. You keep ownership of your content
          and allow us to store, process and display it as described in the Privacy Policy.
        </p>
      </PolicySection>
      <PolicySection title="Availability and safety">
        <p>
          Confirm schedules, scores and entries with the organiser. The pilot may contain errors or
          be unavailable, including on poor venue wifi, so organisers should keep exports and an
          alternative way to announce changes.
        </p>
        <p>
          Tournova does not replace supervision, medical advice, venue safety procedures or event
          insurance, and these terms are not an injury waiver.
        </p>
      </PolicySection>
      <PolicySection title="Disclaimer and limitation of liability">
        <p>
          The pilot is provided free, “as is” and “as available”, without warranties of any kind,
          including fitness for a particular purpose or uninterrupted, error-free operation.
        </p>
        <p>
          To the extent permitted by law, {SERVICE_NAME} is not liable for indirect, incidental or
          consequential losses, or for lost data, results or opportunities, arising from use of the
          pilot. Total liability for any claim is limited to US$50. Nothing in these terms limits
          liability or rights that cannot lawfully be limited.
        </p>
      </PolicySection>
      <PolicySection title="Suspension, changes and governing law">
        <p>
          We may restrict access or remove content to address misuse, security risks or legal
          obligations. You may stop using Tournova at any time and request account deletion through{" "}
          <Link to="/contact" className="underline underline-offset-4">
            Contact
          </Link>
          . If these terms change materially, we will ask you to accept the new version.
        </p>
        <p>
          These terms are governed by the laws of the State of Iowa, United States. They do not
          require arbitration or waive class actions.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
