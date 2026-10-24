# Homesteader

Homesteader is a private introduction and messaging app for a homestead team. Applicants sign in with Google, create a private profile, complete a 30-question homesteading questionnaire, and can reply in their inbox if an admin contacts them. Admins can review profiles, questionnaire answers, and conversations; change review status; start conversations; block accounts; and delete profiles. Admins do not need applicant profiles. The app has no games, towns, public profile directory, chat rooms, payments, or daily rewards.

## Live project

- Website: https://titanbusinesspros.github.io/HS-App/
- Source: https://github.com/TitanBusinessPros/HS-App
- Firebase project: `homesteader-f8693`
- Firestore database and Cloud Functions region: `us-west2`
- GitHub Actions publishes the `public` folder from `main` to GitHub Pages.
- Applicant questionnaire: `questionnaire.html`. Private admin profiles: `profiles.html`.

The public Firebase configuration and reCAPTCHA Enterprise site key are in `public/firebase-config.js`. Neither is a secret. Do not commit service account credentials or any other private keys. Analytics is not initialized.

## Admin accounts

`titanbusinesspros@gmail.com` and `pollysfarmok@gmail.com` are admins. Both Google accounts have signed in, and each Firebase Authentication UID has an `admins/{uid}` document in Firestore. The admin workspace opens directly when either account signs in. Admins do not need applicant profiles.

Additional admins must first sign in with Google, then receive an `admins/{uid}` document through trusted Firebase access. Do not grant admin rights by putting an email address in an applicant profile.

## App Check and reCAPTCHA Enterprise

The web app uses the score-based reCAPTCHA Enterprise provider for Firebase App Check. The key is registered for `titanbusinesspros.github.io`. **No reCAPTCHA Classic secret key is needed.** In Firebase Console, the App Check token time to live (TTL) is **1 hour**, the recommended default. The SDK refreshes tokens automatically. The App Check risk threshold is 0.5.

App Check enforcement is enabled for Firebase Authentication and Cloud Firestore. All four callable Cloud Functions also require App Check. Firebase Storage is unused; its deployed rules deny all client reads and writes. If a custom domain is added, add it to the reCAPTCHA Enterprise key's allowed domains and to Firebase Authentication's authorized domains.

## Profiles and security

- Applicants can save a name, optional location, introduction, and up to three private photos. Source files may be JPG, PNG, or WebP; the browser resizes and converts them to JPEG before upload. Each encoded photo is limited to 200 KB.
- Photo thumbnails show the complete image. Hovering or focusing a thumbnail shows a preview three times its size, positioned to stay inside the browser window.
- A photo set can be changed once every 30 days. The first photo addition is allowed when the profile has none. The limit is enforced in `saveProfile`, including photo removal and replacement.
- Photos are stored inside private Firestore `users/{uid}` documents. Firestore rules allow an applicant to read only their own profile; admins can read applicant profiles. Direct client writes are denied.
- The private admin page lists lightweight applicant summaries alphabetically, shows 25 per page, and loads full profiles only when selected. The questionnaire link is on each applicant's profile. Answers are stored separately and visible only to that applicant and admins.
- The `saveProfile` function screens photos using Google Cloud Vision SafeSearch and screens profile text using Google Cloud Natural Language moderation. `sendMessage` screens message text. The services reject content classified as adult/racy or profanity/derogatory at the configured thresholds and fail closed when screening is unavailable. Automated screening can make mistakes; admins should still review submissions.
- An admin must send the first message. An applicant can then reply only in their own conversation. There is no member-to-member messaging.
- Blocking creates `blockedUsers/{uid}`, which Firestore rules and callable functions enforce. The function also attempts to disable that Firebase Authentication account. Deleting a profile blocks the UID, removes the profile, and attempts conversation cleanup. This prevents that Google account from returning; a different Google account requires a separate abuse response.

Cloud Functions are in `functions/index.js`: `saveProfile`, `saveQuestionnaire`, `sendMessage`, `setReviewStatus`, and `manageApplicant`. They are deployed to `us-west2` with `enforceAppCheck: true`. Firestore rules are in `firestore.rules` and are deployed. No signed-in, end-to-end upload or messaging test has been completed yet.

## Data layout

- `users/{uid}`: private applicant profile and review status.
- `applicantSummaries/{uid}`: small admin-only list entry without photos.
- `questionnaires/{uid}`: applicant's 30 answers and submission time.
- `admins/{uid}`: trusted admin allowlist.
- `blockedUsers/{uid}`: blocked Firebase Authentication UIDs.
- `conversations/{applicantUid}` and its `messages` subcollection: one private applicant/admin conversation.

All other Firestore paths are denied by default. The separate Firebase project does not migrate or delete data from the previous software.

## Deployment

To deploy Firestore rules or Functions from this folder after making changes:

```powershell
firebase deploy --project homesteader-f8693 --only firestore:rules
firebase deploy --project homesteader-f8693 --only functions
```

Push application code and documentation changes to `main` so the GitHub repository stays current. Stage the files you changed and review them before committing.
