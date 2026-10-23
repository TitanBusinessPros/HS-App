import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import vision from '@google-cloud/vision';
import language from '@google-cloud/language';

initializeApp();
const db = getFirestore();
const auth = getAuth();
const visionClient = new vision.ImageAnnotatorClient();
const languageClient = new language.v2.LanguageServiceClient();
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
    if (!(await transaction.get(applicant)).exists) throw new HttpsError('not-found', 'Profile not found.');
    transaction.update(applicant, { status, reviewedAt: FieldValue.serverTimestamp() });
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
    const [admin, targetAdmin, profile] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(db.doc(`admins/${uid}`)), transaction.get(db.doc(`users/${uid}`))
    ]);
    if (!admin.exists || targetAdmin.exists) throw new HttpsError('permission-denied', 'Admin access required.');
    const blocked = db.doc(`blockedUsers/${uid}`);
    if (action === 'unblock') transaction.delete(blocked);
    else {
      transaction.set(blocked, { email: profile.data()?.email || '', blockedBy: user.uid, blockedAt: FieldValue.serverTimestamp() });
      if (action === 'delete' && profile.exists) transaction.delete(profile.ref);
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
