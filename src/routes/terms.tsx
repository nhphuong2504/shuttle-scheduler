import { createFileRoute, Link } from "@tanstack/react-router";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { OPERATOR_NAME } from "@/lib/legal/policy";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms | Tournova" }] }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <PolicyPage title="Pilot terms of use">
      <PolicySection title="Using the pilot">
        <p>
          These terms cover the free tournament software provided by {OPERATOR_NAME}, based in
          Iowa. There are no payments in this pilot. Create an account only if you are at least 18
          and agree to these terms. Keep your password private and your account details accurate.
          Children must not create accounts; see the{" "}
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>{" "}
          for how they can take part.
        </p>
        <p>Being approved to play in a tournament does not give you permission to operate it.</p>
      </PolicySection>
      <PolicySection title="Organisers and information entered for others">
        <p>
          Organisers are responsible for their events, venues, entry decisions, communications with
          participants and the permissions for the data they enter. Before entering someone else’s
          information, tell them how Tournova uses it and get appropriate permission, from a parent
          or guardian where needed.
        </p>
        <p>
          Do not put children’s names or contact details in public text such as titles,
          descriptions or venue fields. Do not submit unlawful, abusive, infringing or unnecessarily
          sensitive information. You keep the rights to your content and allow us to process and
          display it as described in the Privacy Policy.
        </p>
      </PolicySection>
      <PolicySection title="Schedules, results and availability">
        <p>
          Confirm schedules, scores and entries with the organiser. The pilot may contain errors or
          be unavailable, including on poor venue wifi, so organisers should keep exports and
          another way to announce changes.
        </p>
        <p>
          Tournova does not replace supervision, medical advice, venue safety procedures or event
          insurance, and these terms are not an injury waiver.
        </p>
      </PolicySection>
      <PolicySection title="No warranty and limited liability">
        <p>
          The pilot is provided free, “as is” and “as available”, without warranties of any kind,
          including fitness for a particular purpose or uninterrupted, error-free operation.
        </p>
        <p>
          To the extent the law allows, {OPERATOR_NAME} is not liable for indirect, incidental or
          consequential losses, or for lost data, results or opportunities, arising from use of the
          pilot. Total liability for any claim is limited to US$50. Nothing in these terms limits
          liability or rights that cannot lawfully be limited.
        </p>
      </PolicySection>
      <PolicySection title="Restrictions, changes and governing law">
        <p>
          We may restrict access or content to address misuse, security concerns or legal
          obligations. You can stop using Tournova at any time and ask us to delete your account
          through{" "}
          <Link to="/contact" className="underline underline-offset-4">
            Contact
          </Link>
          . If these terms change materially, we will ask you to accept the new version.
        </p>
        <p>
          The laws of Iowa, United States, govern these terms. These terms do not require
          arbitration or waive class actions.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
