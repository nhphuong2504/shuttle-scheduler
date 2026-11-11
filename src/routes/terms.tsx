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
          These terms describe the free tournament software provided by {OPERATOR_NAME}, based in
          Iowa. There are no platform payments in this pilot. Create an account only if you are at
          least 18 and agree to these terms. Keep your credentials private and provide accurate
          account information.
        </p>
        <p>
          Children may participate in a tournament through an authorised adult organiser or parent.
          Children must not create an account. Registration approval does not grant permission to
          operate a tournament.
        </p>
      </PolicySection>
      <PolicySection title="Organisers and information entered for others">
        <p>
          Organisers are responsible for running their events, venue arrangements, entry decisions,
          participant communications and appropriate permissions for the data they enter. Before
          entering another person’s information, explain the use of Tournova and obtain appropriate
          authority, including from a parent or guardian where needed. Use an adult contact for a
          child and enter only information necessary to run the event.
        </p>
        <p>
          Do not put children’s real names or contact details in public tournament titles,
          descriptions, venue fields or other public text. Do not submit unlawful, abusive,
          infringing or unnecessarily sensitive information. You retain your rights in your content
          and permit the processing needed to provide the service and display information as
          described in the Privacy Policy.
        </p>
      </PolicySection>
      <PolicySection title="Schedules, results and availability">
        <p>
          Check schedules, scores and entry details with the organiser. The pilot may contain errors
          or become unavailable, including on poor venue wifi. Organisers should keep appropriate
          exports and an alternative way to communicate changes. We do not promise uninterrupted
          service or a particular tournament outcome.
        </p>
        <p>
          The software does not replace supervision, medical advice, venue safety procedures or
          event insurance. These terms are not an injury waiver for a participant or a child.
        </p>
      </PolicySection>
      <PolicySection title="Requests, restrictions and changes">
        <p>
          We may restrict access or content to address misuse, security concerns or legal
          obligations. Contact us to report an issue or discuss a restriction. Material changes to
          account terms will require a new acknowledgement before being represented as accepted; the
          version you accepted is recorded separately from editable profile data.
        </p>
        <p>
          Applicable law governs your rights. Nothing here excludes liability or rights that cannot
          lawfully be excluded. These draft terms do not require arbitration or waive class actions.
        </p>
        <p>
          Read the{" "}
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>{" "}
          and use{" "}
          <Link to="/contact" className="underline underline-offset-4">
            Contact
          </Link>{" "}
          for requests or concerns.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
