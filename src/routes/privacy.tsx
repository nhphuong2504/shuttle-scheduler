import { createFileRoute, Link } from "@tanstack/react-router";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { SERVICE_NAME } from "@/lib/legal/policy";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Privacy | Tournova" }] }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <PolicyPage title="Pilot privacy policy">
      <PolicySection title="Scope">
        <p>
          This policy explains how {SERVICE_NAME} handles personal information during its free
          pilot in the United States. Organisers decide which participant information to enter for
          their events. Send questions and requests through{" "}
          <Link to="/contact" className="underline underline-offset-4">
            Contact
          </Link>
          .
        </p>
      </PolicySection>
      <PolicySection title="Information we collect">
        <p>
          <strong>Accounts:</strong> email address and password. At sign-up we record the terms
          version you accepted, the time and your confirmation that you are at least 18. We do not
          verify age.
        </p>
        <p>
          <strong>Entries:</strong> player and partner names, email, phone, gender, events and
          notes. Organisers or the person submitting an entry may provide this information about
          others. Do not enter payment details, health information or identity documents.
        </p>
        <p>
          <strong>Operational records:</strong> tournament changes, match notifications and
          security logs. Our hosting providers process IP addresses and request data to deliver and
          protect the service.
        </p>
      </PolicySection>
      <PolicySection title="How we use it">
        <p>
          We use this information to run accounts, registration decisions, entries, draws,
          schedules and results, to contact participants and to keep the service secure. We do not
          sell personal information, use it for advertising or run analytics trackers.
        </p>
      </PolicySection>
      <PolicySection title="Who can see it">
        <p>
          Tournament names, events, venues, schedules and results are public. On real tournaments,
          public pages show generated player labels instead of names and do not show gender. Only
          authorised tournament operators see player names and contact details. Sample tournaments
          use fictional names.
        </p>
        <p>
          A generated label does not guarantee anonymity; other details may still identify a
          player. Information that authorised people export or share outside Tournova is outside
          our control.
        </p>
      </PolicySection>
      <PolicySection title="Players under 18">
        <p>
          Accounts are for people aged 18 or older; this is an account restriction, not a minimum
          age for playing in tournaments. An authorised adult organiser enters players under 18,
          with permission from a parent or guardian and using an adult’s contact details. If you
          believe a child has an account or their information is being misused, contact us and we
          will review restricting, correcting or removing it.
        </p>
      </PolicySection>
      <PolicySection title="Service providers and browser storage">
        <p>
          Supabase provides accounts and the database, Cloudflare provides hosting and network
          delivery, and Google Fonts delivers fonts and receives your IP address. These providers
          process data only to provide their part of the service.
        </p>
        <p>
          Your browser stores your sign-in session, preferences such as a followed player, and
          unsaved tournament setup drafts. We do not track you across sites, so we do not respond
          to Do Not Track signals.
        </p>
      </PolicySection>
      <PolicySection title="Retention and requests">
        <p>
          We keep information as long as needed to operate accounts and events, preserve results
          and audit history, maintain security and meet legal obligations. Deleted information may
          remain in backups until they expire.
        </p>
        <p>
          You can ask to access, correct, hide, delete or de-identify information through Contact.
          We may ask for reasonable information to confirm your identity or authority. Deleting an
          account does not automatically remove tournament entries or results; we review those
          separately.
        </p>
      </PolicySection>
      <PolicySection title="Changes">
        <p>
          We will post changes on this page and update its date. If a change requires your
          agreement, we will ask for it again.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
