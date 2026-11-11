import { createFileRoute, Link } from "@tanstack/react-router";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { OPERATOR_NAME } from "@/lib/legal/policy";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy | Tournova" }] }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <PolicyPage title="Pilot privacy policy">
      <PolicySection title="Who operates Tournova">
        <p>
          {OPERATOR_NAME} operates Tournova from Iowa, United States. This draft covers the free US
          pilot. Organisers also decide how to run their events and what participant information to
          enter. For requests, use{" "}
          <Link to="/contact" className="underline underline-offset-4">
            Contact and data requests
          </Link>
          .
        </p>
      </PolicySection>
      <PolicySection title="Information used to provide the service">
        <p>
          Accounts use an email address and authentication credentials. We record the terms version,
          server time and the account holder’s statement that they are at least 18 when they sign
          up. This is an acknowledgement, not proof of identity or age.
        </p>
        <p>
          Registration and organiser entry forms may collect player and partner names, email, phone,
          gender, events and request notes. Organisers and people submitting entries can provide
          information about others. We use this information for registration decisions, entries,
          draws, schedules, scores and contacting participants. Do not enter payment details, health
          information or identification documents.
        </p>
        <p>
          Operational records may include account and tournament identifiers, changes, match
          notifications and security/access logs. Our infrastructure providers may process IP
          addresses and technical request information to deliver and protect the service.
        </p>
      </PolicySection>
      <PolicySection title="What others can see">
        <p>
          Tournament names, event details, venue information, schedules and results are public. For
          real tournaments, public player reads use generated player labels and omit gender.
          Authorised tournament operators can see player names and relevant contact information.
          Sample tournaments use fictional names.
        </p>
        <p>
          Organisers must keep personal information out of public free-text fields. A generated
          label does not guarantee anonymity: a venue, event, schedule or information shared
          elsewhere may identify a player. Authorised people may export data; copies already
          downloaded or shared outside Tournova cannot be recalled by changing a page.
        </p>
      </PolicySection>
      <PolicySection title="Children and adult-entered entries">
        <p>
          Accounts are for adults aged 18 or older. Children participate through an authorised
          adult; we do not offer child self-service accounts in this pilot. Adults entering a child
          must have appropriate authority, use an adult contact and minimise the information
          entered. An organiser’s statement is not a substitute for legally required parental
          consent.
        </p>
        <p>
          If you believe a child has created an account or their information has been used
          improperly, contact us to review restriction, correction or removal. Public player labels
          are used without requiring a child’s date of birth.
        </p>
      </PolicySection>
      <PolicySection title="Providers and browser storage">
        <p>
          Supabase provides account and database services; Cloudflare provides hosting and network
          delivery for the intended deployment. Google Fonts requests can send Google technical data
          such as your IP address. We also use locally served fonts. Access by service providers is
          needed to deliver these features; the exact deployed configuration and vendor retention
          must be checked before launch.
        </p>
        <p>
          Browser storage keeps sign-in sessions and preferences such as a followed player or recent
          tournament. Sign out on shared devices. The current application has no advertising or
          analytics SDK identified in this review; hosting logs still exist. We do not sell personal
          information or use it for targeted advertising in this pilot.
        </p>
        <p>
          We do not use browser Do Not Track signals to change these essential service functions.
          This draft does not claim that every external provider honours that signal; Google Fonts
          is an external request, not a promise that no third party receives technical data.
        </p>
      </PolicySection>
      <PolicySection title="Retention and your requests">
        <p>
          Data is retained to provide accounts, run events, preserve appropriate results and audit
          history, address security issues and meet applicable obligations. Detailed retention
          periods and backup expiry must be finalised before launch; this draft is not a promise of
          immediate deletion from every system.
        </p>
        <p>
          Ask to access, correct, hide, delete or de-identify information through Contact. We verify
          authority proportionately and explain any limits. Deleting a login alone does not delete
          player, profile, request or tournament history. We review those records separately,
          including whether results can be preserved without identifying a person. Backups and
          copies already exported require separate handling.
        </p>
        <p>
          We will update this page when practices change and show the revision date. Changes
          requiring fresh agreement or consent will be handled separately. Contact us about an
          accessibility barrier or privacy concern without creating an account.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
