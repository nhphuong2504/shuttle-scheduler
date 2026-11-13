# General tournament platforms and minors

## What minimum ages and parental conditions are stated?

### Takeaway
Challonge and start.gg support teenage users rather than imposing a blanket adults-only platform. Their published terms require parent involvement, but terms language alone does not establish a checkbox-only implementation.

### Cited Findings
- Challonge Terms (last updated April 21, 2023, checked November 13, 2026) specify minimum age 13. Minors need parent/guardian permission and direct supervision, and the parent must read and agree to the terms before use. §3 also makes age and parental permission user representations. — [Official Terms](https://challonge.com/terms_of_service)
- start.gg Terms §1.2, for North America, make services available from 13 subject to applicable restrictions; ages 13–17 and a parent/guardian must review Terms and Privacy together. The published terms also allocate responsibility to parents for under-18 use. Outside North America the terms call for parent acceptance where the user is below majority. — [Official Terms](https://www.start.gg/about/tos)
- Extraction note: the start.gg HTML text tool returned only the app shell. The age text above was verified in the same page's publicly served official asset, fetched directly: [Terms page JS asset](https://www.start.gg/assets/__static/2603/_next/static/chunks/pages/about/tos-f5f9d2dd324749eb.js). This asset URL is versioned and can change; cite the stable Terms page in the final report.

### Inferences
- Tournova's 13+ policy with parent review for teens has a real general-tournament precedent. However, it would overstate the evidence to say these companies prove that a teen ticking a permission box is sufficient or is their actual registration design.

### Gaps
- No reliable official help page was found establishing Challonge's exact teen signup parental verification mechanics.
- start.gg has a guardian setup route in its publicly served app data, but this does not by itself establish what it does or who must complete it. Do not infer a verified parent flow from the route name.

## Can minors participate without owning an account?

### Takeaway
Both platforms distinguish entering a person in an event from that person owning a login. This is the most directly applicable pattern for Tournova.

### Cited Findings
- Challonge's participant-management help documents organiser-added display-name-only entries as suitable when participants are not required to register, separate from inviting account holders by email/username. Display names can be edited in the bracket. — [Participant Management](https://kb.challonge.com/en/article/participant-management-1m6ooqe/)
- Challonge open signup does require a Challonge account; anonymous visitors are sent to create one or log in. Thus the organiser-entry and self-service signup paths have materially different requirements. Help updated December 22, 2025. — [Hosting a Sign-Up Page](https://kb.challonge.com/en/article/hosting-a-sign-up-page-hsknjd/)
- start.gg Privacy (updated September 28, 2026) §4.7 and §12 prohibit accounts for under-13s, while permitting an authorised parent, guardian or other adult to provide a minor's name/email for registration/ticketing. It limits this processing to event administration/participation and says unauthorised under-13 collection will be addressed with deletion steps. — [Official Privacy Policy](https://www.start.gg/about/privacy)

### Inferences
- The relevant design is adult login → participant entry, with independent player and account identities. It does not require giving children a password or labelling a parent's own profile as the child.
- A display name visible in a bracket is a publication decision; the ability to add an entrant does not establish consent to publish their legal identity. Tournova can retain its generated public player labels independently of account-age changes.

### Gaps
- The cited Challonge participant help is general organiser-entry documentation, not an express under-13 exception to its service-age terms. Do not describe it as legal authorisation for children to use the platform directly.
- start.gg Privacy documents adult-supplied minor data; it does not explain all current family-account UI details. Indexed official policy text was available, whereas opening the live page through the extraction tool showed an app shell.

## What stronger parent mechanisms are documented, and what should Tournova infer?

### Takeaway
Do not equate a teen's declaration of parent permission with a parent personally approving or with verifiable parental consent. The two strong current comparisons support the policy shape, not the claim that checkbox-only handling is established best practice.

### Cited Findings
- Historical supplementary example only: an official US Youth Soccer/Battlefy one-page guide describes date-of-birth screening; under-13 users receive a unique parent link; the parent creates an account and completes a $0.50 card transaction before the child's account unlocks. The file is hosted in a September 2023 directory and search metadata suggests older authorship. — [USYS/Battlefy guide](https://www.usyouthsoccer.org/wp-content/uploads/sites/160/2023/09/usys_and_battlefy_coppa_compliance.pdf)
- Current Battlefy assets contain a dedicated Children's Privacy Policy route and parental-consent language, but the accessible policy pages were client-rendered shells. No claim is made that the older card flow remains live in 2026. — [Battlefy Privacy](https://battlefy.com/policies/privacy-policy), [Children's Privacy route](https://battlefy.com/policies/childrens-privacy-policy)

### Inferences
- For Tournova now, describe the implemented teen flow honestly as the user's statement of permission. A later parent action through a separate invitation/email and recorded parent account would provide stronger evidence and a usable adult contact, but should still not be labelled verified parental consent without designing and validating the required verification method.
- Do not copy an esports platform's publicity licence, parental liability wording, or payment-based verification as if it were automatically appropriate for a free Iowa sports console.

### Gaps
- Battlefy is not recommended as a main current comparison because the detailed operational source is historical. Challonge and start.gg are the main examples.
- No live signup was submitted and no account was created in this research. Observations concern official current policy/help and published page assets, not end-to-end successful registrations.
