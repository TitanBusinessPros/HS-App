import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import vision from '@google-cloud/vision';
import language from '@google-cloud/language';

initializeApp();
const db = getFirestore();
const auth = getAuth();
let visionClient;
let languageClient;
const options = { region: 'us-west2', enforceAppCheck: true, maxInstances: 10, memory: '512MiB' };
const photoPattern = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const monthMs = 30 * 24 * 60 * 60 * 1000;
const reviewStatuses = new Set(['submitted', 'reviewing', 'good-fit', 'declined']);

function caller(request) {
  const user = request.auth;
  if (!user || user.token.firebase?.sign_in_provider !== 'google.com') {
    throw new HttpsError('unauthenticated', 'Sign in with Google to continue.');
  }
  return user;
}

function invalid(message) {
  throw new HttpsError('invalid-argument', message);
}

async function checkText(text) {
  try {
    languageClient ??= new language.v2.LanguageServiceClient();
    const [result] = await languageClient.moderateText({ document: { content: text, type: 'PLAIN_TEXT' } });
    if (!result?.moderationCategories?.length) throw new Error('No moderation result');
    if (result.moderationCategories.some(category =>
      (category.name === 'Profanity' || category.name === 'Derogatory') && Number(category.confidence) >= 0.5
    )) {
      throw new HttpsError('invalid-argument', 'Please remove profanity or hateful language.');
    }
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('Text moderation unavailable', error);
    throw new HttpsError('unavailable', 'Text screening is temporarily unavailable. Please try again later.');
  }
}

async function checkPhotos(photos) {
  for (const photo of photos) {
    try {
      const [, base64] = photo.match(photoPattern);
      visionClient ??= new vision.ImageAnnotatorClient();
      const [result] = await visionClient.safeSearchDetection({ image: { content: Buffer.from(base64, 'base64') } });
      const safe = result?.safeSearchAnnotation;
      const level = value => typeof value === 'number' ? value : ({ VERY_UNLIKELY: 1, UNLIKELY: 2, POSSIBLE: 3, LIKELY: 4, VERY_LIKELY: 5 })[value] ?? null;
      if (!safe) throw new Error('No image moderation result');
      if (level(safe.adult) === null || level(safe.racy) === null || level(safe.adult) === 0 || level(safe.racy) === 0) throw new Error('Image could not be classified');
      if (level(safe.adult) >= 3 || level(safe.racy) >= 4) {
        throw new HttpsError('invalid-argument', 'One of your photos may contain nudity. Please choose another.');
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error('Image moderation unavailable', error);
      throw new HttpsError('unavailable', 'Image screening is temporarily unavailable. Please try again later.');
    }
  }
}

function validPhotos(value) {
  if (!Array.isArray(value) || value.length > 3 || value.some(photo =>
    typeof photo !== 'string' || photo.length > 200000 || !photoPattern.test(photo)
  )) invalid('Choose no more than three JPG photos.');
  return value;
}

function cleanProfile(value) {
  const profile = value?.profile;
  const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  const location = typeof profile?.location === 'string' ? profile.location.trim() : '';
  const bio = typeof value?.bio === 'string' ? value.bio.trim() : '';
  if (typeof name !== 'string' || !name || name.length > 40 || typeof location !== 'string' || location.length > 100 || typeof bio !== 'string' || !bio || bio.length > 6000 || bio.split(/\s+/).length > 500) {
    invalid('Add a name and an introduction of no more than 500 words.');
  }
  return { profile: { name, location }, bio, photos: validPhotos(value.photos) };
}

function assertActive(transaction, uid) {
  return transaction.get(db.doc(`blockedUsers/${uid}`)).then(snapshot => {
    if (snapshot.exists) throw new HttpsError('permission-denied', 'This account has been blocked.');
  });
}

export const saveProfile = onCall(options, async request => {
  const user = caller(request);
  const data = cleanProfile(request.data);
  const account = db.doc(`users/${user.uid}`);
  const previous = await account.get();
  const old = previous.data();
  const oldPhotos = old?.photos || (old?.photoDataUrl ? [old.photoDataUrl] : []);
  const newPhotos = data.photos;
  await checkText(`${data.profile.name}\n${data.profile.location}\n${data.bio}`);
  if (newPhotos.length) await checkPhotos(newPhotos);
  const now = Timestamp.now();
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, current] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(account)
    ]);
    if (admin.exists) throw new HttpsError('permission-denied', 'Admins do not need applicant profiles.');
    const before = current.data();
    const previousPhotos = before?.photos || (before?.photoDataUrl ? [before.photoDataUrl] : []);
    if (JSON.stringify(oldPhotos) !== JSON.stringify(previousPhotos)) {
      throw new HttpsError('aborted', 'Your photos changed. Refresh and try again.');
    }
    const photosChanged = JSON.stringify(previousPhotos) !== JSON.stringify(newPhotos);
    const lastChange = before?.photoChangedAt?.toMillis?.();
    if (photosChanged && previousPhotos.length && lastChange && now.toMillis() - lastChange < monthMs) {
      throw new HttpsError('failed-precondition', 'Photos can only be changed once every 30 days.');
    }
    const update = {
      ...data,
      email: user.token.email || '',
      status: 'submitted',
      updatedAt: now,
      photoChangedAt: photosChanged ? now : (before?.photoChangedAt || (newPhotos.length ? now : null))
    };
    if (current.exists) transaction.update(account, { ...update, reviewedAt: FieldValue.delete(), photoDataUrl: FieldValue.delete() });
    else transaction.create(account, { ...update, createdAt: now });
    transaction.set(db.doc(`applicantSummaries/${user.uid}`), {
      name: data.profile.name,
      location: data.profile.location,
      email: user.token.email || '',
      status: 'submitted',
      updatedAt: now
    }, { merge: true });
  });
  return { saved: true };
});

export const sendMessage = onCall(options, async request => {
  const user = caller(request);
  const text = typeof request.data?.text === 'string' ? request.data.text.trim() : '';
  const targetUid = request.data?.targetUid;
  if (typeof text !== 'string' || !text || text.length > 2000 || typeof targetUid !== 'string' || !targetUid || targetUid.includes('/')) invalid('Enter a message and choose an applicant.');
  await checkText(text);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const admin = await transaction.get(db.doc(`admins/${user.uid}`));
    const isAdmin = admin.exists;
    if (!isAdmin && targetUid !== user.uid) throw new HttpsError('permission-denied', 'You can only reply in your own inbox.');
    const [blocked, applicant] = await Promise.all([
      transaction.get(db.doc(`blockedUsers/${targetUid}`)), transaction.get(db.doc(`users/${targetUid}`))
    ]);
    if (blocked.exists || !applicant.exists) throw new HttpsError('failed-precondition', 'This applicant is unavailable.');
    const conversation = db.doc(`conversations/${targetUid}`);
    const existing = await transaction.get(conversation);
    if (!isAdmin && !existing.exists) throw new HttpsError('permission-denied', 'An admin must start the conversation.');
    const message = conversation.collection('messages').doc();
    if (!existing.exists) transaction.create(conversation, { participantUid: targetUid, openedBy: user.uid, openedAt: FieldValue.serverTimestamp(), firstMessageId: message.id });
    transaction.create(message, { senderUid: user.uid, senderRole: isAdmin ? 'admin' : 'member', text, createdAt: FieldValue.serverTimestamp() });
  });
  return { sent: true };
});

export const setReviewStatus = onCall(options, async request => {
  const user = caller(request);
  const uid = request.data?.uid;
  const status = request.data?.status;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || !reviewStatuses.has(status)) invalid('Choose an applicant and a valid status.');
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    if (!(await transaction.get(db.doc(`admins/${user.uid}`))).exists) throw new HttpsError('permission-denied', 'Admin access required.');
    const applicant = db.doc(`users/${uid}`);
    const profile = await transaction.get(applicant);
    if (!profile.exists) throw new HttpsError('not-found', 'Profile not found.');
    transaction.update(applicant, { status, reviewedAt: FieldValue.serverTimestamp() });
    transaction.set(db.doc(`applicantSummaries/${uid}`), {
      name: profile.data().profile?.name || 'Unnamed',
      location: profile.data().profile?.location || '',
      email: profile.data().email || '',
      status,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return { saved: true };
});

export const manageApplicant = onCall(options, async request => {
  const user = caller(request);
  const uid = request.data?.uid;
  const action = request.data?.action;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid === user.uid || !['block', 'delete', 'unblock'].includes(action)) invalid('Choose an applicant and an action.');
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, targetAdmin, profile, skillRecord] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`admins/${uid}`)),
      transaction.get(db.doc(`users/${uid}`)),
      transaction.get(db.doc(`skills/${uid}`))
    ]);
    if (!admin.exists || targetAdmin.exists) throw new HttpsError('permission-denied', 'Admin access required.');
    const blocked = db.doc(`blockedUsers/${uid}`);
    if (action === 'unblock') transaction.delete(blocked);
    else {
      transaction.set(blocked, { email: profile.data()?.email || '', blockedBy: user.uid, blockedAt: FieldValue.serverTimestamp() });
      if (action === 'delete') {
        if (profile.exists) transaction.delete(profile.ref);
        transaction.delete(db.doc(`applicantSummaries/${uid}`));
        transaction.delete(db.doc(`questionnaires/${uid}`));
        transaction.delete(db.doc(`skills/${uid}`));
        for (const entry of skillRecord.data()?.entries || []) {
          if (Number.isInteger(entry.id) && entry.id >= 0 && entry.id < 100) {
            transaction.delete(db.doc(`skillRankings/${entry.id}/applicants/${uid}`));
          }
        }
      }
    }
  });
  try {
    await auth.updateUser(uid, { disabled: action !== 'unblock' });
  } catch (error) {
    console.error('Firebase Auth account update failed; Firestore block remains enforced', error);
  }
  if (action === 'delete') {
    try { await db.recursiveDelete(db.doc(`conversations/${uid}`)); }
    catch (error) { console.error('Conversation cleanup failed', error); }
  }
  return { done: true };
});

export const saveQuestionnaire = onCall(options, async request => {
  const user = caller(request);
  const answers = request.data?.answers;
  if (!Array.isArray(answers) || answers.length !== 30 ||
      answers.some(answer => !Number.isInteger(answer) || answer < 0 || answer > 3)) {
    invalid('Answer all 30 questions before submitting.');
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, profile] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`users/${user.uid}`))
    ]);
    if (admin.exists || !profile.exists) throw new HttpsError('failed-precondition', 'Save your applicant profile before taking the questionnaire.');
    transaction.set(db.doc(`questionnaires/${user.uid}`), {
      version: 1,
      answers,
      submittedAt: FieldValue.serverTimestamp()
    });
    transaction.set(db.doc(`applicantSummaries/${user.uid}`), {
      name: profile.data().profile?.name || 'Unnamed',
      location: profile.data().profile?.location || '',
      email: profile.data().email || '',
      status: profile.data().status || 'submitted',
      questionnaireCompletedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return { saved: true };
});

export const saveSkills = onCall(options, async request => {
  const user = caller(request);
  const raw = request.data?.entries;
  if (!Array.isArray(raw) || raw.length > 100) invalid('Choose up to 100 homestead skills.');
  const seen = new Set();
  const entries = raw.map(item => {
    const id = item?.id;
    const years = item?.years;
    const organization = typeof item?.organization === 'string' ? item.organization.trim() : '';
    if (!Number.isInteger(id) || id < 0 || id >= 100 || seen.has(id) ||
        typeof years !== 'number' || !Number.isFinite(years) || years < 0 || years > 80 ||
        !Number.isInteger(years * 2) || organization.length < 2 || organization.length > 120) {
      invalid('Add valid years and a company, organization, or homestead for each selected skill.');
    }
    seen.add(id);
    return { id, years, organization };
  });
  for (let index = 0; index < entries.length; index += 10) {
    await checkText(entries.slice(index, index + 10).map(entry =>
      `${entry.organization} is the company or homestead for this skill.`
    ).join('\n'));
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const skillDoc = db.doc(`skills/${user.uid}`);
    const [admin, profile, previous] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`users/${user.uid}`)),
      transaction.get(skillDoc)
    ]);
    if (admin.exists || !profile.exists) throw new HttpsError('failed-precondition', 'Save your applicant profile before adding skills.');
    const currentIds = new Set(entries.map(entry => entry.id));
    for (const old of previous.data()?.entries || []) {
      if (Number.isInteger(old.id) && old.id >= 0 && old.id < 100 && !currentIds.has(old.id)) {
        transaction.delete(db.doc(`skillRankings/${old.id}/applicants/${user.uid}`));
      }
    }
    for (const entry of entries) {
      transaction.set(db.doc(`skillRankings/${entry.id}/applicants/${user.uid}`), {
        years: entry.years,
        organization: entry.organization,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    transaction.set(skillDoc, { version: 1, entries, updatedAt: FieldValue.serverTimestamp() });
    transaction.set(db.doc(`applicantSummaries/${user.uid}`), {
      name: profile.data().profile?.name || 'Unnamed',
      location: profile.data().profile?.location || '',
      email: profile.data().email || '',
      status: profile.data().status || 'submitted',
      skillCount: entries.length
    }, { merge: true });
  });
  return { saved: true };
});
