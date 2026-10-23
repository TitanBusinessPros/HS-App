# Homesteader

Homesteader is a private introduction and messaging app. It uses a **separate Firebase project**. There is no public profile directory, town membership, games, chat rooms, payments, daily rewards, or member initiated messaging.

Applicants sign in with Google and save a display name, optional location, introduction, and private photo. Only the applicant and admins can read that profile. An admin can set a review status and send the first message. The applicant can reply only after that conversation exists. Firestore rules require Google authentication, and admin access is granted through `admins/{uid}` documents.

## Firebase setup

The Web app configuration for project `homesteader-f8693` is already in `public/firebase-config.js`. The Cloud Firestore `(default)` database is in `us-west2` (Los Angeles), and this repository's rules have been deployed. Firebase Authentication has Google enabled, Email/Password disabled, and `titanbusinesspros.github.io` authorized. Firebase Storage is set up, but this version does not use it: resized photos are saved inside private Firestore profile documents, with a 200 KB encoded limit.

When you change `firestore.rules`, deploy the updated rules from this `HS-App` directory:

```powershell
firebase login
firebase deploy --project homesteader-f8693 --only firestore:rules
```

If you later use a custom domain for GitHub Pages, add it under **Authentication → Settings → Authorized domains**. The `authDomain` in `firebase-config.js` stays `homesteader-f8693.firebaseapp.com` for the Google popup flow.

The `measurementId` from Firebase is present in the config. Analytics is not initialized by this app.

## GitHub Pages

The local Git repository points to `https://github.com/TitanBusinessPros/HS-App`. The `.github/workflows/pages.yml` workflow publishes the `public` folder on pushes to `main`; no Firebase Hosting deployment is needed. The expected project Pages URL is `https://titanbusinesspros.github.io/HS-App/` unless you set a custom domain.

GitHub Pages serves the app files publicly. Firestore rules control who can read profiles and messages. Keep service account keys and any other secrets out of this repository.

To publish future changes after reviewing them:

```powershell
git add .
git commit -m "Update Homesteader"
git push origin main
```

Fetch and integrate remote commits before pushing if other people have changed the repository.

## First admin

1. Open the published site and use **Continue with Google** for the first admin.
2. In Firebase Authentication, copy that account's **UID**. In Firestore, create a collection named `admins`, then a document whose ID is **exactly that UID**. Give it a field such as `name: "Admin"`.
3. Sign out and back in. The admin workspace will appear. Create a separate applicant account to submit a profile, then the admin can open a conversation with it.

## Data layout

- `users/{uid}`: private applicant profile and admin review status.
- `admins/{uid}`: admin allowlist, created using trusted Firebase access.
- `conversations/{applicantUid}`: created only by an admin.
- `conversations/{applicantUid}/messages/{messageId}`: admin and applicant messages.

The rules default to denying every other collection. This code is designed for a fresh Firebase project; it does not migrate or delete data from another project.
