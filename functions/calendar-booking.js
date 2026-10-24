import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';

const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minuteMs = 60_000;
const quarterHour = 15 * minuteMs;
const dayMs = 24 * 60 * minuteMs;

function invalid(message) { throw new HttpsError('invalid-argument', message); }
function unavailable(message) { throw new HttpsError('failed-precondition', message); }
function availabilityRef(db, uid) { return db.doc(`adminAvailability/${uid}`); }
function blocksCollection(db, uid) { return db.collection(`calendarBlocks/${uid}/items`); }
export function calendarRevisionRef(db, uid) { return db.doc(`calendarRevisions/${uid}`); }
function lockRef(db, uid, bucket) { return db.doc(`calendarSlotLocks/${uid}_${bucket}`); }
export function intervalsOverlap(firstStart, firstEnd, secondStart, secondEnd) {
  return firstStart < secondEnd && firstEnd > secondStart;
}
export function validBlockRange(start, end, now = Date.now()) {
  return Number.isFinite(start) && Number.isFinite(end) && start % minuteMs === 0 &&
    end % minuteMs === 0 && start >= now && end > start &&
    end - start <= 90 * dayMs && start <= now + 90 * dayMs;
}
export function bookingLockRefs(db, uid, start, end) {
  const refs = [];
  for (let bucket = Math.floor(start / quarterHour) * quarterHour;
       bucket < Math.ceil(end / quarterHour) * quarterHour; bucket += quarterHour) refs.push(lockRef(db, uid, bucket));
  return refs;
}
function cleanUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.href.length > 300) throw new Error();
    return url.href;
  } catch { invalid('Enter a valid HTTPS meeting link.'); }
}
function minutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return NaN;
  const [hours, mins] = value.split(':').map(Number);
  return hours < 24 && mins < 60 ? hours * 60 + mins : NaN;
}
function cleanAvailability(value) {
  const days = Array.isArray(value?.days) ? [...new Set(value.days)] : [];
  const startTime = value?.startTime;
  const endTime = value?.endTime;
  const durationMinutes = Number(value?.durationMinutes);
  const bufferMinutes = Number(value?.bufferMinutes);
  const leadHours = Number(value?.leadHours);
  const horizonDays = Number(value?.horizonDays);
  const timeZone = String(value?.timeZone || '').trim();
  const timeZoneLabel = String(value?.timeZoneLabel || '').trim();
  if (!days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6) ||
      !Number.isFinite(minutes(startTime)) || !Number.isFinite(minutes(endTime)) ||
      minutes(startTime) % 15 !== 0 || minutes(endTime) % 15 !== 0 ||
      minutes(endTime) - minutes(startTime) < durationMinutes ||
      ![30, 45, 60].includes(durationMinutes) || ![0, 15, 30].includes(bufferMinutes) ||
      ![1, 12, 24, 48].includes(leadHours) || ![7, 14, 30].includes(horizonDays) ||
      !timeZone || !timeZoneLabel || timeZoneLabel.length > 60 || /[<>\r\n/]/.test(timeZoneLabel)) {
    invalid('Choose days, hours, interview length, and a readable time zone.');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(); }
  catch { invalid('Enter a valid calendar time zone, such as America/Chicago.'); }
  return { days, startTime, endTime, durationMinutes, bufferMinutes, leadHours, horizonDays, timeZone, timeZoneLabel };
}

export function generateSlots(availability, busy = [], now = Date.now()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: availability.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const first = Math.ceil((now + availability.leadHours * 60 * minuteMs) / quarterHour) * quarterHour;
  const last = now + availability.horizonDays * 24 * 60 * minuteMs;
  const startMinutes = minutes(availability.startTime);
  const endMinutes = minutes(availability.endTime);
  const durationMs = availability.durationMinutes * minuteMs;
  const bufferMs = availability.bufferMinutes * minuteMs;
  const slotInterval = availability.durationMinutes + availability.bufferMinutes;
  const slots = [];
  for (let start = first; start + durationMs <= last && slots.length < 500; start += quarterHour) {
    const parts = Object.fromEntries(formatter.formatToParts(start).map(part => [part.type, part.value]));
    const day = weekDays.indexOf(parts.weekday);
    const localMinute = Number(parts.hour) * 60 + Number(parts.minute);
    if (!availability.days.includes(day) || localMinute < startMinutes ||
        localMinute + availability.durationMinutes > endMinutes ||
        (localMinute - startMinutes) % slotInterval !== 0) continue;
    const endParts = Object.fromEntries(formatter.formatToParts(start + durationMs).map(part => [part.type, part.value]));
    if (endParts.weekday !== parts.weekday ||
        Number(endParts.hour) * 60 + Number(endParts.minute) !== localMinute + availability.durationMinutes) continue;
    if (busy.some(interval => new Date(interval.start).getTime() < start + durationMs + bufferMs &&
        new Date(interval.end).getTime() > start - bufferMs)) continue;
    slots.push(new Date(start).toISOString());
  }
  return slots;
}

function activeInvite(profile) {
  const invite = profile?.bookingInvite;
  if (!invite || invite.expiresAt?.toMillis?.() <= Date.now()) unavailable('This booking invitation has expired. Ask an admin to send another.');
  if (profile.interview?.scheduledAt) unavailable('An interview is already scheduled.');
  if (invite.status !== 'open') unavailable('This booking invitation is unavailable.');
  return invite;
}

export function createCalendarBooking({ db, caller, assertAdmin, checkText, options }) {
  async function calendarData(adminUid) {
    await assertAdmin(adminUid);
    // Read the revision before the data so a concurrent calendar edit causes
    // the later transaction to reject a stale view of the schedule.
    const revision = (await calendarRevisionRef(db, adminUid).get()).data()?.revision || 0;
    const [settings, blocks, interviews] = await Promise.all([
      availabilityRef(db, adminUid).get(), blocksCollection(db, adminUid).get(),
      db.collection('users').where('interview.contactAdminUid', '==', adminUid)
        .select('profile.name', 'interview').get()
    ]);
    const availability = settings.data()?.availability || null;
    const upcomingBlocks = blocks.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(block => block.end?.toMillis?.() > Date.now());
    const upcomingInterviews = interviews.docs.map(doc => ({ uid: doc.id, name: doc.data().profile?.name || 'Applicant', ...doc.data().interview }))
      .filter(item => item.scheduledAt?.toMillis?.() > Date.now());
    return { availability, blocks: upcomingBlocks, interviews: upcomingInterviews, revision };
  }
  async function availableSlots(adminUid, now = Date.now()) {
    const data = await calendarData(adminUid);
    if (!data.availability) unavailable('The admin has not set booking hours yet.');
    const busy = [
      ...data.blocks.map(block => ({ start: block.start.toDate(), end: block.end.toDate() })),
      ...data.interviews.map(interview => ({
        start: interview.scheduledAt.toDate(),
        end: new Date(interview.scheduledAt.toMillis() +
          (interview.durationMinutes || 60) * minuteMs)
      }))
    ];
    return { availability: data.availability, slots: generateSlots(data.availability, busy, now), revision: data.revision };
  }

  const calendarStatus = onCall(options, async request => {
    const user = caller(request);
    const data = await calendarData(user.uid);
    return {
      availability: data.availability,
      blocks: data.blocks.sort((a, b) => a.start.toMillis() - b.start.toMillis())
        .map(block => ({ id: block.id, start: block.start.toDate().toISOString(), end: block.end.toDate().toISOString() })),
      bookings: data.interviews.sort((a, b) => a.scheduledAt.toMillis() - b.scheduledAt.toMillis())
        .map(item => ({ uid: item.uid, name: item.name, mode: item.mode, start: item.scheduledAt.toDate().toISOString(),
          timeZone: item.timeZone, timeZoneLabel: item.timeZoneLabel, source: item.source || 'manual' }))
    };
  });

  const saveCalendarAvailability = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const availability = cleanAvailability(request.data);
    await availabilityRef(db, user.uid).set({ availability, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { saved: true };
  });

  const addCalendarBlock = onCall(options, async request => {
    const user = caller(request);
    const start = Date.parse(request.data?.start);
    const end = Date.parse(request.data?.end);
    if (!validBlockRange(start, end)) invalid('Choose a future start and end time, up to 90 days apart.');
    const current = await calendarData(user.uid);
    if (current.blocks.some(block => intervalsOverlap(start, end, block.start.toMillis(), block.end.toMillis()))) {
      unavailable('Another blocked period overlaps that time.');
    }
    const id = randomBytes(16).toString('hex');
    const ref = blocksCollection(db, user.uid).doc(id);
    const revisionRef = calendarRevisionRef(db, user.uid);
    await db.runTransaction(async transaction => {
      const revision = await transaction.get(revisionRef);
      if ((revision.data()?.revision || 0) !== current.revision) {
        unavailable('The calendar changed. Refresh and try blocking this time again.');
      }
      transaction.create(ref, { start: Timestamp.fromMillis(start), end: Timestamp.fromMillis(end), lockType: 'interval', createdAt: FieldValue.serverTimestamp() });
      transaction.set(revisionRef, { revision: FieldValue.increment(1) }, { merge: true });
    });
    return { added: true };
  });

  const removeCalendarBlock = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const id = request.data?.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) invalid('Choose a blocked time.');
    const ref = blocksCollection(db, user.uid).doc(id);
    const revisionRef = calendarRevisionRef(db, user.uid);
    await db.runTransaction(async transaction => {
      const [block] = await Promise.all([transaction.get(ref), transaction.get(revisionRef)]);
      if (!block.exists) unavailable('This blocked time was already removed.');
      const refs = block.data().lockType === 'interval' ? [] :
        bookingLockRefs(db, user.uid, block.data().start.toMillis(), block.data().end.toMillis());
      const locks = await Promise.all(refs.map(item => transaction.get(item)));
      transaction.delete(ref);
      locks.forEach((lock, index) => {
        if (lock.data()?.blockId === id) transaction.delete(refs[index]);
      });
      transaction.set(revisionRef, { revision: FieldValue.increment(1) }, { merge: true });
    });
    return { removed: true };
  });

  const inviteToBook = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const uid = request.data?.uid;
    const mode = request.data?.mode;
    const note = String(request.data?.note || '').trim();
    const meetingLink = cleanUrl(request.data?.meetingLink);
    if (typeof uid !== 'string' || !uid || uid.includes('/') || uid === user.uid ||
        !['phone', 'in-person', 'zoom'].includes(mode) || note.length > 1000 ||
        (mode !== 'zoom' && meetingLink)) invalid('Choose an applicant and interview type.');
    if (!(await availabilityRef(db, user.uid).get()).data()?.availability) unavailable('Save your bookable hours first.');
    if (note) await checkText(note);
    await db.runTransaction(async transaction => {
      const profileRef = db.doc(`users/${uid}`);
      const conversationRef = db.doc(`conversations/${uid}`);
      const [blocked, profile, conversation] = await Promise.all([
        transaction.get(db.doc(`blockedUsers/${uid}`)), transaction.get(profileRef), transaction.get(conversationRef)
      ]);
      if (blocked.exists || !profile.exists) unavailable('This applicant is unavailable.');
      if (profile.data().interview?.scheduledAt) unavailable('Cancel the existing interview before inviting a new booking.');
      const invite = {
        adminUid: user.uid, adminEmail: user.token.email || 'Homesteader admin', mode, note, meetingLink,
        status: 'open', createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * minuteMs)
      };
      transaction.update(profileRef, { bookingInvite: invite });
      const message = conversationRef.collection('messages').doc();
      if (!conversation.exists) transaction.create(conversationRef, {
        participantUid: uid, openedBy: user.uid, openedAt: FieldValue.serverTimestamp(),
        firstMessageId: message.id, contactAdminUid: user.uid
      });
      else transaction.update(conversationRef, { contactAdminUid: user.uid });
      transaction.create(message, {
        senderUid: user.uid, senderRole: 'admin', createdAt: FieldValue.serverTimestamp(),
        text: `Please choose an available time for your ${mode === 'in-person' ? 'in-person' : mode} interview on your Homesteader profile.${note ? `\n${note}` : ''}`
      });
    });
    return { invited: true };
  });

  const revokeBookingInvite = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const uid = request.data?.uid;
    if (typeof uid !== 'string' || !uid || uid.includes('/')) invalid('Choose an applicant.');
    await db.runTransaction(async transaction => {
      const profileRef = db.doc(`users/${uid}`);
      const conversationRef = db.doc(`conversations/${uid}`);
      const [profile, conversation] = await Promise.all([transaction.get(profileRef), transaction.get(conversationRef)]);
      if (profile.data()?.bookingInvite?.status !== 'open') unavailable('There is no open booking invitation.');
      transaction.update(profileRef, { bookingInvite: FieldValue.delete() });
      if (conversation.exists) transaction.create(conversationRef.collection('messages').doc(), {
        senderUid: user.uid, senderRole: 'admin', createdAt: FieldValue.serverTimestamp(),
        text: 'The invitation to choose an interview time has been withdrawn. An admin will contact you if a new time is available.'
      });
    });
    return { revoked: true };
  });

  const listInterviewSlots = onCall(options, async request => {
    const user = caller(request);
    const [blocked, admin, profile] = await Promise.all([
      db.doc(`blockedUsers/${user.uid}`).get(), db.doc(`admins/${user.uid}`).get(), db.doc(`users/${user.uid}`).get()
    ]);
    if (blocked.exists || admin.exists || !profile.exists) throw new HttpsError('permission-denied', 'Applicant access required.');
    const invite = activeInvite(profile.data());
    const result = await availableSlots(invite.adminUid);
    return { slots: result.slots, timeZone: result.availability.timeZone, timeZoneLabel: result.availability.timeZoneLabel };
  });

  const bookInterviewSlot = onCall(options, async request => {
    const user = caller(request);
    const start = request.data?.start;
    const startMs = Date.parse(start);
    if (typeof start !== 'string' || !Number.isFinite(startMs) ||
        new Date(startMs).toISOString() !== start || startMs % quarterHour) invalid('Choose an available time.');
    const profileRef = db.doc(`users/${user.uid}`);
    const [blocked, admin, profile] = await Promise.all([
      db.doc(`blockedUsers/${user.uid}`).get(), db.doc(`admins/${user.uid}`).get(), profileRef.get()
    ]);
    if (blocked.exists || admin.exists || !profile.exists) throw new HttpsError('permission-denied', 'Applicant access required.');
    const invite = activeInvite(profile.data());
    const result = await availableSlots(invite.adminUid);
    if (!result.slots.includes(start)) unavailable('That time is no longer available. Choose another.');
    const endMs = startMs + result.availability.durationMinutes * minuteMs;
    const refs = bookingLockRefs(db, invite.adminUid, startMs, endMs + result.availability.bufferMinutes * minuteMs);
    const revisionRef = calendarRevisionRef(db, invite.adminUid);
    await db.runTransaction(async transaction => {
      const conversationRef = db.doc(`conversations/${user.uid}`);
      const [current, adminDoc, settings, currentBlock, conversation, revision, ...locks] = await Promise.all([
        transaction.get(profileRef), transaction.get(db.doc(`admins/${invite.adminUid}`)),
        transaction.get(availabilityRef(db, invite.adminUid)), transaction.get(db.doc(`blockedUsers/${user.uid}`)),
        transaction.get(conversationRef), transaction.get(revisionRef), ...refs.map(ref => transaction.get(ref))
      ]);
      if (!adminDoc.exists || currentBlock.exists) unavailable('This booking is unavailable.');
      const latestInvite = activeInvite(current.data());
      if (latestInvite.adminUid !== invite.adminUid ||
          latestInvite.createdAt.toMillis() !== invite.createdAt.toMillis()) unavailable('The invitation changed. Refresh and try again.');
      if (JSON.stringify(settings.data()?.availability) !== JSON.stringify(result.availability)) {
        unavailable('The admin changed their bookable hours. Refresh and choose a time.');
      }
      if ((revision.data()?.revision || 0) !== result.revision) {
        unavailable('The admin calendar changed. Refresh and choose a time.');
      }
      if (locks.some(lock => lock.exists && lock.data().expiresAt?.toMillis?.() > Date.now())) {
        unavailable('That time was just booked. Choose another.');
      }
      const interview = {
        source: 'calendar', mode: invite.mode, scheduledAt: Timestamp.fromMillis(startMs),
        durationMinutes: result.availability.durationMinutes,
        timeZone: result.availability.timeZone, timeZoneLabel: result.availability.timeZoneLabel,
        note: invite.note, meetingLink: invite.meetingLink, contactAdminUid: invite.adminUid,
        contactAdminEmail: invite.adminEmail, bookingLockIds: refs.map(ref => ref.id),
        updatedAt: FieldValue.serverTimestamp()
      };
      transaction.update(profileRef, { interview, bookingInvite: FieldValue.delete() });
      transaction.set(db.doc(`applicantSummaries/${user.uid}`), {
        interviewMode: invite.mode, interviewAt: Timestamp.fromMillis(startMs)
      }, { merge: true });
      refs.forEach(ref => transaction.set(ref, {
        adminUid: invite.adminUid, applicantUid: user.uid,
        expiresAt: Timestamp.fromMillis(endMs + result.availability.bufferMinutes * minuteMs)
      }));
      transaction.set(revisionRef, { revision: FieldValue.increment(1) }, { merge: true });
      const message = conversationRef.collection('messages').doc();
      if (!conversation.exists) transaction.create(conversationRef, {
        participantUid: user.uid, openedBy: invite.adminUid, openedAt: FieldValue.serverTimestamp(),
        firstMessageId: message.id, contactAdminUid: invite.adminUid
      });
      transaction.create(message, {
        senderUid: invite.adminUid, senderRole: 'admin', createdAt: FieldValue.serverTimestamp(),
        text: `Your ${invite.mode === 'in-person' ? 'in-person' : invite.mode} interview is booked for ${new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: result.availability.timeZone }).format(new Date(startMs))} ${result.availability.timeZoneLabel}. You can find it on your Homesteader profile and ask questions here.`
      });
    });
    return { booked: true };
  });

  const cancelCalendarInterview = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const uid = request.data?.uid;
    if (typeof uid !== 'string' || !uid || uid.includes('/')) invalid('Choose an applicant.');
    const profileRef = db.doc(`users/${uid}`);
    await db.runTransaction(async transaction => {
      const conversationRef = db.doc(`conversations/${uid}`);
      const [profile, conversation] = await Promise.all([transaction.get(profileRef), transaction.get(conversationRef)]);
      const interview = profile.data()?.interview;
      if (interview?.source !== 'calendar') unavailable('No booked interview is scheduled.');
      const revisionRef = calendarRevisionRef(db, interview.contactAdminUid);
      const refs = (interview.bookingLockIds || []).map(id => db.doc(`calendarSlotLocks/${id}`));
      const [, ...locks] = await Promise.all([transaction.get(revisionRef), ...refs.map(ref => transaction.get(ref))]);
      transaction.update(profileRef, { interview: FieldValue.delete() });
      transaction.set(db.doc(`applicantSummaries/${uid}`), {
        interviewMode: FieldValue.delete(), interviewAt: FieldValue.delete()
      }, { merge: true });
      locks.forEach((lock, index) => {
        if (lock.data()?.applicantUid === uid) transaction.delete(refs[index]);
      });
      transaction.set(revisionRef, { revision: FieldValue.increment(1) }, { merge: true });
      if (conversation.exists) transaction.create(conversationRef.collection('messages').doc(), {
        senderUid: user.uid, senderRole: 'admin', createdAt: FieldValue.serverTimestamp(),
        text: 'Your booked interview has been canceled. An admin will contact you about a new time.'
      });
    });
    return { canceled: true };
  });

  return {
    calendarStatus, saveCalendarAvailability, addCalendarBlock, removeCalendarBlock,
    inviteToBook, revokeBookingInvite, listInterviewSlots, bookInterviewSlot, cancelCalendarInterview
  };
}
