import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash, randomBytes } from 'node:crypto';

const scope = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned'
].join(' ');
const siteUrl = 'https://titanbusinesspros.github.io/HS-App/profiles.html';
const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const minuteMs = 60_000;

function invalid(message) { throw new HttpsError('invalid-argument', message); }
function unavailable(message) { throw new HttpsError('failed-precondition', message); }
function calendarConfigRef(db) { return db.doc('calendarIntegration/main'); }
function connectionRef(db, uid) { return db.doc(`calendarConnections/${uid}`); }
function callbackUrl() {
  return `https://us-west2-${process.env.GCLOUD_PROJECT || 'homesteader-f8693'}.cloudfunctions.net/calendarOAuthCallback`;
}
function cleanUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.href.length > 300) {
      throw new Error('HTTPS required');
    }
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
      minutes(endTime) - minutes(startTime) < durationMinutes ||
      ![30, 45, 60].includes(durationMinutes) || ![0, 15, 30].includes(bufferMinutes) ||
      ![1, 12, 24, 48].includes(leadHours) || ![7, 14, 30].includes(horizonDays) ||
      !timeZone || !timeZoneLabel || timeZoneLabel.length > 60 || /[<>\r\n]/.test(timeZoneLabel)) {
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
  const first = Math.ceil((now + availability.leadHours * 60 * minuteMs) / (15 * minuteMs)) * 15 * minuteMs;
  const last = now + availability.horizonDays * 24 * 60 * minuteMs;
  const startMinutes = minutes(availability.startTime);
  const endMinutes = minutes(availability.endTime);
  const durationMs = availability.durationMinutes * minuteMs;
  const bufferMs = availability.bufferMinutes * minuteMs;
  const slotInterval = availability.durationMinutes + availability.bufferMinutes;
  const slots = [];
  for (let start = first; start + durationMs <= last && slots.length < 500; start += 15 * minuteMs) {
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

async function tokenResponse(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body)
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) unavailable('Google Calendar authorization failed. Reconnect the calendar.');
  return data;
}
async function accessToken(db, uid) {
  const [config, connection] = await Promise.all([calendarConfigRef(db).get(), connectionRef(db, uid).get()]);
  if (!config.data()?.clientId || !config.data()?.clientSecret || !connection.data()?.refreshToken ||
      connection.data().oauthClientId !== config.data().clientId) {
    unavailable('The admin needs to connect Google Calendar.');
  }
  const token = await tokenResponse({
    client_id: config.data().clientId, client_secret: config.data().clientSecret,
    refresh_token: connection.data().refreshToken, grant_type: 'refresh_token'
  });
  return { token: token.access_token, connection: connection.data() };
}
async function calendarRequest(token, path, method = 'GET', body) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new HttpsError(response.status === 401 || response.status === 403 ? 'failed-precondition' : 'unavailable',
      response.status === 401 || response.status === 403 ? 'Google Calendar access needs to be reconnected.' : 'Google Calendar is unavailable. Try again.');
    error.calendarStatus = response.status;
    throw error;
  }
  return data;
}
async function availableSlots(db, adminUid, now = Date.now()) {
  const [admin, blocked] = await Promise.all([
    db.doc(`admins/${adminUid}`).get(), db.doc(`blockedUsers/${adminUid}`).get()
  ]);
  if (!admin.exists || blocked.exists) unavailable('This admin is not available for bookings.');
  const { token, connection } = await accessToken(db, adminUid);
  const availability = connection.availability;
  if (!availability) unavailable('The admin has not set booking hours yet.');
  const result = await calendarRequest(token, 'freeBusy', 'POST', {
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + availability.horizonDays * 24 * 60 * minuteMs).toISOString(),
    items: [{ id: 'primary' }]
  });
  const calendar = result?.calendars?.primary;
  if (!calendar || calendar.errors?.length) unavailable('The admin calendar is not available for booking.');
  return {
    slots: generateSlots(availability, calendar.busy || [], now), availability, token,
    calendarEmail: connection.googleEmail || adminUid
  };
}
function activeInvite(profile) {
  const invite = profile?.bookingInvite;
  if (!invite || invite.expiresAt?.toMillis?.() <= Date.now()) unavailable('This booking invitation has expired. Ask an admin to send another.');
  if (profile.interview?.scheduledAt) unavailable('An interview is already scheduled.');
  return invite;
}
function eventId(uid, start) {
  return `h${createHash('sha256').update(`${uid}:${start}`).digest('hex').slice(0, 39)}`;
}

export function createCalendarBooking({ db, caller, assertAdmin, assertMasterAdmin, checkText, options }) {
  async function recoverStaleInvite(uid) {
    const profileRef = db.doc(`users/${uid}`);
    const profile = await profileRef.get();
    const invite = profile.data()?.bookingInvite;
    if (invite?.status !== 'booking' || !invite.startedAt?.toMillis?.() ||
        invite.startedAt.toMillis() > Date.now() - 4 * minuteMs) return;
    if (invite.start) {
      const { token } = await accessToken(db, invite.adminUid);
      try { await calendarRequest(token, `calendars/primary/events/${eventId(uid, invite.start)}?sendUpdates=all`, 'DELETE'); }
      catch (error) { if (error.calendarStatus !== 404) throw error; }
    }
    const lockRefs = (invite.lockIds || []).map(id => db.doc(`calendarSlotLocks/${id}`));
    await db.runTransaction(async transaction => {
      const [current, ...locks] = await Promise.all([transaction.get(profileRef), ...lockRefs.map(ref => transaction.get(ref))]);
      if (current.data()?.bookingInvite?.requestId !== invite.requestId ||
          current.data()?.bookingInvite?.status !== 'booking') return;
      transaction.update(profileRef, {
        'bookingInvite.status': 'open', 'bookingInvite.requestId': FieldValue.delete(),
        'bookingInvite.startedAt': FieldValue.delete(), 'bookingInvite.start': FieldValue.delete(),
        'bookingInvite.lockIds': FieldValue.delete()
      });
      locks.forEach((lock, index) => {
        if (lock.data()?.requestId === invite.requestId) transaction.delete(lockRefs[index]);
      });
    });
  }

  const calendarStatus = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const [config, connection] = await Promise.all([calendarConfigRef(db).get(), connectionRef(db, user.uid).get()]);
    return {
      configured: Boolean(config.data()?.clientId && config.data()?.clientSecret),
      connected: Boolean(connection.data()?.refreshToken && connection.data()?.oauthClientId === config.data()?.clientId),
      connectedEmail: connection.data()?.oauthClientId === config.data()?.clientId ? connection.data()?.googleEmail || '' : '',
      availability: connection.data()?.availability || null,
      callbackUrl: callbackUrl()
    };
  });

  const saveCalendarIntegration = onCall(options, async request => {
    const user = caller(request);
    await assertMasterAdmin(user);
    const clientId = String(request.data?.clientId || '').trim();
    const clientSecret = String(request.data?.clientSecret || '').trim();
    if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
        clientSecret.length < 12 || clientSecret.length > 300) invalid('Enter a Google Web application client ID and client secret.');
    await calendarConfigRef(db).set({ clientId, clientSecret, updatedBy: user.uid, updatedAt: FieldValue.serverTimestamp() });
    return { saved: true };
  });

  const beginCalendarConnect = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const config = (await calendarConfigRef(db).get()).data();
    if (!config?.clientId || !config?.clientSecret) unavailable('The master admin needs to set up Google Calendar first.');
    const state = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(state).digest('hex');
    await db.doc(`calendarOAuthStates/${hash}`).create({ uid: user.uid, expiresAt: Timestamp.fromMillis(Date.now() + 10 * minuteMs) });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [key, value] of Object.entries({
      client_id: config.clientId, redirect_uri: callbackUrl(), response_type: 'code',
      scope, access_type: 'offline', prompt: 'consent select_account', state
    })) url.searchParams.set(key, value);
    return { url: url.href };
  });

  const calendarOAuthCallback = onRequest({ region: 'us-west2', maxInstances: 10 }, async (request, response) => {
    const state = typeof request.query.state === 'string' ? request.query.state : '';
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    const redirect = result => response.redirect(303, `${siteUrl}?calendar=${result}`);
    if (!/^[a-f0-9]{64}$/.test(state) || !code) return redirect('error');
    try {
      const hash = createHash('sha256').update(state).digest('hex');
      const stateRef = db.doc(`calendarOAuthStates/${hash}`);
      const uid = await db.runTransaction(async transaction => {
        const saved = await transaction.get(stateRef);
        if (!saved.exists || saved.data().expiresAt.toMillis() < Date.now()) unavailable('Calendar connection expired. Try again.');
        transaction.delete(stateRef);
        return saved.data().uid;
      });
      await assertAdmin(uid);
      const config = (await calendarConfigRef(db).get()).data();
      if (!config?.clientId || !config?.clientSecret) unavailable('Calendar setup is incomplete.');
      const token = await tokenResponse({
        code, client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: callbackUrl(), grant_type: 'authorization_code'
      });
      if (!token.refresh_token) unavailable('Google did not grant ongoing calendar access. Connect again.');
      const identityResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${token.access_token}` }
      });
      const identity = await identityResponse.json();
      if (!identityResponse.ok || !identity.email_verified || !identity.email) {
        unavailable('Google could not confirm the calendar account. Connect again.');
      }
      await connectionRef(db, uid).set({
        refreshToken: token.refresh_token, oauthClientId: config.clientId,
        googleEmail: identity.email, connectedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return redirect('connected');
    } catch { return redirect('error'); }
  });

  const disconnectCalendar = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const interviews = await db.collection('users').where('interview.contactAdminUid', '==', user.uid).get();
    if (interviews.docs.some(item => item.data().interview?.source === 'calendar')) {
      unavailable('Cancel your booked calendar interviews before disconnecting.');
    }
    const invitations = await db.collection('users').where('bookingInvite.adminUid', '==', user.uid).get();
    if (invitations.docs.some(item => ['open', 'booking'].includes(item.data().bookingInvite?.status) &&
        item.data().bookingInvite?.expiresAt?.toMillis?.() > Date.now())) {
      unavailable('Withdraw your open booking invitations before disconnecting.');
    }
    const ref = connectionRef(db, user.uid);
    const connection = await ref.get();
    if (connection.data()?.refreshToken) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: connection.data().refreshToken })
      }).catch(() => {});
    }
    await ref.delete();
    return { disconnected: true };
  });

  const saveCalendarAvailability = onCall(options, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const availability = cleanAvailability(request.data);
    const ref = connectionRef(db, user.uid);
    const [connection, config] = await Promise.all([ref.get(), calendarConfigRef(db).get()]);
    if (!connection.data()?.refreshToken || connection.data()?.oauthClientId !== config.data()?.clientId) {
      unavailable('Connect your Google Calendar first.');
    }
    await ref.update({ availability });
    return { saved: true };
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
    const connection = (await connectionRef(db, user.uid).get()).data();
    if (!connection?.refreshToken || !connection.availability) unavailable('Connect your calendar and set booking hours first.');
    await accessToken(db, user.uid);
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
        adminUid: user.uid, adminEmail: connection.googleEmail || user.token.email || 'Homesteader admin',
        mode, note, meetingLink,
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
      const invite = profile.data()?.bookingInvite;
      if (!invite || invite.status !== 'open') unavailable('There is no open booking invitation.');
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
    await recoverStaleInvite(user.uid);
    const [blocked, admin, profile] = await Promise.all([
      db.doc(`blockedUsers/${user.uid}`).get(), db.doc(`admins/${user.uid}`).get(), db.doc(`users/${user.uid}`).get()
    ]);
    if (blocked.exists || admin.exists || !profile.exists) throw new HttpsError('permission-denied', 'Applicant access required.');
    const invite = activeInvite(profile.data());
    if (invite.status !== 'open') unavailable('Your booking is being processed. Refresh shortly.');
    const result = await availableSlots(db, invite.adminUid);
    if (invite.adminEmail?.toLowerCase() !== result.calendarEmail.toLowerCase()) {
      unavailable('The admin changed calendars. Ask for a new booking invitation.');
    }
    return { slots: result.slots, timeZone: result.availability.timeZone, timeZoneLabel: result.availability.timeZoneLabel };
  });

  const bookInterviewSlot = onCall({ ...options, timeoutSeconds: 120 }, async request => {
    const user = caller(request);
    await recoverStaleInvite(user.uid);
    const start = String(request.data?.start || '');
    const startMs = new Date(start).getTime();
    if (!Number.isFinite(startMs) || new Date(startMs).toISOString() !== start) invalid('Choose an available interview time.');
    const profileRef = db.doc(`users/${user.uid}`);
    const [blocked, admin, profile] = await Promise.all([
      db.doc(`blockedUsers/${user.uid}`).get(), db.doc(`admins/${user.uid}`).get(), profileRef.get()
    ]);
    if (blocked.exists || admin.exists || !profile.exists) throw new HttpsError('permission-denied', 'Applicant access required.');
    const invite = activeInvite(profile.data());
    if (invite.status !== 'open') unavailable('A booking is already in progress. Refresh shortly.');
    const adminUid = invite.adminUid;
    const initial = await availableSlots(db, adminUid);
    if (invite.adminEmail?.toLowerCase() !== initial.calendarEmail.toLowerCase()) {
      unavailable('The admin changed calendars. Ask for a new booking invitation.');
    }
    if (!initial.slots.includes(start)) unavailable('That time is no longer available. Choose another.');
    const calendarKey = createHash('sha256').update(initial.calendarEmail.toLowerCase()).digest('hex').slice(0, 32);
    const intervalStart = startMs;
    const intervalEnd = startMs + (initial.availability.durationMinutes + initial.availability.bufferMinutes) * minuteMs;
    const lockRefs = [];
    for (let bucket = intervalStart; bucket < intervalEnd; bucket += 15 * minuteMs) {
      lockRefs.push(db.doc(`calendarSlotLocks/${calendarKey}_${bucket}`));
    }
    const requestId = randomBytes(16).toString('hex');
    await db.runTransaction(async transaction => {
      const [latest, ...locks] = await Promise.all([transaction.get(profileRef), ...lockRefs.map(ref => transaction.get(ref))]);
      const currentInvite = activeInvite(latest.data());
      if (currentInvite.status !== 'open' || currentInvite.adminUid !== adminUid) unavailable('The invitation changed. Refresh and try again.');
      if (locks.some(lock => lock.exists && lock.data().expiresAt?.toMillis?.() > Date.now())) {
        unavailable('That time was just booked. Choose another.');
      }
      for (const ref of lockRefs) transaction.set(ref, {
        uid: user.uid, requestId, expiresAt: Timestamp.fromMillis(Date.now() + 3 * minuteMs)
      });
      transaction.update(profileRef, {
        'bookingInvite.status': 'booking', 'bookingInvite.requestId': requestId,
        'bookingInvite.startedAt': Timestamp.now(), 'bookingInvite.start': start,
        'bookingInvite.lockIds': lockRefs.map(ref => ref.id)
      });
    });
    let inserted = false;
    let eventKey = '';
    try {
      const result = await availableSlots(db, adminUid);
      if (!result.slots.includes(start)) unavailable('That time is no longer available. Choose another.');
      const latest = (await profileRef.get()).data();
      if (latest?.bookingInvite?.requestId !== requestId) unavailable('The invitation changed. Refresh and try again.');
      const end = new Date(startMs + result.availability.durationMinutes * minuteMs).toISOString();
      eventKey = eventId(user.uid, start);
      const event = {
        id: eventKey, summary: `Homesteader interview: ${latest.profile?.name || 'Applicant'}`,
        description: `Interview arranged through Homesteader.${invite.note ? `\n${invite.note}` : ''}`,
        start: { dateTime: start, timeZone: result.availability.timeZone },
        end: { dateTime: end, timeZone: result.availability.timeZone },
        attendees: [{ email: latest.email || user.token.email }],
        extendedProperties: { private: { applicantUid: user.uid, bookingRequestId: requestId } },
        ...(invite.meetingLink ? { location: invite.meetingLink } : {})
      };
      await calendarRequest(result.token, 'calendars/primary/events?sendUpdates=all', 'POST', event);
      inserted = true;
      await db.runTransaction(async transaction => {
        const conversationRef = db.doc(`conversations/${user.uid}`);
        const [current, conversation, currentBlock] = await Promise.all([
          transaction.get(profileRef), transaction.get(conversationRef), transaction.get(db.doc(`blockedUsers/${user.uid}`))
        ]);
        if (currentBlock.exists) unavailable('This applicant is unavailable.');
        if (current.data()?.bookingInvite?.requestId !== requestId) unavailable('The invitation changed. Refresh and try again.');
        const interview = {
          source: 'calendar', mode: invite.mode, scheduledAt: Timestamp.fromMillis(startMs),
          timeZone: result.availability.timeZone, timeZoneLabel: result.availability.timeZoneLabel,
          note: invite.note, meetingLink: invite.meetingLink, contactAdminUid: adminUid,
          contactAdminEmail: invite.adminEmail, calendarEventId: eventKey,
          bookingLockIds: lockRefs.map(ref => ref.id),
          updatedAt: FieldValue.serverTimestamp()
        };
        transaction.update(profileRef, { interview, bookingInvite: FieldValue.delete() });
        transaction.set(db.doc(`applicantSummaries/${user.uid}`), {
          interviewMode: invite.mode, interviewAt: Timestamp.fromMillis(startMs)
        }, { merge: true });
        if (conversation.exists) transaction.create(conversationRef.collection('messages').doc(), {
          senderUid: adminUid, senderRole: 'admin', createdAt: FieldValue.serverTimestamp(),
          text: `Your ${invite.mode === 'in-person' ? 'in-person' : invite.mode} interview is booked for ${new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: result.availability.timeZone }).format(new Date(startMs))} ${result.availability.timeZoneLabel}. Google Calendar has sent an invitation to your email.`
        });
      });
      const lockBatch = db.batch();
      for (const ref of lockRefs) lockBatch.update(ref, {
        expiresAt: Timestamp.fromMillis(startMs + result.availability.durationMinutes * minuteMs)
      });
      await lockBatch.commit().catch(() => {});
      return { booked: true };
    } catch (error) {
      if (inserted && eventKey) {
        try {
          const { token } = await accessToken(db, adminUid);
          await calendarRequest(token, `calendars/primary/events/${eventKey}?sendUpdates=all`, 'DELETE');
        } catch { /* A retry can reconcile an event that Google already accepted. */ }
      }
      await db.runTransaction(async transaction => {
        const [current, ...locks] = await Promise.all([transaction.get(profileRef), ...lockRefs.map(ref => transaction.get(ref))]);
        if (current.data()?.bookingInvite?.requestId === requestId) transaction.update(profileRef, {
          'bookingInvite.status': 'open', 'bookingInvite.requestId': FieldValue.delete(),
          'bookingInvite.startedAt': FieldValue.delete(), 'bookingInvite.start': FieldValue.delete(),
          'bookingInvite.lockIds': FieldValue.delete()
        });
        locks.forEach((lock, index) => {
          if (lock.data()?.requestId === requestId) transaction.delete(lockRefs[index]);
        });
      }).catch(() => {});
      throw error;
    }
  });

  const cancelCalendarInterview = onCall({ ...options, timeoutSeconds: 120 }, async request => {
    const user = caller(request);
    await assertAdmin(user.uid);
    const uid = request.data?.uid;
    if (typeof uid !== 'string' || !uid || uid.includes('/')) invalid('Choose an applicant.');
    const profileRef = db.doc(`users/${uid}`);
    const profile = await profileRef.get();
    const interview = profile.data()?.interview;
    if (interview?.source !== 'calendar' || !interview.calendarEventId || !interview.contactAdminUid) unavailable('No calendar interview is scheduled.');
    const { token } = await accessToken(db, interview.contactAdminUid);
    try { await calendarRequest(token, `calendars/primary/events/${interview.calendarEventId}?sendUpdates=all`, 'DELETE'); }
    catch (error) { if (error.calendarStatus !== 404) throw error; }
    await db.runTransaction(async transaction => {
      const conversationRef = db.doc(`conversations/${uid}`);
      const [current, conversation] = await Promise.all([transaction.get(profileRef), transaction.get(conversationRef)]);
      if (current.data()?.interview?.calendarEventId !== interview.calendarEventId) unavailable('The interview changed. Refresh and try again.');
      transaction.update(profileRef, { interview: FieldValue.delete() });
      transaction.set(db.doc(`applicantSummaries/${uid}`), {
        interviewMode: FieldValue.delete(), interviewAt: FieldValue.delete()
      }, { merge: true });
      for (const id of interview.bookingLockIds || []) transaction.delete(db.doc(`calendarSlotLocks/${id}`));
      if (conversation.exists) transaction.create(conversationRef.collection('messages').doc(), {
        senderUid: user.uid, senderRole: 'admin', createdAt: FieldValue.serverTimestamp(),
        text: 'Your booked interview has been canceled. An admin will contact you about a new time.'
      });
    });
    return { canceled: true };
  });

  return {
    calendarStatus, saveCalendarIntegration, beginCalendarConnect, calendarOAuthCallback,
    disconnectCalendar, saveCalendarAvailability, inviteToBook, revokeBookingInvite,
    listInterviewSlots, bookInterviewSlot, cancelCalendarInterview
  };
}
