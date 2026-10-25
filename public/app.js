import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, onSnapshot, query, orderBy } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { normalizeExternalUrl } from './links.js';
import { questions } from './questions.js';
import { buildSkillCatalog } from './skills.js';

const $ = id => document.getElementById(id);
$('open-private-profiles').addEventListener('click', event => {
  event.preventDefault();
  location.href = `profiles.html?open=${Date.now()}`;
});
const configured = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME' && firebaseConfig.projectId !== 'REPLACE_ME' && firebaseConfig.appId !== 'REPLACE_ME' && appCheckSiteKey && appCheckSiteKey !== 'REPLACE_ME';
if (!configured) {
  $('setup').hidden = false;
  $('initial-loading').hidden = true;
  document.body.classList.remove('app-loading');
} else {
  start();
}

function start() {
  const app = initializeApp(firebaseConfig);
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, 'us-west2');
  const saveProfileCall = httpsCallable(functions, 'saveProfile');
  const sendMessageCall = httpsCallable(functions, 'sendMessage');
  const sanitizeMyContactsCall = httpsCallable(functions, 'sanitizeMyContacts');
  const listInterviewSlotsCall = httpsCallable(functions, 'listInterviewSlots');
  const bookInterviewSlotCall = httpsCallable(functions, 'bookInterviewSlot');
  const claimAdminEmailCall = httpsCallable(functions, 'claimAdminEmail');
  const addAdminEmailCall = httpsCallable(functions, 'addAdminEmail');
  let currentUser = null;
  let currentProfile = null;
  let isAdmin = false;
  let pendingPhotos = null;
  let profileInitialized = false;
  let memberConversationUnsub = null;
  let profileUnsub = null;
  let questionnaireUnsub = null;
  let questionnaireConfigUnsub = null;
  let questionnaireSaved = null;
  let questionnaireSettings = null;
  let skillsUnsub = null;
  let skillCatalogUnsub = null;
  let memberSkillEntries = [];
  let memberSkillCatalog = buildSkillCatalog();
  let rosterTeamsUnsub = null;
  let rosterSummariesUnsub = null;
  let rosterMemberUnsubs = new Map();
  let rosterTeams = [];
  let rosterMembers = new Map();
  let rosterMemberErrors = new Map();
  let rosterSummaries = new Map();
  let rosterSummariesReady = false;
  let rosterTeamsReady = false;
  let rosterError = '';
  let authGeneration = 0;
  let shownBookingInvite = '';
  const rosterCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
  const photoPreview = document.createElement('img');
  photoPreview.className = 'photo-hover-preview';
  photoPreview.alt = '';
  photoPreview.hidden = true;
  document.body.append(photoPreview);

  function hidePhotoPreview() {
    photoPreview.hidden = true;
    photoPreview.removeAttribute('src');
  }
  function positionPhotoPreview(x, y) {
    const width = Math.min(330, window.innerWidth - 24);
    const height = Math.min(330, window.innerHeight - 24);
    photoPreview.style.left = `${Math.max(12, Math.min(x + 18, window.innerWidth - width - 12))}px`;
    photoPreview.style.top = `${Math.max(12, Math.min(y + 18, window.innerHeight - height - 12))}px`;
  }
  function attachPhotoPreview(img) {
    img.tabIndex = 0;
    img.addEventListener('mouseenter', event => {
      photoPreview.src = img.src;
      photoPreview.hidden = false;
      positionPhotoPreview(event.clientX, event.clientY);
    });
    img.addEventListener('mousemove', event => positionPhotoPreview(event.clientX, event.clientY));
    img.addEventListener('mouseleave', hidePhotoPreview);
    img.addEventListener('focus', () => {
      const rect = img.getBoundingClientRect();
      photoPreview.src = img.src;
      photoPreview.hidden = false;
      positionPhotoPreview(rect.right, rect.top);
    });
    img.addEventListener('blur', hidePhotoPreview);
  }
  window.addEventListener('scroll', hidePhotoPreview, { passive: true });
  window.addEventListener('resize', hidePhotoPreview);

  function status(id, text, error = false) {
    const el = $(id);
    el.textContent = text;
    el.className = `message ${error ? 'error' : 'success'}`;
  }
  function showView(id) {
    for (const view of ['auth-view', 'member-view', 'admin-view']) $(view).hidden = view !== id;
    $('initial-loading').hidden = true;
    document.body.classList.remove('app-loading');
  }
  function cleanSubscriptions() {
    for (const unsub of [memberConversationUnsub, profileUnsub, questionnaireUnsub, questionnaireConfigUnsub, skillsUnsub, skillCatalogUnsub, rosterTeamsUnsub, rosterSummariesUnsub]) if (unsub) unsub();
    for (const unsub of rosterMemberUnsubs.values()) unsub();
    memberConversationUnsub = profileUnsub = questionnaireUnsub = questionnaireConfigUnsub = skillsUnsub = skillCatalogUnsub = rosterTeamsUnsub = rosterSummariesUnsub = null;
    memberSkillEntries = [];
    memberSkillCatalog = buildSkillCatalog();
    rosterMemberUnsubs = new Map();
    rosterTeams = [];
    rosterMembers = new Map();
    rosterMemberErrors = new Map();
    rosterSummaries = new Map();
    rosterSummariesReady = false;
    rosterTeamsReady = false;
    rosterError = '';
    $('admin-team-grid').replaceChildren();
    status('admin-roster-status', 'Loading teams...');
  }
  function renderAdminRoster() {
    const grid = $('admin-team-grid');
    grid.replaceChildren();
    status('admin-roster-status', rosterError || (!rosterTeamsReady ? 'Loading teams...' :
      rosterTeams.length ? '' : 'No teams yet. Create a team from an applicant profile.'), Boolean(rosterError));
    for (const team of rosterTeams) {
      const card = document.createElement('article');
      card.className = 'admin-team-card';
      const title = document.createElement('h3');
      title.textContent = team.name || 'Unnamed team';
      const count = document.createElement('p');
      count.className = 'admin-team-count';
      const ids = rosterMembers.get(team.id);
      count.textContent = ids ? `${ids.length} ${ids.length === 1 ? 'applicant' : 'applicants'}` :
        rosterMemberErrors.get(team.id) || 'Loading members...';
      card.append(title, count);
      if (ids?.length) {
        const list = document.createElement('ul');
        list.className = 'admin-team-members';
        const sorted = [...ids].sort((a, b) => rosterCollator.compare(
          rosterSummaries.get(a)?.name || '', rosterSummaries.get(b)?.name || ''));
        for (const uid of sorted) {
          const item = document.createElement('li');
          const person = rosterSummaries.get(uid);
          if (person) {
            const link = document.createElement('a');
            link.className = 'admin-team-member';
            link.href = `profiles.html?applicant=${encodeURIComponent(uid)}`;
            const name = document.createElement('strong');
            name.textContent = person.name || 'Unnamed applicant';
            const detail = document.createElement('span');
            detail.textContent = person.email || person.location || 'Open private profile';
            link.append(name, detail);
            item.append(link);
          } else {
            item.className = 'admin-team-member';
            item.textContent = rosterSummariesReady ? 'Applicant information unavailable' : 'Loading applicant name...';
          }
          list.append(item);
        }
        card.append(list);
      } else if (ids) {
        const empty = document.createElement('p');
        empty.className = 'admin-team-empty';
        empty.textContent = 'No applicants on this team yet.';
        card.append(empty);
      }
      grid.append(card);
    }
  }
  function watchAdminRoster(generation) {
    rosterSummariesUnsub = onSnapshot(collection(db, 'applicantSummaries'), snapshot => {
      if (generation !== authGeneration) return;
      rosterSummaries = new Map(snapshot.docs.map(item => [item.id, item.data()]));
      rosterSummariesReady = true;
      renderAdminRoster();
    }, error => {
      if (generation !== authGeneration) return;
      rosterError = error.message || 'Could not load applicant names.';
      rosterSummariesReady = true;
      renderAdminRoster();
    });
    rosterTeamsUnsub = onSnapshot(collection(db, 'teams'), snapshot => {
      if (generation !== authGeneration) return;
      rosterTeams = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => rosterCollator.compare(a.name || '', b.name || ''));
      rosterTeamsReady = true;
      const currentIds = new Set(rosterTeams.map(team => team.id));
      for (const [teamId, unsub] of rosterMemberUnsubs) {
        if (currentIds.has(teamId)) continue;
        unsub();
        rosterMemberUnsubs.delete(teamId);
        rosterMembers.delete(teamId);
        rosterMemberErrors.delete(teamId);
      }
      for (const team of rosterTeams) {
        if (rosterMemberUnsubs.has(team.id)) continue;
        const unsub = onSnapshot(collection(db, 'teams', team.id, 'members'), members => {
          if (generation !== authGeneration) return;
          rosterMembers.set(team.id, members.docs.map(item => item.id));
          rosterMemberErrors.delete(team.id);
          renderAdminRoster();
        }, error => {
          if (generation !== authGeneration) return;
          rosterMemberErrors.set(team.id, error.message || 'Could not load members.');
          renderAdminRoster();
        });
        rosterMemberUnsubs.set(team.id, unsub);
      }
      renderAdminRoster();
    }, error => {
      if (generation !== authGeneration) return;
      rosterError = error.message || 'Could not load teams.';
      renderAdminRoster();
    });
  }
  function updateQuestionnaireStatus() {
    if (!questionnaireSaved) {
      $('questionnaire-status').textContent = 'Not completed yet.';
      return;
    }
    const currentQuestions = questionnaireSettings?.questions || questions;
    const questionValues = value => JSON.stringify(value.map(question =>
      [question.section, question.prompt, question.choices]));
    const current = questionnaireSaved.version === 2 ?
      questionnaireSaved.revision === (questionnaireSettings?.questionRevision || 0) :
      questionnaireSaved.version === 1 && questionValues(currentQuestions) === questionValues(questions);
    $('questionnaire-status').textContent = current ?
      'Completed. You can update your answers.' : 'The questions changed. Please update your answers.';
  }
  function updateSkillStatus() {
    const count = memberSkillEntries.filter(entry => memberSkillCatalog.byId.has(String(entry.id))).length;
    $('skills-status').textContent = count ? `${count} skills saved. You can update them.` : 'No skills added yet.';
  }
  $('google-sign-in').addEventListener('click', async () => {
    const button = $('google-sign-in');
    button.disabled = true;
    status('auth-message', '');
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      status('auth-message', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  $('sign-out').addEventListener('click', () => signOut(auth));
  $('home-add-admin-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter || event.target.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await addAdminEmailCall({ email: $('home-admin-email').value.trim() });
      if (result.data.state === 'added') {
        $('home-admin-email').value = '';
        status('home-admin-message', 'Admin email saved. They will get access when they sign in with that Google account.');
      } else {
        status('home-admin-message', result.data.state === 'active' ? 'This account is already an admin.' : 'This email is already waiting for sign-in.');
      }
    } catch (error) { status('home-admin-message', readableError(error), true); }
    finally { button.disabled = false; }
  });

  onAuthStateChanged(auth, async user => {
    const generation = ++authGeneration;
    cleanSubscriptions();
    currentUser = user;
    currentProfile = null;
    questionnaireSaved = null;
    questionnaireSettings = null;
    profileInitialized = false;
    pendingPhotos = null;
    shownBookingInvite = '';
    $('sign-out').hidden = !user;
    $('account-email').hidden = !user;
    $('account-email').textContent = user?.email || '';
    if (!user) return showView('auth-view');
    try {
      const token = await user.getIdTokenResult();
      if (token.claims.firebase?.sign_in_provider !== 'google.com') {
        await signOut(auth);
        status('auth-message', 'Please sign in with Google.');
        return;
      }
      if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) {
        await signOut(auth);
        status('auth-message', 'This account has been blocked.', true);
        return;
      }
      isAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists();
      if (!isAdmin) isAdmin = (await claimAdminEmailCall()).data.admin === true;
      if (generation !== authGeneration) return;
      if (isAdmin) {
        const isMasterAdmin = user.email?.toLowerCase() === 'titanbusinesspros@gmail.com';
        $('admin-home-management').hidden = !isMasterAdmin;
        $('admin-homestead-link').textContent = isMasterAdmin ?
          'Edit homestead page' : 'View homestead page';
        showView('admin-view');
        watchAdminRoster(generation);
      } else {
        await sanitizeMyContactsCall();
        if (generation !== authGeneration) return;
        showView('member-view');
        watchProfile(user.uid);
        questionnaireUnsub = onSnapshot(doc(db, 'questionnaires', user.uid), snapshot => {
          questionnaireSaved = snapshot.exists() ? snapshot.data() : null;
          updateQuestionnaireStatus();
        }, error => status('profile-message', readableError(error), true));
        questionnaireConfigUnsub = onSnapshot(doc(db, 'questionnaireConfig', 'main'), snapshot => {
          questionnaireSettings = snapshot.data() || null;
          $('questionnaire-section').hidden = questionnaireSettings?.enabled === false;
          updateQuestionnaireStatus();
        }, error => status('profile-message', readableError(error), true));
        skillsUnsub = onSnapshot(doc(db, 'skills', user.uid), snapshot => {
          memberSkillEntries = snapshot.exists() ? (snapshot.data().entries || []) : [];
          updateSkillStatus();
        }, error => status('profile-message', readableError(error), true));
        skillCatalogUnsub = onSnapshot(collection(db, 'skillCatalog'), snapshot => {
          if (generation !== authGeneration) return;
          memberSkillCatalog = buildSkillCatalog(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
          updateSkillStatus();
        }, error => status('profile-message', readableError(error), true));
        watchMemberConversation(user.uid);
      }
    } catch (error) {
      showView('auth-view');
      status('auth-message', `Could not load your account: ${readableError(error)}`, true);
    }
  });

  function savedPhotos() {
    return currentProfile?.photos || (currentProfile?.photoDataUrl ? [currentProfile.photoDataUrl] : []);
  }
  function photosCanChange() {
    const changedAt = currentProfile?.photoChangedAt?.toDate?.();
    return !savedPhotos().length || !changedAt || Date.now() - changedAt.getTime() >= 30 * 24 * 60 * 60 * 1000;
  }
  function renderPhotos() {
    const photos = pendingPhotos === null ? savedPhotos() : pendingPhotos;
    const canChange = photosCanChange();
    const list = $('photo-list');
    hidePhotoPreview();
    list.replaceChildren();
    for (const [index, src] of photos.entries()) {
      const item = document.createElement('div');
      item.className = 'photo-item';
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Profile photo ${index + 1}`;
      attachPhotoPreview(img);
      item.append(img);
      if (canChange) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          pendingPhotos = [...photos];
          pendingPhotos.splice(index, 1);
          renderPhotos();
        });
        item.append(remove);
      }
      list.append(item);
    }
    $('profile-photo').disabled = !canChange || photos.length >= 3;
    $('photo-help').textContent = canChange
      ? `${photos.length} of 3 photos. You can change the set once every 30 days. JPG, PNG, or WebP.`
      : `Photos can be changed again ${new Date(currentProfile.photoChangedAt.toDate().getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}.`;
  }
  function watchProfile(uid) {
    profileUnsub = onSnapshot(doc(db, 'users', uid), snapshot => {
      currentProfile = snapshot.exists() ? snapshot.data() : null;
      const profile = currentProfile;
      $('profile-status').textContent = statusLabel(profile?.status || 'none');
      renderInterview(profile?.interview);
      renderBookingInvite(profile?.bookingInvite, profile?.interview);
      if (!profileInitialized) {
        $('profile-name').value = profile?.profile?.name || '';
        $('profile-location').value = profile?.profile?.location || '';
        $('profile-bio').value = profile?.bio || '';
        $('profile-website').value = profile?.website || '';
        for (let index = 1; index <= 3; index++) {
          $(`profile-social-${index}`).value = profile?.socialLinks?.[index - 1] || '';
        }
        updateWordCount();
        profileInitialized = true;
      }
      if (pendingPhotos === null) renderPhotos();
    }, error => status('profile-message', readableError(error), true));
  }
  function renderInterview(interview) {
    const date = interview?.scheduledAt?.toDate?.();
    $('interview-notice').hidden = !date;
    if (!date) return;
    const label = ({ phone: 'Phone', 'in-person': 'In-person', zoom: 'Zoom' })[interview.mode] || 'Interview';
    $('interview-heading').textContent = `${label} interview`;
    let scheduled = date.toLocaleString();
    let timeZoneLabel = interview.timeZoneLabel || '';
    try {
      const zone = interview.timeZone || undefined;
      scheduled = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: zone }).format(date);
      if (!timeZoneLabel) timeZoneLabel = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
        .formatToParts(date).find(part => part.type === 'timeZoneName')?.value || '';
    } catch { /* Older invitations can fall back to the applicant's local time. */ }
    $('interview-time').textContent = `Scheduled for ${scheduled}${timeZoneLabel ? ` ${timeZoneLabel}` : ''}. Your local time: ${date.toLocaleString()}.`;
    $('interview-admin').textContent = `Your contact: ${interview.source === 'calendar' ? (interview.contactAdminEmail || 'a Homesteader admin') : 'a Homesteader admin'}`;
    $('interview-help').textContent = interview.source === 'calendar' ?
      'Your time is booked in Homesteader. Reply in your private inbox if you have questions.' :
      'Reply in your private inbox to confirm the date and time or ask the admin questions.';
    $('interview-note').textContent = interview.note || '';
    $('interview-note').hidden = !interview.note;
    const meeting = $('interview-meeting-link');
    try {
      const link = normalizeExternalUrl(interview.meetingLink);
      meeting.hidden = !link;
      if (link) meeting.href = link;
      else meeting.removeAttribute('href');
    } catch {
      meeting.hidden = true;
      meeting.removeAttribute('href');
    }
  }
  function renderBookingInvite(invite, interview) {
    const visible = invite && ['open', 'booking'].includes(invite.status) &&
      invite.expiresAt?.toMillis?.() > Date.now() && !interview?.scheduledAt;
    $('booking-section').hidden = !visible;
    if (!visible) {
      shownBookingInvite = '';
      $('booking-slots').replaceChildren();
      return;
    }
    $('booking-description').textContent = `${invite.adminEmail || 'A Homesteader admin'} invited you to choose a ${invite.mode === 'in-person' ? 'in-person' : invite.mode} interview time. Choose a time before ${invite.expiresAt.toDate().toLocaleDateString()}.`;
    if (invite.status === 'booking') {
      $('booking-slots').replaceChildren();
      status('booking-message', 'Your booking is processing. Refresh available times after a few minutes if it does not finish.');
      return;
    }
    const key = `${invite.adminUid}:${invite.createdAt?.toMillis?.()}`;
    if (shownBookingInvite !== key) {
      shownBookingInvite = key;
      $('booking-slots').replaceChildren();
      status('booking-message', 'Loading available times...');
      loadBookingSlots();
    }
  }
  async function loadBookingSlots() {
    const button = $('refresh-booking-slots');
    button.disabled = true;
    try {
      const { data } = await listInterviewSlotsCall();
      const slots = $('booking-slots');
      slots.replaceChildren();
      for (const start of data.slots || []) {
        const date = new Date(start);
        const local = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
        const adminTime = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: data.timeZone }).format(date);
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = 'secondary-button booking-slot';
        slot.textContent = `${local} your time · ${adminTime} ${data.timeZoneLabel}`;
        slot.addEventListener('click', () => bookSlot(start));
        slots.append(slot);
      }
      status('booking-message', data.slots?.length ? 'Choose the time that works for you.' : 'No times are available right now. Please check again later or message the admin.');
    } catch (error) { status('booking-message', readableError(error), true); }
    finally { button.disabled = false; }
  }
  async function bookSlot(start) {
    const buttons = $('booking-slots').querySelectorAll('button');
    for (const button of buttons) button.disabled = true;
    status('booking-message', 'Booking your interview...');
    try {
      await bookInterviewSlotCall({ start });
      status('booking-message', 'Interview booked. You can see it on your profile and in your private inbox.');
      $('booking-slots').replaceChildren();
    } catch (error) {
      status('booking-message', readableError(error), true);
      for (const button of buttons) button.disabled = false;
      await loadBookingSlots();
    }
  }
  $('refresh-booking-slots').addEventListener('click', loadBookingSlots);
  function updateWordCount() {
    const count = $('profile-bio').value.trim().split(/\s+/).filter(Boolean).length;
    $('word-count').textContent = `${count} / 500 words`;
    $('word-count').style.color = count > 500 ? '#a33d2f' : '';
    return count;
  }
  $('profile-bio').addEventListener('input', updateWordCount);
  $('profile-photo').addEventListener('change', async event => {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    try {
      const current = pendingPhotos === null ? savedPhotos() : pendingPhotos;
      if (!photosCanChange() || current.length + files.length > 3) throw new Error('You can keep no more than three photos.');
      const prepared = await Promise.all(files.map(preparePhoto));
      pendingPhotos = [...current, ...prepared];
      renderPhotos();
      status('profile-message', 'Photos ready. Save your introduction to keep them.');
    } catch (error) {
      status('profile-message', error.message, true);
    }
    event.target.value = '';
  });
  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('profile-name').value.trim();
    const location = $('profile-location').value.trim();
    const bio = $('profile-bio').value.trim();
    let website;
    let socialLinks;
    try {
      website = normalizeExternalUrl($('profile-website').value);
      socialLinks = [1, 2, 3].map(index => normalizeExternalUrl($(`profile-social-${index}`).value)).filter(Boolean);
    } catch (error) {
      return status('profile-message', error.message, true);
    }
    if (!name || !bio) return status('profile-message', 'Add a name and introduction.', true);
    if (updateWordCount() > 500) return status('profile-message', 'Keep your introduction within 500 words.', true);
    const button = $('save-profile');
    button.disabled = true;
    const data = { profile: { name, location }, bio, website, socialLinks, photos: pendingPhotos === null ? savedPhotos() : pendingPhotos };
    try {
      await saveProfileCall(data);
      pendingPhotos = null;
      renderPhotos();
      status('profile-message', 'Your introduction has been saved for admin review.');
    } catch (error) {
      status('profile-message', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function watchMemberConversation(uid) {
    memberConversationUnsub = onSnapshot(query(collection(db, 'conversations', uid, 'messages'), orderBy('createdAt', 'asc')), snapshot => {
      const opened = !snapshot.empty;
      $('inbox-empty').hidden = opened;
      $('member-chat').hidden = !opened;
      $('inbox-contact').hidden = !opened;
      $('inbox-contact').textContent = opened ?
        'A Homesteader admin is your contact. Homesteader admins can review this conversation.' : '';
      if (opened) renderMessages('member-messages', snapshot, uid);
    }, error => status('member-message-status', readableError(error), true));
  }
  $('member-message-form').addEventListener('submit', async event => {
    event.preventDefault();
    const text = $('member-message').value.trim();
    if (!text || !currentUser) return;
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await sendMessageCall({ targetUid: currentUser.uid, text });
      $('member-message').value = '';
      status('member-message-status', 'Reply sent.');
    } catch (error) {
      status('member-message-status', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function renderMessages(id, snapshot, myUid) {
    const container = $(id);
    container.replaceChildren();
    snapshot.forEach(item => {
      const message = item.data();
      const bubble = document.createElement('div');
      bubble.className = `bubble ${message.senderUid === myUid ? 'mine' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'bubble-meta';
      const date = message.createdAt?.toDate?.();
      meta.textContent = `${message.senderRole === 'admin' ? 'Admin' : 'Applicant'}${date ? ` · ${date.toLocaleString()}` : ''}`;
      const body = document.createElement('div');
      body.textContent = message.senderRole === 'admin' ?
        message.text.replace(/\b\S+@\S+\s+is your contact\./g, 'A Homesteader admin is your contact.') : message.text;
      bubble.append(meta, body);
      container.append(bubble);
    });
    container.scrollTop = container.scrollHeight;
  }
  function statusLabel(value) {
    return ({ submitted: 'Submitted', reviewing: 'Reviewing', 'good-fit': 'Good fit', declined: 'Declined', none: 'Not submitted' })[value] || 'Submitted';
  }
  function readableError(error) {
    const map = {
      'auth/popup-closed-by-user': 'Google sign-in was canceled.',
      'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow popups and try again.',
      'auth/unauthorized-domain': 'This website must be added to Firebase Authentication authorized domains.',
      'auth/operation-not-allowed': 'Google sign-in must be enabled in Firebase Authentication.',
      'auth/account-exists-with-different-credential': 'This email has an account using another sign-in method. Contact an admin for help.',
      'permission-denied': 'Access was denied. Check the Firebase rules and admin setup.'
    };
    return map[error.code] || error.message || 'Something went wrong. Please try again.';
  }
}

async function preparePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const result = canvas.toDataURL('image/jpeg', 0.72);
  if (result.length > 200000) throw new Error('This photo is too detailed. Choose a smaller image.');
  return result;
}
