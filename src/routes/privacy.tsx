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
          {OPERATOR_NAME} operates Tournova from Iowa, United States, as a free US pilot. Organisers
          decide how to run their events and what participant information to enter. For requests,
          use{" "}
          <Link to="/contact" className="underline underline-offset-4">
            Contact and data requests
          </Link>
          .
        </p>
      </PolicySection>
      <PolicySection title="Information we use">
        <p>
          Accounts use an email address and password. When you sign up we record the terms version,
          the time and your statement that you are at least 18. That statement is not proof of age.
        </p>
        <p>
          Registration and entry forms may collect player and partner names, email, phone, gender,
          events and notes. Organisers and people submitting entries may provide information about
          others. We use it for registration decisions, entries, draws, schedules, scores and
          contacting participants. Do not enter payment details, health information or
          identification documents.
        </p>
        <p>
          We also keep operational records such as tournament changes, match notifications and
          security logs. Our hosting providers process IP addresses and technical request
          information to deliver and protect the service.
        </p>
      </PolicySection>
      <PolicySection title="What others can see">
        <p>
          Tournament names, event details, venues, schedules and results are public. On real
          tournaments, public pages show generated player labels instead of names and do not show
          gender. Authorised tournament operators can see player names and relevant contact
          details. Sample tournaments use fictional names.
        </p>
        <p>
          A generated label is not full anonymity: the venue, event or information shared elsewhere
          may still identify a player. Organisers must keep personal information out of public text
          such as titles and descriptions. Copies that authorised people export or share outside
          Tournova cannot be recalled.
        </p>
      </PolicySection>
      <PolicySection title="Children">
        <p>
          Accounts are for adults aged 18 or older. Children take part only when an authorised adult
          enters them. That adult must have appropriate permission from a parent or guardian, use an
          adult contact and enter only what the event needs. If you believe a child has an account
          or their information is being misused, contact us and we will review restricting,
          correcting or removing it.
        </p>
      </PolicySection>
      <PolicySection title="Service providers and browser storage">
        <p>
          Supabase provides accounts and the database. Cloudflare provides hosting and network
          delivery. Some fonts load from Google Fonts, which receives your IP address and basic
          request information. These providers process data only to deliver their part of the
          service.
        </p>
        <p>
          Your browser stores your sign-in session, preferences such as a followed player, and
          unsaved tournament setup drafts. Sign out on shared devices. Tournova has no advertising
          or analytics trackers. We do not sell personal information or use it for targeted
          advertising. We do not respond to browser Do Not Track signals because we do no
          cross-site tracking.
        </p>
      </PolicySection>
      <PolicySection title="Retention and your requests">
        <p>
          We keep information while it is needed to provide accounts, run events, preserve results
          and audit history, handle security issues and meet legal obligations. Backups expire on
          their own schedule, so deletion may not reach every copy at once.
        </p>
        <p>
          Ask to access, correct, hide, delete or de-identify information through Contact. We may
          ask for proportionate information to confirm your authority. Deleting an account does not
          by itself delete player entries or tournament history; we review those separately,
          including whether results can stay without identifying you.
        </p>
        <p>
          If these practices change, we will update this page and its date. Changes that need your
          agreement will ask for it again.
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
