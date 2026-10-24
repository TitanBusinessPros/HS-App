# Homesteader project memory

This file records decisions and current state for future work. Keep it in sync with the app and the locally maintained README. Do not put service account credentials, private keys, or other secrets here.

## Product decisions

- Homesteader is a private applicant review app for a homestead. It is based on earlier software, but has no games, towns, public profiles, business directory, paid items, chat rooms, private member-to-member chat, or daily rewards.
- Applicants sign in with Google only. They can create a private profile with up to three photos, an optional website, and up to three social media links; complete a 30-question questionnaire; and select homestead skills from a catalog that admins can expand. Website and social links are HTTPS and visible as clickable links to admins.
- For each selected skill, an applicant enters years of experience in half-year increments and the company, organization, or homestead where the skill was gained. These are self-reported claims, not verified credentials. Admins can add skills under an existing or new category from the private profiles page.
- Admins can see applicant profiles privately in alphabetical order, 25 per page. They can also select a skill to see applicants ranked by reported years, with names breaking ties. The ranking includes the reported organization for follow-up.
- At most 500 applicant profiles may exist at once. This counts saved `users/{uid}` documents, not Google sign-ins. Existing applicants can edit their profiles at capacity; an admin must delete a profile to free a place for a new applicant. The count is managed in a Firestore transaction using `applicationStats/main` and is initialized from existing profiles if needed.
- Applicants can reply in their private inbox only after an admin contacts them. Admins can invite an applicant to a phone, in-person, or Zoom interview with a date and time; the invitation opens a conversation if needed. The applicant sees the invitation on their profile and can reply in the existing inbox. The inbox identifies the current contact admin, and all admins with access can review the thread. Admins can reschedule or cancel an interview. Admins do not need applicant profiles. Admins can set review status and block accounts or delete profiles.
- Signed-in applicants can view `homestead.html`. Admins edit that page with a homestead name, up to 2,000 words of description, suggested details (location area, acreage, structures, rent or work trade, current residents, maximum residents), removable or custom topics, and up to 20 photos.
- `titanbusinesspros@gmail.com` and `pollysfarmok@gmail.com` are the current admin accounts. Admin access is based on each signed-in account's Firebase UID in `admins/{uid}`, not on an email field in a profile.

## Services and deployment

- Repository: https://github.com/TitanBusinessPros/HS-App (`main`). GitHub Actions publishes `public/` to https://titanbusinesspros.github.io/HS-App/ after pushes.
- Firebase project: `homesteader-f8693`. Firestore and Cloud Functions use `us-west2`.
- Firebase Authentication uses Google sign-in. The frontend uses reCAPTCHA Enterprise App Check; the key is registered for `titanbusinesspros.github.io`. App Check is enforced for Authentication, Firestore, and all callable functions. The App Check token TTL is one hour. No reCAPTCHA Classic secret key is required.
- Cloud Functions are in `functions/index.js`: `saveProfile`, `saveQuestionnaire`, `saveSkills`, `addSkill`, `sendMessage`, `setReviewStatus`, `manageInterview`, `manageApplicant`, `saveHomesteadPage`, `addHomesteadPhoto`, and `deleteHomesteadPhoto`. Firestore access rules are in `firestore.rules`.
- Firebase Storage is unused; applicant photos are stored in private Firestore profile documents and homestead photos in separate `homesteadPhotos/{id}` documents. Storage rules deny client reads and writes.
- The built-in skills and their numeric IDs are in `public/skills.js`. Preserve these IDs because saved skill records and ranking paths use them. Admin-added skills are in Firestore `skillCatalog/{skillId}` and use stable `custom_` IDs. The picker and ranking menu subscribe to this catalog.
- Private skill records are at `skills/{uid}`. Admin-only ranking entries are at `skillRankings/{skillId}/applicants/{uid}`. Direct client writes are denied; `saveSkills` validates and moderates entries before writing them.
- Profile photos are limited to three and may be changed once every 30 days. Google Cloud Vision SafeSearch screens photos. Google Cloud Natural Language screens profile text, messages, and skill organization text. Automated moderation still needs admin review.
- Homestead content is stored in `homesteadPage/main`; photos are stored separately to keep the page document small. Only admins can update them through App Check protected callable functions. Signed-in applicants can read the page and its photos once an admin saves the page. Homestead photos are screened with Vision SafeSearch, and page text with Natural Language moderation.

## Current verification state

- The original skill feature was pushed in commit `052c889`. The later admin-added catalog uses the deployed `addSkill` function, updated `saveSkills` and `manageApplicant` functions, and Firestore rules for `skillCatalog` reads.
- The 500-profile cap and interview invitation flow were pushed in commit `c931585`. `saveProfile`, `manageApplicant`, `sendMessage`, and the new `manageInterview` function were deployed to Firebase; the matching GitHub Pages publish succeeded.
- A signed-in, end-to-end walkthrough of applicant skill saving and admin rankings has not yet been completed. The same applies to photo upload and messaging.
- A signed-in, end-to-end walkthrough of the interview invitation and reply flow has not yet been completed.
- Keep the GitHub repository's tracked `README.md` empty. Maintain the full `README.md` only in the local project folder; never stage or push its local content. Push app and project-memory changes to the GitHub repository as requested by the project owner.
