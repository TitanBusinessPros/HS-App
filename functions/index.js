import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import vision from '@google-cloud/vision';
import language from '@google-cloud/language';
import { createHash } from 'node:crypto';
import { createCalendarBooking, bookingLockRefs, calendarRevisionRef, intervalsOverlap } from './calendar-booking.js';
import { normalizeAdminEmail, verifiedGoogleEmail } from './admin-invite.js';
import { mergeSharedSkillEntries } from './shared-ranking.js';

initializeApp();
const db = getFirestore();
const auth = getAuth();
let visionClient;
let languageClient;
const options = { region: 'us-west2', enforceAppCheck: true, maxInstances: 10, memory: '512MiB' };
const photoPattern = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const monthMs = 30 * 24 * 60 * 60 * 1000;
const reviewStatuses = new Set(['submitted', 'reviewing', 'good-fit', 'declined']);
const customSkillPattern = /^custom_[a-f0-9]{32}$/;
const applicationLimit = 10000;
const applicationStatsRef = db.doc('applicationStats/main');
const masterAdminEmail = 'titanbusinesspros@gmail.com';
const primaryCompanyId = 'titan';

function companyIdOf(admin) {
  return admin?.data()?.companyId || primaryCompanyId;
}

function companyPath(companyId, path) {
  return companyId === primaryCompanyId ? path : `companies/${companyId}/${path}`;
}

function companyDoc(companyId, path) { return db.doc(companyPath(companyId, path)); }
function companyCollection(companyId, path) { return db.collection(companyPath(companyId, path)); }
function applicationRef(companyId, uid) {
  return companyDoc(companyId, companyId === primaryCompanyId ? `users/${uid}` : `applications/${uid}`);
}
function companySummaryRef(companyId, uid) { return companyDoc(companyId, `applicantSummaries/${uid}`); }

function directoryEntry(profile) {
  return {
    name: profile.profile?.name || 'Unnamed', location: profile.profile?.location || '',
    email: profile.email || '', updatedAt: profile.updatedAt || FieldValue.serverTimestamp()
  };
}

async function requestedCompanyId(value) {
  const companyId = value || primaryCompanyId;
  if (companyId === primaryCompanyId) return companyId;
  if (typeof companyId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(companyId)) invalid('Choose a homestead company.');
  const company = await db.doc(`companies/${companyId}`).get();
  if (!company.exists || company.data().active === false) throw new HttpsError('not-found', 'This homestead company is unavailable.');
  return companyId;
}

async function companyAdmin(user) {
  const [blocked, admin] = await Promise.all([
    db.doc(`blockedUsers/${user.uid}`).get(), db.doc(`admins/${user.uid}`).get()
  ]);
  if (blocked.exists || !admin.exists) throw new HttpsError('permission-denied', 'Admin access required.');
  const companyId = companyIdOf(admin);
  if (companyId !== primaryCompanyId) await requestedCompanyId(companyId);
  return { companyId, owner: companyId === primaryCompanyId ? hasMasterEmail(user) : admin.data().role === 'owner' };
}

async function companyOwner(user) {
  const context = await companyAdmin(user);
  if (!context.owner) throw new HttpsError('permission-denied', 'Company owner access required.');
  if (context.companyId === primaryCompanyId) await assertMasterAdmin(user);
  else {
    const company = await db.doc(`companies/${context.companyId}`).get();
    if (company.data()?.ownerUid !== user.uid) throw new HttpsError('permission-denied', 'Company owner access required.');
  }
  return context.companyId;
}

function companyInviteRef(email) {
  return db.doc(`companyInvites/${createHash('sha256').update(email).digest('hex')}`);
}

function adminInviteRef(email) {
  return db.doc(`adminInvites/${createHash('sha256').update(email).digest('hex')}`);
}

function hasMasterEmail(user) {
  return user.token.email?.toLowerCase() === masterAdminEmail;
}

async function assertMasterAdmin(user) {
  if (!hasMasterEmail(user)) throw new HttpsError('permission-denied', 'Master admin access required.');
  const [blocked, admin, account] = await Promise.all([
    db.doc(`blockedUsers/${user.uid}`).get(), db.doc(`admins/${user.uid}`).get(), auth.getUser(user.uid)
  ]);
  if (blocked.exists || !admin.exists || companyIdOf(admin) !== primaryCompanyId ||
      account.email?.toLowerCase() !== masterAdminEmail) {
    throw new HttpsError('permission-denied', 'Master admin access required.');
  }
}

export const listAdmins = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const [snapshot, inviteSnapshot] = await Promise.all([
    db.collection('admins').get(), db.collection('adminInvites').get()
  ]);
  const admins = await Promise.all(snapshot.docs.filter(document => companyIdOf(document) === companyId).map(async document => {
    try {
      const account = await auth.getUser(document.id);
      return { uid: document.id, email: account.email || '', name: account.displayName || '', master: document.id === user.uid };
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      return { uid: document.id, email: '', name: '', master: false };
    }
  }));
  return {
    admins: admins.sort((a, b) => Number(b.master) - Number(a.master) || a.email.localeCompare(b.email)),
    pending: inviteSnapshot.docs.filter(document => (document.data().companyId || primaryCompanyId) === companyId)
      .map(document => document.data().email).filter(Boolean).sort()
  };
});

export const addAdminEmail = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const email = normalizeAdminEmail(request.data?.email);
  if (!email || email === masterAdminEmail) invalid('Enter another admin’s valid Google email address.');
  let targetAccount;
  try { targetAccount = await auth.getUserByEmail(email); }
  catch (error) {
    if (error.code === 'auth/invalid-email') invalid('Enter a valid Google email address.');
    if (error.code !== 'auth/user-not-found') throw error;
  }
  if (targetAccount?.disabled) throw new HttpsError('failed-precondition', 'This account is disabled. Enable it before adding admin access.');
  const inviteRef = adminInviteRef(email);
  const result = await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [owner, invite, targetAdmin, targetBlocked, companyInvite] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(inviteRef),
      targetAccount ? transaction.get(db.doc(`admins/${targetAccount.uid}`)) : Promise.resolve(null),
      targetAccount ? transaction.get(db.doc(`blockedUsers/${targetAccount.uid}`)) : Promise.resolve(null),
      transaction.get(companyInviteRef(email))
    ]);
    if (!owner.exists || companyIdOf(owner) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : owner.data().role !== 'owner')) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    if (companyInvite.exists) throw new HttpsError('already-exists', 'This email is already invited to own a homestead company.');
    if (targetBlocked?.exists) throw new HttpsError('failed-precondition', 'Unblock this account before adding admin access.');
    if (targetAdmin?.exists) {
      if (companyIdOf(targetAdmin) === companyId) {
        if (invite.exists) transaction.delete(inviteRef);
        return { state: 'active' };
      }
      throw new HttpsError('already-exists', 'This account already belongs to another homestead company.');
    }
    if (invite.exists) {
      if ((invite.data().companyId || primaryCompanyId) !== companyId) {
        throw new HttpsError('already-exists', 'This email is already invited to another homestead company.');
      }
      return { state: 'pending' };
    }
    transaction.create(inviteRef, { email, companyId, createdBy: user.uid, createdAt: FieldValue.serverTimestamp() });
    return { state: 'added' };
  });
  return result;
});

export const cancelAdminEmail = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const email = normalizeAdminEmail(request.data?.email);
  if (!email || email === masterAdminEmail) invalid('Choose a pending admin email to remove.');
  const inviteRef = adminInviteRef(email);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [owner, invite] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(inviteRef)
    ]);
    if (!owner.exists || companyIdOf(owner) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : owner.data().role !== 'owner')) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    if (!invite.exists || invite.data().email !== email ||
        (invite.data().companyId || primaryCompanyId) !== companyId) {
      throw new HttpsError('not-found', 'This pending admin was already removed.');
    }
    transaction.delete(inviteRef);
  });
  return { removed: true };
});

export const claimAdminEmail = onCall(options, async request => {
  const user = caller(request);
  const candidate = normalizeAdminEmail(user.token.email);
  if (!candidate || user.token.email_verified !== true) return { admin: false };
  const inviteRef = adminInviteRef(candidate);
  if (!(await inviteRef.get()).exists) return { admin: false };
  const account = await auth.getUser(user.uid);
  const email = verifiedGoogleEmail(user, account);
  if (email !== candidate) throw new HttpsError('permission-denied', 'Sign in with the invited Google account.');
  return db.runTransaction(async transaction => {
    const [blocked, admin, invite] = await Promise.all([
      transaction.get(db.doc(`blockedUsers/${user.uid}`)),
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(inviteRef)
    ]);
    if (blocked.exists) throw new HttpsError('permission-denied', 'This account has been blocked.');
    if (admin.exists) {
      if (invite.exists && companyIdOf(admin) !== (invite.data().companyId || primaryCompanyId)) {
        throw new HttpsError('already-exists', 'This account already belongs to another homestead company.');
      }
      if (invite.exists) transaction.delete(inviteRef);
      return { admin: true, companyId: companyIdOf(admin) };
    }
    if (!invite.exists || invite.data().email !== email) return { admin: false };
    const companyId = invite.data().companyId || primaryCompanyId;
    if (companyId !== primaryCompanyId) {
      const company = await transaction.get(db.doc(`companies/${companyId}`));
      if (!company.exists || company.data().active === false) throw new HttpsError('failed-precondition', 'This homestead company is unavailable.');
    }
    transaction.create(db.doc(`admins/${user.uid}`), {
      email, companyId, role: 'admin', invitedBy: invite.data().createdBy, createdAt: FieldValue.serverTimestamp()
    });
    transaction.delete(inviteRef);
    return { admin: true, companyId };
  });
});

export const listCompanies = onCall(options, async request => {
  const user = caller(request);
  await assertMasterAdmin(user);
  const [companies, invitations] = await Promise.all([
    db.collection('companies').get(), db.collection('companyInvites').get()
  ]);
  return {
    companies: companies.docs.map(document => ({ id: document.id, name: document.data().name || 'Homestead company',
      ownerEmail: document.data().ownerEmail || '', listed: document.data().listed === true })),
    pending: invitations.docs.map(document => document.data().email).filter(Boolean).sort()
  };
});

function masterCompanyId(value) {
  if (value === primaryCompanyId || (typeof value === 'string' && /^[A-Za-z0-9]{20}$/.test(value))) return value;
  invalid('Choose a homestead company.');
}

async function masterCompany(user, value) {
  await assertMasterAdmin(user);
  const companyId = masterCompanyId(value);
  if (companyId === primaryCompanyId) return { companyId, company: {
    name: 'Titan Business Pros', ownerEmail: masterAdminEmail, active: true, listed: true
  } };
  const snapshot = await db.doc(`companies/${companyId}`).get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'This homestead company no longer exists.');
  return { companyId, company: snapshot.data() };
}

function isoDate(value) { return value?.toDate?.()?.toISOString() || null; }

export const getCompanyAccountOverview = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const { companyId, company } = await masterCompany(user, request.data?.companyId);
  const [adminDocs, inviteDocs, config, catalog, page, photos, teams, applicantCount, interviews] = await Promise.all([
    db.collection('admins').get(), db.collection('adminInvites').get(),
    companyDoc(companyId, 'questionnaireConfig/main').get(),
    companyCollection(companyId, 'skillCatalog').get(),
    companyDoc(companyId, 'homesteadPage/main').get(),
    companyCollection(companyId, 'homesteadPhotos').get(),
    companyCollection(companyId, 'teams').get(),
    companyCollection(companyId, 'applicantSummaries').count().get(),
    companyCollection(companyId, 'applicantSummaries')
      .where('interviewAt', '>=', Timestamp.now()).orderBy('interviewAt').limit(25).get()
  ]);
  const admins = await Promise.all(adminDocs.docs.filter(document => companyIdOf(document) === companyId)
    .map(async document => {
      let email = document.data().email || '';
      if (!email) {
        try { email = (await auth.getUser(document.id)).email || ''; }
        catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
      }
      const availability = (await db.doc(`adminAvailability/${document.id}`).get()).data()?.availability || null;
      return { uid: document.id, email, role: companyId === primaryCompanyId && email.toLowerCase() === masterAdminEmail ?
        'owner' : document.data().role || 'admin', availability };
    }));
  const settings = config.data() || {};
  const homestead = page.data() || {};
  return {
    company: { id: companyId, name: company.name || 'Homestead company',
      ownerEmail: company.ownerEmail || (companyId === primaryCompanyId ? masterAdminEmail : ''), active: company.active !== false,
      listed: company.listed === true, createdAt: isoDate(company.createdAt) },
    admins: admins.sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || a.email.localeCompare(b.email)),
    pendingAdmins: inviteDocs.docs.filter(document => (document.data().companyId || primaryCompanyId) === companyId)
      .map(document => document.data().email).filter(Boolean).sort(),
    questionnaire: { enabled: settings.enabled !== false, revision: settings.revision || 0,
      questions: settings.questions || null },
    catalog: catalog.docs.map(document => ({ id: document.id, name: document.data().name || '',
      category: document.data().category || '', deleted: document.data().deleted === true })),
    homestead: { name: homestead.name || '', description: homestead.description || '',
      fields: homestead.fields || [], published: homestead.published === true,
      photos: photos.docs.map(document => ({ id: document.id, photo: document.data().photo || '' })) },
    teams: teams.docs.map(document => ({ id: document.id, name: document.data().name || 'Unnamed team' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    applicantCount: applicantCount.data().count,
    upcomingInterviews: interviews.docs.map(document => ({ uid: document.id,
      name: document.data().name || 'Applicant', mode: document.data().interviewMode || 'Interview',
      scheduledAt: isoDate(document.data().interviewAt) }))
  };
});

export const listCompanyAccountApplicants = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await masterCompany(user, request.data?.companyId);
  const cursor = request.data?.cursor || '';
  if (typeof cursor !== 'string' || cursor.includes('/') || cursor.length > 128) invalid('Refresh the applicant list.');
  let query = companyCollection(companyId, 'applicantSummaries').orderBy(FieldPath.documentId()).limit(26);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  return { applicants: snapshot.docs.slice(0, 25).map(document => ({ uid: document.id,
    name: document.data().name || 'Applicant', email: document.data().email || '',
    status: document.data().status || 'submitted', skillCount: document.data().skillCount || 0,
    questionnaireCompleted: Boolean(document.data().questionnaireCompletedAt),
    interviewAt: isoDate(document.data().interviewAt) })),
    nextCursor: snapshot.size > 25 ? snapshot.docs[24].id : null };
});

export const listCompanyAccountTeamMembers = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await masterCompany(user, request.data?.companyId);
  const teamId = request.data?.teamId;
  const cursor = request.data?.cursor || '';
  if (typeof teamId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(teamId) ||
      typeof cursor !== 'string' || cursor.includes('/') || cursor.length > 128) invalid('Choose a team.');
  const team = companyDoc(companyId, `teams/${teamId}`);
  if (!(await team.get()).exists) throw new HttpsError('not-found', 'This team no longer exists.');
  let query = team.collection('members').orderBy(FieldPath.documentId()).limit(26);
  if (cursor) query = query.startAfter(cursor);
  const members = await query.get();
  const shown = members.docs.slice(0, 25);
  const profiles = shown.length ? await db.getAll(...shown.map(document => db.doc(`applicantDirectory/${document.id}`))) : [];
  return { members: shown.map((document, index) => ({ uid: document.id,
    name: profiles[index]?.data()?.name || 'Applicant', email: profiles[index]?.data()?.email || '' })),
    nextCursor: members.size > 25 ? members.docs[24].id : null };
});

export const getCompanyAccountApplicant = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await masterCompany(user, request.data?.companyId);
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid.length > 128) invalid('Choose an applicant.');
  const conversation = companyDoc(companyId, `conversations/${uid}`);
  const [shared, application, questionnaire, skills, messages] = await Promise.all([
    db.doc(`users/${uid}`).get(), applicationRef(companyId, uid).get(),
    companyDoc(companyId, `questionnaires/${uid}`).get(), companyDoc(companyId, `skills/${uid}`).get(),
    conversation.collection('messages').orderBy('createdAt', 'desc').limit(100).get()
  ]);
  if (!shared.exists && !application.exists) throw new HttpsError('not-found', 'Applicant record unavailable.');
  const profile = shared.data() || {};
  const app = application.data() || {};
  const interview = app.interview || null;
  return {
    uid, profile: profile.profile || {}, email: profile.email || '', bio: profile.bio || '',
    photos: profile.photos || (profile.photoDataUrl ? [profile.photoDataUrl] : []),
    website: profile.website || '', socialLinks: profile.socialLinks || [],
    status: app.status || 'submitted',
    interview: interview ? { mode: interview.mode || '', source: interview.source || '',
      scheduledAt: isoDate(interview.scheduledAt), timeZoneLabel: interview.timeZoneLabel || '',
      note: interview.note || '', meetingLink: interview.meetingLink || '',
      contactAdminUid: interview.contactAdminUid || '' } : null,
    questionnaire: questionnaire.data() ? { questions: questionnaire.data().questions || null,
      answers: questionnaire.data().answers || [], submittedAt: isoDate(questionnaire.data().submittedAt) } : null,
    skills: skills.data()?.entries || [],
    messages: messages.docs.map(document => ({ senderRole: document.data().senderRole || '',
      text: document.data().text || '', createdAt: isoDate(document.data().createdAt) })).reverse()
  };
});

export const addCompanyEmail = onCall(options, async request => {
  const user = caller(request);
  await assertMasterAdmin(user);
  const email = normalizeAdminEmail(request.data?.email);
  if (!email || email === masterAdminEmail) invalid('Enter another person’s valid Google email address.');
  let account;
  try { account = await auth.getUserByEmail(email); }
  catch (error) {
    if (error.code === 'auth/invalid-email') invalid('Enter a valid Google email address.');
    if (error.code !== 'auth/user-not-found') throw error;
  }
  if (account?.disabled) throw new HttpsError('failed-precondition', 'This account is disabled.');
  const ref = companyInviteRef(email);
  return db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [master, invite, existingAdmin, pendingAdmin, targetBlocked] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(ref),
      account ? transaction.get(db.doc(`admins/${account.uid}`)) : Promise.resolve(null),
      transaction.get(adminInviteRef(email)),
      account ? transaction.get(db.doc(`blockedUsers/${account.uid}`)) : Promise.resolve(null)
    ]);
    if (!master.exists || !hasMasterEmail(user)) throw new HttpsError('permission-denied', 'Platform owner access required.');
    if (existingAdmin?.exists) throw new HttpsError('already-exists', 'This account already belongs to a homestead company.');
    if (pendingAdmin.exists) throw new HttpsError('already-exists', 'This email already has an admin invitation. Cancel it first.');
    if (targetBlocked?.exists) throw new HttpsError('failed-precondition', 'Unblock this account before inviting it.');
    if (invite.exists) return { state: 'pending' };
    transaction.create(ref, { email, createdBy: user.uid, createdAt: FieldValue.serverTimestamp() });
    return { state: 'added' };
  });
});

export const cancelCompanyEmail = onCall(options, async request => {
  const user = caller(request);
  await assertMasterAdmin(user);
  const email = normalizeAdminEmail(request.data?.email);
  if (!email) invalid('Choose a pending company email.');
  const ref = companyInviteRef(email);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [master, invite] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(ref)
    ]);
    if (!master.exists || !hasMasterEmail(user)) throw new HttpsError('permission-denied', 'Platform owner access required.');
    if (!invite.exists || invite.data().email !== email) throw new HttpsError('not-found', 'This company invitation is no longer pending.');
    transaction.delete(ref);
  });
  return { removed: true };
});

export const claimCompanyEmail = onCall(options, async request => {
  const user = caller(request);
  const candidate = normalizeAdminEmail(user.token.email);
  if (!candidate || user.token.email_verified !== true) return { claimed: false };
  const inviteRef = companyInviteRef(candidate);
  if (!(await inviteRef.get()).exists) return { claimed: false };
  const account = await auth.getUser(user.uid);
  const email = verifiedGoogleEmail(user, account);
  if (email !== candidate || account.disabled) throw new HttpsError('permission-denied', 'Sign in with the invited Google account.');
  const companyRef = db.collection('companies').doc();
  return db.runTransaction(async transaction => {
    const [blocked, existingAdmin, invite] = await Promise.all([
      transaction.get(db.doc(`blockedUsers/${user.uid}`)),
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(inviteRef)
    ]);
    if (blocked.exists) throw new HttpsError('permission-denied', 'This account has been blocked.');
    if (existingAdmin.exists) throw new HttpsError('already-exists', 'This account already belongs to a homestead company.');
    if (!invite.exists || invite.data().email !== email) return { claimed: false };
    transaction.create(companyRef, {
      name: 'Homestead company', ownerUid: user.uid, ownerEmail: email,
      active: true, listed: false, createdAt: FieldValue.serverTimestamp(), createdBy: invite.data().createdBy
    });
    transaction.create(db.doc(`admins/${user.uid}`), {
      companyId: companyRef.id, role: 'owner', email, createdAt: FieldValue.serverTimestamp()
    });
    transaction.delete(inviteRef);
    return { claimed: true, companyId: companyRef.id };
  });
});

export const saveCompanyProfile = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  if (companyId === primaryCompanyId) invalid('Titan Business Pros uses its existing homestead page.');
  const name = typeof request.data?.name === 'string' ? request.data.name.trim() : '';
  if (name.length < 2 || name.length > 100) invalid('Enter a company name between 2 and 100 characters.');
  await checkText(name);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const companyRef = db.doc(`companies/${companyId}`);
    const [admin, company] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(companyRef)
    ]);
    if (!admin.exists || company.data()?.ownerUid !== user.uid) throw new HttpsError('permission-denied', 'Company owner access required.');
    transaction.update(companyRef, { name, listed: true, updatedAt: FieldValue.serverTimestamp() });
    transaction.set(db.doc(`companyListings/${companyId}`), {
      name, active: true, updatedAt: FieldValue.serverTimestamp()
    });
  });
  return { saved: true };
});

export const removeAdmin = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid === user.uid) invalid('Choose another admin to remove.');
  let targetAccount;
  try { targetAccount = await auth.getUser(uid); }
  catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
  if (targetAccount?.email?.toLowerCase() === masterAdminEmail) {
    throw new HttpsError('permission-denied', 'The master admin cannot be removed.');
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [owner, target] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(db.doc(`admins/${uid}`))
    ]);
    if (!owner.exists || companyIdOf(owner) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : owner.data().role !== 'owner')) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    if (!target.exists) throw new HttpsError('not-found', 'This admin has already been removed.');
    if (companyIdOf(target) !== companyId || target.data().role === 'owner') {
      throw new HttpsError('permission-denied', 'You can only remove admins in your own company.');
    }
    transaction.delete(target.ref);
    const email = normalizeAdminEmail(targetAccount?.email);
    if (email) transaction.delete(adminInviteRef(email));
  });
  return { removed: true };
});

function validSkillId(id) {
  return (Number.isInteger(id) && id >= 0 && id < 100) ||
    (typeof id === 'string' && customSkillPattern.test(id));
}

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

function cleanExternalUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.length > 300) invalid('Keep each website or social media link under 300 characters.');
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    invalid('Enter a valid website or social media link.');
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.') || url.username || url.password) {
    invalid('Use an HTTPS website or social media link.');
  }
  return url.href;
}

function cleanProfile(value) {
  const profile = value?.profile;
  const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  const location = typeof profile?.location === 'string' ? profile.location.trim() : '';
  const bio = typeof value?.bio === 'string' ? value.bio.trim() : '';
  const website = cleanExternalUrl(value?.website);
  const socialLinks = value?.socialLinks ?? [];
  if (!Array.isArray(socialLinks) || socialLinks.length > 3) invalid('Add no more than three social media links.');
  const cleanedLinks = socialLinks.map(cleanExternalUrl).filter(Boolean);
  if (new Set(cleanedLinks).size !== cleanedLinks.length) invalid('Use a different page for each social media link.');
  if (typeof name !== 'string' || !name || name.length > 40 || typeof location !== 'string' || location.length > 100 || typeof bio !== 'string' || !bio || bio.length > 6000 || bio.split(/\s+/).length > 500) {
    invalid('Add a name and an introduction of no more than 500 words.');
  }
  return { profile: { name, location }, bio, website, socialLinks: cleanedLinks, photos: validPhotos(value.photos) };
}

function assertActive(transaction, uid) {
  return transaction.get(db.doc(`blockedUsers/${uid}`)).then(snapshot => {
    if (snapshot.exists) throw new HttpsError('permission-denied', 'This account has been blocked.');
  });
}

async function applicantProfileCount(transaction, stats) {
  const recorded = stats.data()?.profileCount;
  if (Number.isInteger(recorded) && recorded >= 0) return recorded;
  const existing = await transaction.get(db.collection('users').select());
  return existing.size;
}

export const saveProfile = onCall(options, async request => {
  const user = caller(request);
  const companyId = await requestedCompanyId(request.data?.companyId);
  const data = cleanProfile(request.data);
  const account = db.doc(`users/${user.uid}`);
  const previous = await account.get();
  const old = previous.data();
  const oldPhotos = old?.photos || (old?.photoDataUrl ? [old.photoDataUrl] : []);
  const newPhotos = data.photos;
  await checkText(`${data.profile.name}\n${data.profile.location}\n${data.bio}\n${data.website}\n${data.socialLinks.join('\n')}`);
  if (newPhotos.length) await checkPhotos(newPhotos);
  const now = Timestamp.now();
  const result = await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, current, stats, companyBlocked] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(account), transaction.get(applicationStatsRef),
      companyId === primaryCompanyId ? Promise.resolve(null) : transaction.get(companyDoc(companyId, `blockedApplicants/${user.uid}`))
    ]);
    if (admin.exists) throw new HttpsError('permission-denied', 'Admins do not need applicant profiles.');
    if (companyBlocked?.exists) throw new HttpsError('permission-denied', 'This company is not accepting your application.');
    if (!current.exists) {
      const count = await applicantProfileCount(transaction, stats);
      if (count >= applicationLimit) {
        if (!stats.exists) transaction.set(applicationStatsRef, { profileCount: count, updatedAt: FieldValue.serverTimestamp() });
        return { full: true };
      }
      transaction.set(applicationStatsRef, { profileCount: count + 1, updatedAt: FieldValue.serverTimestamp() });
    }
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
      ...(companyId === primaryCompanyId || !current.exists ? { status: 'submitted' } : {}),
      updatedAt: now,
      photoChangedAt: photosChanged ? now : (before?.photoChangedAt || (newPhotos.length ? now : null))
    };
    if (current.exists) transaction.update(account, { ...update,
      ...(companyId === primaryCompanyId ? { reviewedAt: FieldValue.delete() } : {}),
      photoDataUrl: FieldValue.delete() });
    else transaction.create(account, { ...update, createdAt: now });
    transaction.set(db.doc(`applicantSummaries/${user.uid}`), {
      name: data.profile.name,
      location: data.profile.location,
      email: user.token.email || '',
      ...(companyId === primaryCompanyId || !current.exists ? { status: 'submitted' } : {}),
      updatedAt: now
    }, { merge: true });
    transaction.set(db.doc(`applicantDirectory/${user.uid}`), directoryEntry({
      profile: data.profile, email: user.token.email || '', updatedAt: now
    }));
    if (companyId !== primaryCompanyId) {
      transaction.set(applicationRef(companyId, user.uid), {
        profile: data.profile, status: 'submitted', submittedAt: now
      }, { merge: true });
      transaction.set(companySummaryRef(companyId, user.uid), {
        name: data.profile.name, location: data.profile.location,
        email: user.token.email || '', status: 'submitted', updatedAt: now
      }, { merge: true });
    }
  });
  if (result?.full) throw new HttpsError('resource-exhausted', 'Applications are full at 10,000 profiles. Please try again after a place opens.');
  return { saved: true };
});

export const getSharedApplicantProfile = onCall(options, async request => {
  const user = caller(request);
  await companyAdmin(user);
  const uid = request.data?.uid;
  if (typeof uid !== 'string' || !uid || uid.includes('/')) invalid('Choose an applicant.');
  const [profile, blocked] = await Promise.all([
    db.doc(`users/${uid}`).get(), db.doc(`blockedUsers/${uid}`).get()
  ]);
  if (!profile.exists || blocked.exists) throw new HttpsError('not-found', 'Applicant profile unavailable.');
  const data = profile.data();
  return { uid, profile: data.profile || {}, bio: data.bio || '',
    photos: data.photos || (data.photoDataUrl ? [data.photoDataUrl] : []),
    website: data.website || '', socialLinks: data.socialLinks || [], email: data.email || '' };
});

export const syncApplicantDirectory = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  await assertMasterAdmin(caller(request));
  const stateRef = db.doc('systemTasks/applicantDirectory');
  const state = (await stateRef.get()).data() || {};
  if (state.done) return { done: true, processed: 0 };
  let query = db.collection('users').orderBy(FieldPath.documentId()).limit(200);
  if (state.lastUid) query = query.startAfter(state.lastUid);
  const page = await query.get();
  const blocked = await Promise.all(page.docs.map(document => db.doc(`blockedUsers/${document.id}`).get()));
  const batch = db.batch();
  for (const [index, document] of page.docs.entries()) {
    if (!blocked[index].exists) batch.set(db.doc(`applicantDirectory/${document.id}`), directoryEntry(document.data()));
  }
  if (page.size) await batch.commit();
  await stateRef.set({ lastUid: page.docs.at(-1)?.id || state.lastUid || '', done: page.size < 200,
    updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { done: page.size < 200, processed: page.size };
});

export const sendMessage = onCall(options, async request => {
  const user = caller(request);
  const callerAdmin = await db.doc(`admins/${user.uid}`).get();
  const companyId = callerAdmin.exists ? companyIdOf(callerAdmin) : await requestedCompanyId(request.data?.companyId);
  const text = typeof request.data?.text === 'string' ? request.data.text.trim() : '';
  const targetUid = request.data?.targetUid;
  if (typeof text !== 'string' || !text || text.length > 2000 || typeof targetUid !== 'string' || !targetUid || targetUid.includes('/')) invalid('Enter a message and choose an applicant.');
  await checkText(text);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const admin = await transaction.get(db.doc(`admins/${user.uid}`));
    const isAdmin = admin.exists;
    if (isAdmin && companyIdOf(admin) !== companyId) throw new HttpsError('permission-denied', 'Company access required.');
    if (!isAdmin && targetUid !== user.uid) throw new HttpsError('permission-denied', 'You can only reply in your own inbox.');
    const [blocked, companyBlocked, applicant] = await Promise.all([
      transaction.get(db.doc(`blockedUsers/${targetUid}`)),
      companyId === primaryCompanyId ? Promise.resolve(null) : transaction.get(companyDoc(companyId, `blockedApplicants/${targetUid}`)),
      transaction.get(db.doc(`users/${targetUid}`))
    ]);
    if (blocked.exists || companyBlocked?.exists || !applicant.exists) throw new HttpsError('failed-precondition', 'This applicant is unavailable.');
    const conversation = companyDoc(companyId, `conversations/${targetUid}`);
    const existing = await transaction.get(conversation);
    if (!isAdmin && !existing.exists) throw new HttpsError('permission-denied', 'An admin must start the conversation.');
    const message = conversation.collection('messages').doc();
    if (!existing.exists) transaction.create(conversation, {
      participantUid: targetUid, openedBy: user.uid, openedAt: FieldValue.serverTimestamp(),
      firstMessageId: message.id, contactAdminUid: user.uid
    });
    else if (isAdmin) transaction.update(conversation, { contactAdminUid: user.uid, contactAdminEmail: FieldValue.delete() });
    transaction.create(message, {
      senderUid: user.uid, senderRole: isAdmin ? 'admin' : 'member', text,
      recipientAdminUid: isAdmin ? null : (existing.data()?.contactAdminUid || null),
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { sent: true };
});

export const sanitizeMyContacts = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const profileRef = db.doc(`users/${user.uid}`);
  const conversationRef = db.doc(`conversations/${user.uid}`);
  const [profile, conversation] = await Promise.all([profileRef.get(), conversationRef.get()]);
  if (!profile.exists && !conversation.exists) return { cleaned: true };
  const writer = db.bulkWriter();
  if (profile.data()?.interview?.contactAdminEmail && profile.data().interview.source !== 'calendar') {
    writer.update(profileRef, { 'interview.contactAdminEmail': FieldValue.delete() });
  }
  if (conversation.exists && conversation.data().privacyVersion !== 1) {
    const messages = await conversationRef.collection('messages').where('senderRole', '==', 'admin').get();
    for (const message of messages.docs) {
      const currentText = message.data().text;
      if (typeof currentText !== 'string') continue;
      const safeText = currentText.replace(/\b\S+@\S+\s+is your contact\./g, 'A Homesteader admin is your contact.');
      if (safeText !== currentText) writer.update(message.ref, { text: safeText });
    }
    writer.update(conversationRef, { contactAdminEmail: FieldValue.delete(), privacyVersion: 1 });
  }
  await writer.close();
  return { cleaned: true };
});

export const setReviewStatus = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await companyAdmin(user);
  const uid = request.data?.uid;
  const status = request.data?.status;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || !reviewStatuses.has(status)) invalid('Choose an applicant and a valid status.');
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const admin = await transaction.get(db.doc(`admins/${user.uid}`));
    if (!admin.exists || companyIdOf(admin) !== companyId) throw new HttpsError('permission-denied', 'Admin access required.');
    const applicant = applicationRef(companyId, uid);
    const profile = await transaction.get(db.doc(`users/${uid}`));
    if (!profile.exists) throw new HttpsError('not-found', 'Profile not found.');
    transaction.set(applicant, { status, reviewedAt: FieldValue.serverTimestamp(),
      ...(companyId === primaryCompanyId ? {} : { profile: profile.data().profile || {} }) }, { merge: true });
    transaction.set(companySummaryRef(companyId, uid), {
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
  const { companyId } = await companyAdmin(user);
  const uid = request.data?.uid;
  const action = request.data?.action;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid === user.uid || !['block', 'delete', 'unblock'].includes(action)) invalid('Choose an applicant and an action.');
  if (companyId !== primaryCompanyId) {
    let skillEntries = [];
    await db.runTransaction(async transaction => {
      await assertActive(transaction, user.uid);
      const [admin, profile, skillRecord, application] = await Promise.all([
        transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(db.doc(`users/${uid}`)),
        transaction.get(companyDoc(companyId, `skills/${uid}`)), transaction.get(applicationRef(companyId, uid))
      ]);
      if (!admin.exists || companyIdOf(admin) !== companyId || !profile.exists) {
        throw new HttpsError('permission-denied', 'Company admin access required.');
      }
      skillEntries = skillRecord.data()?.entries || [];
      if (action === 'delete' && application.data()?.interview?.scheduledAt) {
        throw new HttpsError('failed-precondition', 'Cancel the interview before deleting this company application.');
      }
      const blocked = companyDoc(companyId, `blockedApplicants/${uid}`);
      if (action === 'unblock') transaction.delete(blocked);
      else transaction.set(blocked, { email: profile.data().email || '', blockedBy: user.uid,
        blockedAt: FieldValue.serverTimestamp() });
      if (action === 'delete') {
        transaction.delete(companyDoc(companyId, `applications/${uid}`));
        transaction.delete(companySummaryRef(companyId, uid));
        transaction.delete(companyDoc(companyId, `questionnaires/${uid}`));
        transaction.delete(companyDoc(companyId, `skills/${uid}`));
        for (const entry of skillEntries) {
          if (validSkillId(entry.id)) transaction.delete(companyDoc(companyId, `skillRankings/${entry.id}/applicants/${uid}`));
        }
      }
    });
    if (action === 'delete') {
      await db.recursiveDelete(companyDoc(companyId, `conversations/${uid}`));
      const teams = await companyCollection(companyId, 'teams').get();
      const writer = db.bulkWriter();
      for (const team of teams.docs) writer.delete(team.ref.collection('members').doc(uid));
      await writer.close();
    }
    return { done: true };
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, targetAdmin, profile, skillRecord, stats] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`admins/${uid}`)),
      transaction.get(db.doc(`users/${uid}`)),
      transaction.get(db.doc(`skills/${uid}`)),
      transaction.get(applicationStatsRef)
    ]);
    if (!admin.exists || targetAdmin.exists) throw new HttpsError('permission-denied', 'Admin access required.');
    if (action === 'delete' && profile.data()?.interview?.source === 'calendar') {
      throw new HttpsError('failed-precondition', 'Cancel the booked interview before deleting this applicant.');
    }
    const nextCount = action === 'delete' && profile.exists ?
      Math.max(0, (await applicantProfileCount(transaction, stats)) - 1) : null;
    const blocked = db.doc(`blockedUsers/${uid}`);
    if (action === 'unblock') {
      transaction.delete(blocked);
      if (profile.exists) transaction.set(db.doc(`applicantDirectory/${uid}`), directoryEntry(profile.data()));
    }
    else {
      transaction.set(blocked, { email: profile.data()?.email || '', blockedBy: user.uid, blockedAt: FieldValue.serverTimestamp() });
      transaction.delete(db.doc(`applicantDirectory/${uid}`));
      if (action === 'delete') {
        if (nextCount !== null) transaction.set(applicationStatsRef, { profileCount: nextCount, updatedAt: FieldValue.serverTimestamp() });
        if (profile.exists) transaction.delete(profile.ref);
        transaction.delete(db.doc(`applicantSummaries/${uid}`));
        transaction.delete(db.doc(`questionnaires/${uid}`));
        transaction.delete(db.doc(`skills/${uid}`));
        for (const entry of skillRecord.data()?.entries || []) {
          if (validSkillId(entry.id)) {
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
    try {
      const teams = await db.collection('teams').get();
      const writer = db.bulkWriter();
      for (const team of teams.docs) writer.delete(team.ref.collection('members').doc(uid));
      await writer.close();
    } catch (error) { console.error('Team membership cleanup failed', error); }
  }
  return { done: true };
});

export const manageTeam = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await companyAdmin(user);
  const action = request.data?.action;
  const teamId = request.data?.teamId;
  if (!['create', 'rename', 'delete'].includes(action) ||
      (action !== 'create' && (typeof teamId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(teamId)))) {
    invalid('Choose a team and an action.');
  }
  const name = typeof request.data?.name === 'string' ? request.data.name.trim() : '';
  if (action !== 'delete' && (!name || name.length > 80)) invalid('Enter a team name up to 80 characters.');
  if (action !== 'delete') await checkText(name);
  const teamRef = action === 'create' ? companyCollection(companyId, 'teams').doc() : companyDoc(companyId, `teams/${teamId}`);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const admin = await transaction.get(db.doc(`admins/${user.uid}`));
    if (!admin.exists || companyIdOf(admin) !== companyId) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }
    if (action === 'create') {
      transaction.create(teamRef, { name, createdAt: FieldValue.serverTimestamp(), createdBy: user.uid });
      return;
    }
    if (!(await transaction.get(teamRef)).exists) throw new HttpsError('not-found', 'Team not found.');
    if (action === 'rename') transaction.update(teamRef, { name, updatedAt: FieldValue.serverTimestamp() });
    else transaction.delete(teamRef);
  });
  if (action === 'delete') await db.recursiveDelete(teamRef);
  return { teamId: teamRef.id };
});

export const setTeamMember = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await companyAdmin(user);
  const teamId = request.data?.teamId;
  const uid = request.data?.uid;
  const action = request.data?.action;
  if (typeof teamId !== 'string' || !/^[A-Za-z0-9]{20}$/.test(teamId) ||
      typeof uid !== 'string' || !uid || uid.includes('/') || !['add', 'remove'].includes(action)) {
    invalid('Choose a team, an applicant, and an action.');
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const admin = await transaction.get(db.doc(`admins/${user.uid}`));
    if (!admin.exists || companyIdOf(admin) !== companyId) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }
    const teamRef = companyDoc(companyId, `teams/${teamId}`);
    if (!(await transaction.get(teamRef)).exists) throw new HttpsError('not-found', 'Team not found.');
    const memberRef = teamRef.collection('members').doc(uid);
    if (action === 'remove') {
      transaction.delete(memberRef);
      return;
    }
    const [profile, blocked, companyBlocked] = await Promise.all([
      transaction.get(db.doc(`users/${uid}`)), transaction.get(db.doc(`blockedUsers/${uid}`)),
      companyId === primaryCompanyId ? Promise.resolve(null) : transaction.get(companyDoc(companyId, `blockedApplicants/${uid}`))
    ]);
    if (!profile.exists || blocked.exists || companyBlocked?.exists) throw new HttpsError('failed-precondition', 'Choose an active applicant.');
    transaction.set(memberRef, { addedAt: FieldValue.serverTimestamp(), addedBy: user.uid });
  });
  return { saved: true };
});

export const saveQuestionnaireConfig = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const configRef = companyDoc(companyId, 'questionnaireConfig/main');
  const enabled = request.data?.enabled;
  const expectedRevision = request.data?.expectedRevision;
  const rawQuestions = request.data?.questions;
  if (typeof enabled !== 'boolean' || !Number.isInteger(expectedRevision) || expectedRevision < 0 ||
      !Array.isArray(rawQuestions) || rawQuestions.length > 100 || (enabled && !rawQuestions.length)) {
    invalid('Add at least one question before turning on the questionnaire.');
  }
  let textLength = 0;
  const questions = rawQuestions.map(item => {
    const section = typeof item?.section === 'string' ? item.section.trim() : '';
    const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
    const rawChoices = item?.choices;
    if (!section || section.length > 80 || !prompt || prompt.length > 500 ||
        !Array.isArray(rawChoices) || rawChoices.length > 6) {
      invalid('Each question needs a section, a prompt, and no more than 6 preset answers.');
    }
    const choices = rawChoices.map(choice => typeof choice === 'string' ? choice.trim() : '');
    if (choices.some(choice => !choice || choice.length > 200)) {
      invalid('Keep each answer between 1 and 200 characters.');
    }
    textLength += section.length + prompt.length + choices.join('').length;
    return { section, prompt, choices };
  });
  if (textLength > 30000) invalid('Shorten the questionnaire before saving.');
  const text = questions.map(question => [question.section, question.prompt, ...question.choices].join('\n')).join('\n');
  for (let index = 0; index < text.length; index += 5000) await checkText(text.slice(index, index + 5000));
  const revision = await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, current] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(configRef)
    ]);
    if (!admin.exists || companyIdOf(admin) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : admin.data().role !== 'owner')) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    const currentRevision = current.data()?.revision || 0;
    if (currentRevision !== expectedRevision) {
      throw new HttpsError('aborted', 'The questionnaire changed in another session. Reload before saving.');
    }
    const nextRevision = currentRevision + 1;
    const questionValues = value => JSON.stringify(value?.map(question =>
      [question.section, question.prompt, question.choices]));
    const questionsChanged = questionValues(current.data()?.questions) !== questionValues(questions);
    const questionRevision = (current.data()?.questionRevision || 0) + (questionsChanged ? 1 : 0);
    transaction.set(configRef, {
      enabled, revision: nextRevision, questionRevision, questions,
      updatedBy: user.uid, updatedAt: FieldValue.serverTimestamp()
    });
    return nextRevision;
  });
  return { revision };
});

export const saveQuestionnaire = onCall(options, async request => {
  const user = caller(request);
  const companyId = await requestedCompanyId(request.data?.companyId);
  const answers = request.data?.answers;
  if (!Array.isArray(answers) || answers.length > 100) invalid('Answer every question before submitting.');
  const normalizedAnswers = answers.map(answer => {
    if (Number.isInteger(answer)) return answer;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || typeof answer.text !== 'string') {
      invalid('Choose an answer or write your own response for every question.');
    }
    const written = answer.text.trim();
    if (!written || written.length > 500) invalid('Keep each written answer between 1 and 500 characters.');
    return { text: written };
  });
  const writtenText = normalizedAnswers.filter(answer => typeof answer === 'object')
    .map(answer => answer.text).join('\n');
  if (writtenText.length > 30000) invalid('Shorten your written answers before saving.');
  for (let index = 0; index < writtenText.length; index += 5000) {
    await checkText(writtenText.slice(index, index + 5000));
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, profile, configuration, companyBlocked] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`users/${user.uid}`)),
      transaction.get(companyDoc(companyId, 'questionnaireConfig/main')),
      companyId === primaryCompanyId ? Promise.resolve(null) : transaction.get(companyDoc(companyId, `blockedApplicants/${user.uid}`))
    ]);
    if (admin.exists || !profile.exists) throw new HttpsError('failed-precondition', 'Save your applicant profile before taking the questionnaire.');
    if (companyBlocked?.exists) throw new HttpsError('permission-denied', 'This company is not accepting your application.');
    const config = configuration.data();
    if (config?.enabled === false) throw new HttpsError('failed-precondition', 'The questionnaire is currently turned off.');
    if ((config?.questionRevision || 0) !== (request.data?.revision ?? 0)) {
      throw new HttpsError('aborted', 'The questionnaire changed. Refresh the page before saving your answers.');
    }
    const questions = config?.questions;
    const choiceCounts = questions ? questions.map(question => question.choices.length) : Array(30).fill(4);
    if (!choiceCounts.length || normalizedAnswers.length !== choiceCounts.length || normalizedAnswers.some((answer, index) =>
      Number.isInteger(answer) && (answer < 0 || answer >= choiceCounts[index]))) {
      invalid('Choose an answer or write your own response for every current question. Refresh if the questionnaire changed.');
    }
    transaction.set(companyDoc(companyId, `questionnaires/${user.uid}`), {
      version: questions ? 2 : 1,
      answers: normalizedAnswers,
      ...(questions ? { revision: config.questionRevision, questions } : {}),
      submittedAt: FieldValue.serverTimestamp()
    });
    transaction.set(companySummaryRef(companyId, user.uid), {
      name: profile.data().profile?.name || 'Unnamed',
      location: profile.data().profile?.location || '',
      email: profile.data().email || '',
      ...(companyId === primaryCompanyId ? { status: profile.data().status || 'submitted' } : {}),
      questionnaireCompletedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
  return { saved: true };
});

export const manageInterview = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await companyAdmin(user);
  const uid = request.data?.uid;
  const action = request.data?.action;
  if (typeof uid !== 'string' || !uid || uid.includes('/') || uid === user.uid ||
      !['schedule', 'cancel'].includes(action)) invalid('Choose an applicant and an interview action.');
  let interview = null;
  let invitation = '';
  let reservationRefs = [];
  let reservationEndMs = 0;
  let reservationBufferMs = 0;
  if (action === 'schedule') {
    const mode = request.data?.mode;
    const modeLabel = new Map([['phone', 'phone'], ['in-person', 'in-person'], ['zoom', 'Zoom']]).get(mode);
    const rawTime = request.data?.scheduledAt;
    const date = typeof rawTime === 'string' ? new Date(rawTime) : new Date(NaN);
    const timeZone = typeof request.data?.timeZone === 'string' ? request.data.timeZone : 'UTC';
    const timeZoneLabel = typeof request.data?.timeZoneLabel === 'string' ? request.data.timeZoneLabel.trim() : '';
    const note = typeof request.data?.note === 'string' ? request.data.note.trim() : '';
    const meetingLink = cleanExternalUrl(request.data?.meetingLink);
    if (!modeLabel || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now() ||
        date.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000 ||
        timeZone.length > 64 || note.length > 1000 || (mode !== 'zoom' && meetingLink)) {
      invalid('Choose an interview type and a future date and time.');
    }
    if (!timeZoneLabel || timeZoneLabel.length > 60 || /[<>\r\n/]/.test(timeZoneLabel)) {
      invalid('Enter a readable time zone, such as Central Time (CT).');
    }
    let formatted;
    try {
      formatted = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone }).format(date);
    } catch {
      invalid('Choose a valid time zone.');
    }
    if (note) await checkText(note);
    const availability = (await db.doc(`adminAvailability/${user.uid}`).get()).data()?.availability;
    reservationBufferMs = (availability?.bufferMinutes || 0) * 60_000;
    reservationEndMs = date.getTime() + 60 * 60_000;
    reservationRefs = bookingLockRefs(db, user.uid, date.getTime(), reservationEndMs + reservationBufferMs);
    interview = {
      source: 'manual', mode, scheduledAt: Timestamp.fromDate(date), durationMinutes: 60,
      timeZone, timeZoneLabel, note, meetingLink, bookingLockIds: reservationRefs.map(ref => ref.id),
      contactAdminUid: user.uid, updatedAt: FieldValue.serverTimestamp()
    };
    invitation = `You are invited to a ${modeLabel} interview on ${formatted} ${timeZoneLabel}. ` +
      'A Homesteader admin is your contact. Reply here to confirm the date and time or ask questions.' +
      (meetingLink ? `\nZoom link: ${meetingLink}` : '') + (note ? `\n${note}` : '');
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const revisionRef = calendarRevisionRef(db, user.uid);
    const [admin, blocked, companyBlocked, sharedProfile, applicant] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`blockedUsers/${uid}`)),
      companyId === primaryCompanyId ? Promise.resolve(null) : transaction.get(companyDoc(companyId, `blockedApplicants/${uid}`)),
      transaction.get(db.doc(`users/${uid}`)),
      transaction.get(applicationRef(companyId, uid)),
      transaction.get(revisionRef)
    ]);
    if (!admin.exists || companyIdOf(admin) !== companyId) throw new HttpsError('permission-denied', 'Admin access required.');
    if (blocked.exists || companyBlocked?.exists || !sharedProfile.exists) throw new HttpsError('failed-precondition', 'This applicant is unavailable.');
    if (applicant.data()?.interview?.source === 'calendar') {
      throw new HttpsError('failed-precondition', 'Cancel the booked interview before changing it.');
    }
    if (action === 'cancel' && !applicant.data()?.interview) throw new HttpsError('failed-precondition', 'No interview is scheduled.');
    const conversation = companyDoc(companyId, `conversations/${uid}`);
    const existing = await transaction.get(conversation);
    const previousRefs = (applicant.data()?.interview?.bookingLockIds || [])
      .map(id => db.doc(`calendarSlotLocks/${id}`));
    const allRefs = [...new Map([...previousRefs, ...reservationRefs].map(ref => [ref.path, ref])).values()];
    const locks = await Promise.all(allRefs.map(ref => transaction.get(ref)));
    if (action === 'schedule') {
      const blockedPeriods = await transaction.get(db.collection(`calendarBlocks/${user.uid}/items`));
      if (blockedPeriods.docs.some(block => intervalsOverlap(
        interview.scheduledAt.toMillis(), reservationEndMs + reservationBufferMs,
        block.data().start?.toMillis?.(), block.data().end?.toMillis?.()
      ))) throw new HttpsError('failed-precondition', 'A blocked time overlaps that interview.');
      const otherInterviews = await transaction.get(companyCollection(companyId,
        companyId === primaryCompanyId ? 'users' : 'applications')
        .where('interview.contactAdminUid', '==', user.uid).select('interview'));
      const startMs = interview.scheduledAt.toMillis();
      if (otherInterviews.docs.some(doc => {
        if (doc.id === uid) return false;
        const other = doc.data().interview;
        const otherStart = other?.scheduledAt?.toMillis?.();
        const otherEnd = otherStart + (other?.durationMinutes || 60) * 60_000;
        return otherStart < reservationEndMs + reservationBufferMs && otherEnd > startMs - reservationBufferMs;
      })) throw new HttpsError('failed-precondition', 'Another interview overlaps that time.');
      if (reservationRefs.some(ref => {
        const lock = locks[allRefs.findIndex(item => item.path === ref.path)];
        return lock.exists && lock.data().expiresAt?.toMillis?.() > Date.now() &&
          lock.data().applicantUid !== uid;
      })) throw new HttpsError('failed-precondition', 'That time is already booked or blocked.');
    }
    const message = conversation.collection('messages').doc();
    previousRefs.forEach(ref => {
      const lock = locks[allRefs.findIndex(item => item.path === ref.path)];
      if (!reservationRefs.some(item => item.path === ref.path) && lock.data()?.applicantUid === uid) transaction.delete(ref);
    });
    if (action === 'cancel') {
      const previous = applicant.data().interview;
      const label = ({ phone: 'phone', 'in-person': 'in-person', zoom: 'Zoom' })[previous.mode] || 'scheduled';
      invitation = `The ${label} interview has been canceled. Reply here if you have questions about the date or time.`;
      transaction.update(applicant.ref, { interview: FieldValue.delete() });
      transaction.set(companySummaryRef(companyId, uid), {
        interviewMode: FieldValue.delete(), interviewAt: FieldValue.delete()
      }, { merge: true });
    } else {
      transaction.set(applicationRef(companyId, uid), { interview, bookingInvite: FieldValue.delete(),
        ...(companyId === primaryCompanyId ? {} : { profile: sharedProfile.data().profile || {} }) }, { merge: true });
      transaction.set(companySummaryRef(companyId, uid), {
        interviewMode: interview.mode, interviewAt: interview.scheduledAt
      }, { merge: true });
      reservationRefs.forEach(ref => transaction.set(ref, {
        adminUid: user.uid, applicantUid: uid,
        expiresAt: Timestamp.fromMillis(reservationEndMs + reservationBufferMs)
      }));
    }
    if (!existing.exists) transaction.create(conversation, {
      participantUid: uid, openedBy: user.uid, openedAt: FieldValue.serverTimestamp(),
      firstMessageId: message.id, contactAdminUid: user.uid
    });
    else transaction.update(conversation, { contactAdminUid: user.uid, contactAdminEmail: FieldValue.delete() });
    transaction.create(message, { senderUid: user.uid, senderRole: 'admin', text: invitation, createdAt: FieldValue.serverTimestamp() });
    transaction.set(revisionRef, { revision: FieldValue.increment(1) }, { merge: true });
  });
  return { saved: true };
});

export const addSkill = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const name = typeof request.data?.name === 'string' ? request.data.name.trim().replace(/\s+/g, ' ') : '';
  const category = typeof request.data?.category === 'string' ? request.data.category.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80 || category.length < 2 || category.length > 50 ||
      /[\/\\]/.test(name + category)) invalid('Enter a skill and a category.');
  await checkText(`${category}\n${name}`);
  const key = `${category.toLocaleLowerCase('en-US')}|${name.toLocaleLowerCase('en-US')}`;
  const id = `custom_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  try {
    await db.runTransaction(async transaction => {
      await assertActive(transaction, user.uid);
      const admin = await transaction.get(db.doc(`admins/${user.uid}`));
      if (!admin.exists || companyIdOf(admin) !== companyId ||
          (companyId === primaryCompanyId ? !hasMasterEmail(user) : admin.data().role !== 'owner')) {
        throw new HttpsError('permission-denied', 'Company owner access required.');
      }
      const skill = companyDoc(companyId, `skillCatalog/${id}`);
      if ((await transaction.get(skill)).exists) throw new HttpsError('already-exists', 'This skill is already in that category.');
      transaction.create(skill, { name, category, addedBy: user.uid, addedAt: FieldValue.serverTimestamp() });
    });
  } catch (error) {
    if (error.code === 6 || error.code === 'already-exists') {
      throw new HttpsError('already-exists', 'This skill is already in that category.');
    }
    throw error;
  }
  return { id };
});

export const deleteSkill = onCall(options, async request => {
  const user = caller(request);
  const { companyId } = await companyAdmin(user);
  const id = request.data?.id;
  if (!validSkillId(id)) invalid('Choose a skill to delete.');
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const skillRef = companyDoc(companyId, `skillCatalog/${id}`);
    const [admin, skill] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(skillRef)
    ]);
    if (!admin.exists || companyIdOf(admin) !== companyId) throw new HttpsError('permission-denied', 'Admin access required.');
    if ((typeof id === 'string' && !skill.exists) || skill.data()?.deleted === true) {
      throw new HttpsError('not-found', 'This skill is no longer available.');
    }
    transaction.set(skillRef, {
      deleted: true, deletedAt: FieldValue.serverTimestamp(), deletedBy: user.uid
    }, { merge: true });
  });
  return { deleted: true };
});

export const saveSkills = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const companyId = await requestedCompanyId(request.data?.companyId);
  const raw = request.data?.entries;
  if (!Array.isArray(raw) || raw.length > 10) invalid('Choose no more than 10 skills.');
  const seen = new Set();
  const entries = raw.map(item => {
    const id = item?.id;
    const years = item?.years;
    const organization = typeof item?.organization === 'string' ? item.organization.trim() : '';
    if (!validSkillId(id) || seen.has(String(id)) ||
        typeof years !== 'number' || !Number.isFinite(years) || years < 0 || years > 80 ||
        !Number.isInteger(years * 2) || organization.length < 2 || organization.length > 120) {
      invalid('Add valid years and a company, organization, or homestead for each selected skill.');
    }
    seen.add(String(id));
    return { id, years, organization };
  });
  for (let index = 0; index < entries.length; index += 10) {
    await checkText(entries.slice(index, index + 10).map(entry =>
      `${entry.organization} is the company or homestead for this skill.`
    ).join('\n'));
  }
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const skillDoc = companyDoc(companyId, `skills/${user.uid}`);
    const [admin, profile, previous, companyBlocked, ...catalogSkills] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      transaction.get(db.doc(`users/${user.uid}`)),
      transaction.get(skillDoc),
      companyId === primaryCompanyId ? Promise.resolve(null) : transaction.get(companyDoc(companyId, `blockedApplicants/${user.uid}`)),
      ...entries.map(entry => transaction.get(companyDoc(companyId, `skillCatalog/${entry.id}`)))
    ]);
    if (admin.exists || !profile.exists) throw new HttpsError('failed-precondition', 'Save your applicant profile before adding skills.');
    if (companyBlocked?.exists) throw new HttpsError('permission-denied', 'This company is not accepting your application.');
    if (catalogSkills.some((snapshot, index) => snapshot.data()?.deleted === true ||
      (typeof entries[index].id === 'string' && !snapshot.exists))) {
      invalid('A selected skill is no longer available. Refresh and try again.');
    }
    const currentIds = new Set(entries.map(entry => String(entry.id)));
    for (const old of previous.data()?.entries || []) {
      if (validSkillId(old.id) && !currentIds.has(String(old.id))) {
        transaction.delete(companyDoc(companyId, `skillRankings/${old.id}/applicants/${user.uid}`));
      }
    }
    for (const entry of entries) {
      transaction.set(companyDoc(companyId, `skillRankings/${entry.id}/applicants/${user.uid}`), {
        years: entry.years,
        organization: entry.organization,
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    transaction.set(skillDoc, { version: 1, entries, updatedAt: FieldValue.serverTimestamp() });
    transaction.set(companySummaryRef(companyId, user.uid), {
      name: profile.data().profile?.name || 'Unnamed',
      location: profile.data().profile?.location || '',
      email: profile.data().email || '',
      ...(companyId === primaryCompanyId ? { status: profile.data().status || 'submitted' } : {}),
      skillCount: entries.length
    }, { merge: true });
  });
  return { saved: true };
});

export const listSharedSkillRanking = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const { companyId } = await companyAdmin(user);
  const rawSkillId = request.data?.skillId;
  const skillId = typeof rawSkillId === 'string' && /^(?:[0-9]|[1-9][0-9])$/.test(rawSkillId) ?
    Number(rawSkillId) : rawSkillId;
  if (!validSkillId(skillId)) invalid('Choose a skill.');
  const catalogEntry = await companyDoc(companyId, `skillCatalog/${skillId}`).get();
  if (catalogEntry.data()?.deleted === true || (typeof skillId === 'string' && !catalogEntry.exists)) {
    throw new HttpsError('not-found', 'This skill is not available at your company.');
  }

  const companyDocs = await db.collection('companies').select().get();
  const sourceIds = [primaryCompanyId, ...companyDocs.docs.map(document => document.id)];
  const sources = [];
  for (let start = 0; start < sourceIds.length; start += 10) {
    const batch = sourceIds.slice(start, start + 10);
    const snapshots = await Promise.all(batch.map(id =>
      companyCollection(id, `skillRankings/${skillId}/applicants`).orderBy('years', 'desc').limit(26).get()
    ));
    snapshots.forEach((snapshot, index) => sources.push({
      companyId: batch[index],
      entries: snapshot.docs.map(document => ({ uid: document.id,
        years: document.data().years, organization: document.data().organization || '' }))
    }));
  }
  const candidates = mergeSharedSkillEntries(sources, companyId);
  const verified = [];
  for (let start = 0; start < candidates.length && verified.length < 26; start += 25) {
    const batch = candidates.slice(start, start + 25);
    const refs = [
      ...batch.map(entry => db.doc(`users/${entry.uid}`)),
      ...batch.map(entry => db.doc(`blockedUsers/${entry.uid}`)),
      ...(companyId === primaryCompanyId ? [] : batch.map(entry => companyDoc(companyId, `blockedApplicants/${entry.uid}`)))
    ];
    const snapshots = await db.getAll(...refs);
    for (let index = 0; index < batch.length; index++) {
      const profile = snapshots[index];
      if (!profile.exists || snapshots[index + batch.length].exists ||
          (companyId !== primaryCompanyId && snapshots[index + 2 * batch.length].exists)) continue;
      const entry = batch[index];
      verified.push({ uid: entry.uid, years: entry.years, organization: entry.organization,
        name: profile.data().profile?.name || 'Unnamed', email: profile.data().email || '',
        sourceCompany: entry.sourceCompanyId === primaryCompanyId ? 'Titan Business Pros' :
          entry.sourceCompanyId === companyId ? 'your company' : 'another homestead company' });
    }
  }
  verified.sort((a, b) => b.years - a.years || a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
  return { rankings: verified.slice(0, 25), hasMore: verified.length > 25 };
});

function cleanHomesteadPage(value) {
  const name = typeof value?.name === 'string' ? value.name.trim() : '';
  const description = typeof value?.description === 'string' ? value.description.trim() : '';
  const fields = value?.fields;
  if (!name || name.length > 100 || !description || description.length > 30000 ||
      description.split(/\s+/).length > 2000 || !Array.isArray(fields) || fields.length > 40) {
    invalid('Add a homestead name and description of no more than 2,000 words.');
  }
  const labels = new Set();
  const cleanedFields = fields.map(field => {
    const label = typeof field?.label === 'string' ? field.label.trim().replace(/\s+/g, ' ') : '';
    const detail = typeof field?.value === 'string' ? field.value.trim() : '';
    if (label.length < 2 || label.length > 80 || detail.length > 500 || labels.has(label.toLowerCase())) {
      invalid('Use unique topic names and keep each detail under 500 characters.');
    }
    labels.add(label.toLowerCase());
    return { label, value: detail };
  });
  return { name, description, fields: cleanedFields };
}

async function assertAdmin(uid) {
  const [blocked, admin] = await Promise.all([
    db.doc(`blockedUsers/${uid}`).get(), db.doc(`admins/${uid}`).get()
  ]);
  if (blocked.exists || !admin.exists) throw new HttpsError('permission-denied', 'Admin access required.');
  const companyId = companyIdOf(admin);
  if (companyId !== primaryCompanyId) await requestedCompanyId(companyId);
  return companyId;
}

export const saveHomesteadPage = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const page = cleanHomesteadPage(request.data);
  const text = [page.name, page.description, ...page.fields.flatMap(field => [field.label, field.value])].join('\n');
  for (let index = 0; index < text.length; index += 5000) await checkText(text.slice(index, index + 5000));
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const companyRef = companyId === primaryCompanyId ? null : db.doc(`companies/${companyId}`);
    const [admin, company] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)),
      companyRef ? transaction.get(companyRef) : Promise.resolve(null)
    ]);
    if (!admin.exists || companyIdOf(admin) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : admin.data().role !== 'owner') ||
        (companyRef && (!company.exists || company.data().active === false || company.data().ownerUid !== user.uid))) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    transaction.set(companyDoc(companyId, 'homesteadPage/main'), {
      ...page, published: true, updatedBy: user.uid, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    if (companyRef) {
      const existingName = company.data().name;
      const name = typeof existingName === 'string' && existingName.trim() && existingName !== 'Homestead company'
        ? existingName.trim() : page.name;
      transaction.update(companyRef, { name, listed: true, updatedAt: FieldValue.serverTimestamp() });
      transaction.set(db.doc(`companyListings/${companyId}`), {
        name, active: true, updatedAt: FieldValue.serverTimestamp()
      });
    }
  });
  return { saved: true };
});

export const addHomesteadPhoto = onCall({ ...options, timeoutSeconds: 120 }, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const photo = request.data?.photo;
  if (typeof photo !== 'string' || photo.length > 200000 || !photoPattern.test(photo)) {
    invalid('Choose a JPG photo under 200 KB.');
  }
  await checkPhotos([photo]);
  const pageRef = companyDoc(companyId, 'homesteadPage/main');
  const photoRef = companyCollection(companyId, 'homesteadPhotos').doc();
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, page] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(pageRef)
    ]);
    if (!admin.exists || companyIdOf(admin) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : admin.data().role !== 'owner')) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    const count = page.data()?.photoCount || 0;
    if (count >= 20) throw new HttpsError('failed-precondition', 'The homestead page already has 20 photos.');
    transaction.create(photoRef, { photo, addedBy: user.uid, addedAt: FieldValue.serverTimestamp() });
    transaction.set(pageRef, { photoCount: count + 1 }, { merge: true });
  });
  return { id: photoRef.id };
});

export const deleteHomesteadPhoto = onCall(options, async request => {
  const user = caller(request);
  const companyId = await companyOwner(user);
  const id = request.data?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{20}$/.test(id)) invalid('Choose a homestead photo to remove.');
  const pageRef = companyDoc(companyId, 'homesteadPage/main');
  const photoRef = companyDoc(companyId, `homesteadPhotos/${id}`);
  await db.runTransaction(async transaction => {
    await assertActive(transaction, user.uid);
    const [admin, page, photo] = await Promise.all([
      transaction.get(db.doc(`admins/${user.uid}`)), transaction.get(pageRef), transaction.get(photoRef)
    ]);
    if (!admin.exists || companyIdOf(admin) !== companyId ||
        (companyId === primaryCompanyId ? !hasMasterEmail(user) : admin.data().role !== 'owner')) {
      throw new HttpsError('permission-denied', 'Company owner access required.');
    }
    if (!photo.exists) throw new HttpsError('not-found', 'Photo not found.');
    transaction.delete(photoRef);
    transaction.set(pageRef, { photoCount: Math.max(0, (page.data()?.photoCount || 1) - 1) }, { merge: true });
  });
  return { deleted: true };
});

export const {
  calendarStatus, saveCalendarAvailability, addCalendarBlock, removeCalendarBlock,
  inviteToBook, revokeBookingInvite,
  listInterviewSlots, bookInterviewSlot, cancelCalendarInterview
} = createCalendarBooking({ db, caller, assertAdmin, checkText, options,
  companyIdForAdminUid: assertAdmin, requestedCompanyId, companyDoc, companyCollection,
  applicationRef, companySummaryRef, primaryCompanyId });
