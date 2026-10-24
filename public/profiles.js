import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, onSnapshot, query, orderBy } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { questions } from './questions.js';
import { buildSkillCatalog } from './skills.js';
import { normalizeExternalUrl } from './links.js';

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'us-west2');
const sendMessage = httpsCallable(functions, 'sendMessage');
const setReviewStatus = httpsCallable(functions, 'setReviewStatus');
const manageApplicant = httpsCallable(functions, 'manageApplicant');
const manageInterview = httpsCallable(functions, 'manageInterview');
const addSkill = httpsCallable(functions, 'addSkill');
const saveQuestionnaireConfig = httpsCallable(functions, 'saveQuestionnaireConfig');
const listAdmins = httpsCallable(functions, 'listAdmins');
const removeAdmin = httpsCallable(functions, 'removeAdmin');
const calendarStatus = httpsCallable(functions, 'calendarStatus');
const saveCalendarAvailability = httpsCallable(functions, 'saveCalendarAvailability');
const addCalendarBlock = httpsCallable(functions, 'addCalendarBlock');
const removeCalendarBlock = httpsCallable(functions, 'removeCalendarBlock');
const inviteToBook = httpsCallable(functions, 'inviteToBook');
const revokeBookingInvite = httpsCallable(functions, 'revokeBookingInvite');
const cancelCalendarInterview = httpsCallable(functions, 'cancelCalendarInterview');
const masterAdminEmail = 'titanbusinesspros@gmail.com';
const pageSize = 25;
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
let currentUser = null;
let isMasterAdmin = false;
let applicants = [];
let blocked = new Map();
let selectedUid = null;
let selectedInterviewScheduled = false;
let selectedInterviewSource = '';
let calendarReady = false;
let page = 0;
let summariesUnsub = null;
let blockedUnsub = null;
let profileUnsub = null;
let questionnaireUnsub = null;
let skillsUnsub = null;
let conversationUnsub = null;
let messagesUnsub = null;
let rankingsUnsub = null;
let catalogUnsub = null;
let questionnaireConfigUnsub = null;
let questionnaireDraft = [];
let questionnaireEnabled = true;
let questionnaireRevision = 0;
let questionnaireDirty = false;
let catalog = buildSkillCatalog();
let selectedSkillData = null;
let rankings = [];
let rankPage = 0;
let authGeneration = 0;

const photoPreview = document.createElement('img');
photoPreview.className = 'photo-hover-preview';
photoPreview.alt = '';
photoPreview.hidden = true;
document.body.append(photoPreview);

function status(id, text, error = false) {
  const element = $(id);
  element.textContent = text;
  element.className = `message ${error ? 'error' : 'success'}`;
}

function showAccess(message) {
  $('loading').hidden = true;
  $('profiles-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function cleanSelection() {
  for (const unsub of [profileUnsub, questionnaireUnsub, skillsUnsub, conversationUnsub, messagesUnsub]) if (unsub) unsub();
  profileUnsub = questionnaireUnsub = skillsUnsub = conversationUnsub = messagesUnsub = null;
  selectedUid = null;
  selectedInterviewScheduled = false;
  selectedInterviewSource = '';
  selectedSkillData = null;
  photoPreview.hidden = true;
  $('detail-photos').replaceChildren();
  $('admin-messages').replaceChildren();
  $('admin-detail').hidden = true;
  $('admin-detail-empty').hidden = false;
}

function cleanSubscriptions() {
  cleanSelection();
  for (const unsub of [summariesUnsub, blockedUnsub, rankingsUnsub, catalogUnsub, questionnaireConfigUnsub]) if (unsub) unsub();
  summariesUnsub = blockedUnsub = rankingsUnsub = catalogUnsub = questionnaireConfigUnsub = null;
  rankings = [];
}

function statusLabel(value) {
  return ({ submitted: 'Submitted', reviewing: 'Reviewing', 'good-fit': 'Good fit', declined: 'Declined' })[value] || 'Submitted';
}

function filteredApplicants() {
  const term = $('applicant-search').value.trim().toLowerCase();
  return applicants.filter(person => [person.name, person.location, person.email].some(value => (value || '').toLowerCase().includes(term)));
}

function renderList() {
  const shown = filteredApplicants();
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  page = Math.min(page, pages - 1);
  $('applicant-count').textContent = String(applicants.length);
  $('applicant-empty').hidden = shown.length > 0;
  $('applicant-empty').textContent = applicants.length ? 'No matching profiles.' : 'No profiles submitted yet.';
  $('page-label').textContent = `Page ${page + 1} of ${pages}`;
  $('previous-page').disabled = page === 0;
  $('next-page').disabled = page >= pages - 1;
  const list = $('applicant-list');
  list.replaceChildren();
  shown.slice(page * pageSize, (page + 1) * pageSize).forEach(person => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `applicant-row ${person.uid === selectedUid ? 'selected' : ''}`;
    const name = document.createElement('strong');
    name.textContent = person.name || 'Unnamed';
    const meta = document.createElement('span');
    meta.textContent = `${person.email || ''} · ${blocked.has(person.uid) ? 'Blocked' : statusLabel(person.status)}${person.questionnaireCompletedAt ? ' · Questionnaire complete' : ''}${person.interviewMode ? ' · Interview invited' : ''}`;
    button.append(name, meta);
    button.addEventListener('click', () => selectApplicant(person.uid));
    list.append(button);
  });
}

function rankedApplicants() {
  const byUid = new Map(applicants.map(person => [person.uid, person]));
  return rankings.filter(entry => byUid.has(entry.uid) && !blocked.has(entry.uid))
    .sort((a, b) => b.years - a.years ||
      nameCollator.compare(byUid.get(a.uid).name || '', byUid.get(b.uid).name || ''));
}

function renderRanking() {
  const sorted = rankedApplicants();
  const byUid = new Map(applicants.map(person => [person.uid, person]));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  rankPage = Math.min(rankPage, pages - 1);
  $('skill-rank-count').textContent = String(sorted.length);
  $('rank-page-label').textContent = `Page ${rankPage + 1} of ${pages}`;
  $('rank-previous').disabled = rankPage === 0;
  $('rank-next').disabled = rankPage >= pages - 1;
  $('rank-empty').hidden = sorted.length > 0;
  $('rank-empty').textContent = $('rank-skill').value ? 'No applicants have reported this skill yet.' : 'Choose a skill to see its ranking.';
  const list = $('rank-list');
  list.replaceChildren();
  sorted.slice(rankPage * pageSize, (rankPage + 1) * pageSize).forEach((entry, index) => {
    const person = byUid.get(entry.uid);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rank-row';
    const heading = document.createElement('strong');
    heading.textContent = `${rankPage * pageSize + index + 1}. ${person.name || 'Unnamed'} — ${entry.years} ${entry.years === 1 ? 'year' : 'years'}`;
    const detail = document.createElement('span');
    detail.textContent = `${entry.organization} · ${person.email || ''}`;
    button.append(heading, detail);
    button.addEventListener('click', () => {
      selectApplicant(entry.uid);
      $('admin-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    list.append(button);
  });
}

function renderBlockedList() {
  const list = $('blocked-list');
  list.replaceChildren();
  if (!blocked.size) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No blocked accounts.';
    list.append(empty);
  }
  for (const [uid, info] of blocked) {
    const row = document.createElement('div');
    row.className = 'blocked-row';
    const label = document.createElement('span');
    label.textContent = info.email || uid;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button';
    button.textContent = 'Unblock';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await manageApplicant({ uid, action: 'unblock' }); status('page-message', 'Account unblocked.'); }
      catch (error) { status('page-message', error.message || 'Could not unblock account.', true); }
      finally { button.disabled = false; }
    });
    row.append(label, button);
    list.append(row);
  }
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
  img.addEventListener('mouseleave', () => { photoPreview.hidden = true; });
  img.addEventListener('focus', () => {
    const rect = img.getBoundingClientRect();
    photoPreview.src = img.src;
    photoPreview.hidden = false;
    positionPhotoPreview(rect.right, rect.top);
  });
  img.addEventListener('blur', () => { photoPreview.hidden = true; });
}
window.addEventListener('scroll', () => { photoPreview.hidden = true; }, { passive: true });
window.addEventListener('resize', () => { photoPreview.hidden = true; });

function renderProfile(person) {
  $('admin-detail-empty').hidden = true;
  $('admin-detail').hidden = false;
  $('detail-name').textContent = person.profile?.name || 'Unnamed';
  $('detail-status').textContent = blocked.has(selectedUid) ? 'Blocked' : statusLabel(person.status);
  $('detail-email').textContent = person.email || '';
  $('detail-location').textContent = person.profile?.location ? `Location: ${person.profile.location}` : 'Location not provided';
  $('detail-bio').textContent = person.bio || 'No introduction yet.';
  const links = $('detail-links');
  links.replaceChildren();
  for (const [label, raw] of [
    ['Website', person.website],
    ...(Array.isArray(person.socialLinks) ? person.socialLinks.slice(0, 3).map((url, index) => [`Social media ${index + 1}`, url]) : [])
  ]) {
    try {
      const href = normalizeExternalUrl(raw);
      if (!href) continue;
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = `${label}: ${new URL(href).hostname}`;
      links.append(anchor);
    } catch { /* Ignore invalid links in older profile records. */ }
  }
  photoPreview.hidden = true;
  $('detail-photos').replaceChildren();
  const photos = person.photos || (person.photoDataUrl ? [person.photoDataUrl] : []);
  photos.forEach((src, index) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Applicant photo ${index + 1}`;
    img.className = 'detail-photo';
    attachPhotoPreview(img);
    $('detail-photos').append(img);
  });
  $('review-status').value = person.status || 'submitted';
  $('block-applicant').textContent = blocked.has(selectedUid) ? 'Unblock account' : 'Block account';
  $('save-review').disabled = blocked.has(selectedUid);
  $('admin-send').disabled = blocked.has(selectedUid);
  renderInterviewEditor(person.interview);
  renderBookingInviteEditor(person.bookingInvite, person.interview);
}

function localDateTime(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function readableTimeZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'long' })
      .formatToParts(date).find(part => part.type === 'timeZoneName')?.value || 'local time';
  } catch { return 'local time'; }
}

function toggleMeetingLink() {
  const mode = document.querySelector('input[name="interview-mode"]:checked')?.value;
  $('meeting-link-row').hidden = mode !== 'zoom';
  if (mode !== 'zoom') $('interview-link').value = '';
}

function renderInterviewEditor(interview) {
  const date = interview?.scheduledAt?.toDate?.();
  selectedInterviewScheduled = Boolean(date);
  selectedInterviewSource = interview?.source || '';
  const timeZoneLabel = date ? interview.timeZoneLabel || readableTimeZone(date, interview.timeZone) : '';
  const scheduledTime = date ? new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: interview.timeZone || undefined
  }).format(date) : '';
  $('current-interview').textContent = date ?
    `${({ phone: 'Phone', 'in-person': 'In-person', zoom: 'Zoom' })[interview.mode] || 'Interview'} interview scheduled for ${scheduledTime} ${timeZoneLabel}. Contact: ${interview.contactAdminEmail || 'Homesteader admin'}.` :
    'No interview scheduled.';
  for (const radio of document.querySelectorAll('input[name="interview-mode"]')) radio.checked = radio.value === interview?.mode;
  $('interview-date').value = date ? localDateTime(date) : '';
  $('interview-zone-label').value = timeZoneLabel;
  $('interview-note-input').value = interview?.note || '';
  toggleMeetingLink();
  $('interview-link').value = interview?.meetingLink || '';
  $('schedule-interview').disabled = blocked.has(selectedUid) || selectedInterviewSource === 'calendar';
  $('cancel-interview').disabled = !date || (blocked.has(selectedUid) && selectedInterviewSource !== 'calendar');
}

function renderBookingInviteEditor(invite, interview) {
  const open = invite?.status === 'open' && invite.expiresAt?.toMillis?.() > Date.now();
  $('booking-invite-summary').textContent = open ?
    `An invitation is open until ${invite.expiresAt.toDate().toLocaleDateString()}. ${invite.adminEmail || 'An admin'} is the contact.` :
    calendarReady ? 'The applicant will choose from your available times in Homesteader.' :
      'Save your bookable hours above first.';
  $('send-booking-invite').disabled = !calendarReady || blocked.has(selectedUid) || Boolean(interview?.scheduledAt);
  $('revoke-booking-invite').hidden = !open;
  $('revoke-booking-invite').disabled = blocked.has(selectedUid);
}

function renderCalendarAgenda(data) {
  const blocks = $('calendar-block-list');
  blocks.replaceChildren();
  if (!data.blocks?.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No blocked times.';
    blocks.append(empty);
  }
  for (const block of data.blocks || []) {
    const row = document.createElement('div');
    row.className = 'calendar-agenda-row';
    const label = document.createElement('span');
    label.textContent = `${new Date(block.start).toLocaleString()} to ${new Date(block.end).toLocaleString()}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button';
    button.textContent = 'Remove';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await removeCalendarBlock({ id: block.id });
        status('calendar-block-message', 'Blocked time removed.');
        await loadCalendarStatus();
      } catch (error) {
        status('calendar-block-message', error.message || 'Could not remove blocked time.', true);
        button.disabled = false;
      }
    });
    row.append(label, button);
    blocks.append(row);
  }
  const bookings = $('calendar-booking-list');
  bookings.replaceChildren();
  if (!data.bookings?.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No upcoming interviews.';
    bookings.append(empty);
  }
  for (const booking of data.bookings || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'calendar-agenda-row calendar-agenda-link';
    button.textContent = `${new Date(booking.start).toLocaleString()} · ${booking.name} · ${booking.mode || 'Interview'}`;
    button.addEventListener('click', () => selectApplicant(booking.uid));
    bookings.append(button);
  }
}

async function loadCalendarStatus(generation = authGeneration) {
  try {
    const { data } = await calendarStatus();
    if (generation !== authGeneration) return;
    calendarReady = Boolean(data.availability);
    $('calendar-connection-status').textContent = calendarReady ?
      'Your bookable hours are saved. Invite an applicant below, or block time when you are unavailable.' :
      'Save your bookable hours to start accepting interview bookings.';
    renderCalendarAgenda(data);
    const saved = data.availability || {
      days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', durationMinutes: 30,
      bufferMinutes: 15, leadHours: 24, horizonDays: 14,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago', timeZoneLabel: ''
    };
    for (const day of document.querySelectorAll('input[name="calendar-day"]')) day.checked = saved.days.includes(Number(day.value));
    $('calendar-start').value = saved.startTime;
    $('calendar-end').value = saved.endTime;
    $('calendar-duration').value = String(saved.durationMinutes);
    $('calendar-buffer').value = String(saved.bufferMinutes);
    $('calendar-lead').value = String(saved.leadHours);
    $('calendar-horizon').value = String(saved.horizonDays);
    $('calendar-time-zone').value = saved.timeZone;
    $('calendar-zone-label').value = saved.timeZoneLabel || readableTimeZone(new Date(), saved.timeZone);
    if (selectedUid && !$('admin-detail').hidden) {
      $('send-booking-invite').disabled = !calendarReady || blocked.has(selectedUid) || selectedInterviewScheduled;
    }
  } catch (error) {
    if (generation === authGeneration) status('calendar-status-message', error.message || 'Could not load your interview calendar.', true);
  }
}

async function loadAdmins(generation) {
  try {
    const result = await listAdmins();
    if (generation !== authGeneration || !isMasterAdmin) return;
    const list = $('admin-list');
    list.replaceChildren();
    for (const admin of result.data.admins || []) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = admin.email || admin.name || `Account ${admin.uid}`;
      const detail = document.createElement('span');
      detail.textContent = admin.master ? 'Master admin' : 'Admin';
      identity.append(name, detail);
      row.append(identity);
      if (!admin.master) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'danger-button';
        button.textContent = 'Remove admin';
        button.addEventListener('click', async () => {
          if (!confirm(`Remove admin access for ${admin.email || admin.name || admin.uid}?`)) return;
          button.disabled = true;
          try {
            await removeAdmin({ uid: admin.uid });
            status('admin-management-message', 'Admin access removed.');
            await loadAdmins(generation);
          } catch (error) {
            status('admin-management-message', error.message || 'Could not remove admin.', true);
            button.disabled = false;
          }
        });
        row.append(button);
      }
      list.append(row);
    }
  } catch (error) {
    if (generation === authGeneration) status('admin-management-message', error.message || 'Could not load admins.', true);
  }
}

function renderQuestionnaire(data) {
  const submittedQuestions = data?.version === 2 && Array.isArray(data.questions) ? data.questions : questions;
  const complete = (data?.version === 1 || data?.version === 2) &&
    Array.isArray(data.answers) && data.answers.length === submittedQuestions.length;
  $('questionnaire-summary').textContent = complete ? 'Questionnaire: complete' : 'Questionnaire: not completed';
  $('questionnaire-results').open = false;
  const list = $('questionnaire-answers');
  list.replaceChildren();
  if (!complete) return;
  submittedQuestions.forEach((question, index) => {
    const row = document.createElement('div');
    row.className = 'questionnaire-answer';
    const prompt = document.createElement('strong');
    prompt.textContent = `${index + 1}. ${question.prompt}`;
    const answer = document.createElement('span');
    answer.textContent = question.choices[data.answers[index]] || 'No answer';
    row.append(prompt, answer);
    list.append(row);
  });
}

function markQuestionnaireDirty() {
  questionnaireDirty = true;
  status('questionnaire-editor-message', 'Unsaved questionnaire changes.');
}

function questionInput(labelText, value, maxLength, id, onInput) {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.id = id;
  input.value = value;
  input.maxLength = maxLength;
  input.required = true;
  input.addEventListener('input', () => { onInput(input.value); markQuestionnaireDirty(); });
  return [label, input];
}

function renderQuestionnaireEditor() {
  $('questionnaire-enabled').checked = questionnaireEnabled;
  $('questionnaire-question-count').textContent = `${questionnaireDraft.length} questions. Each question needs 2 to 6 answers; the limit is 100 questions.`;
  $('add-question').disabled = questionnaireDraft.length >= 100;
  const list = $('questionnaire-editor-list');
  list.replaceChildren();
  questionnaireDraft.forEach((question, index) => {
    const card = document.createElement('div');
    card.className = 'questionnaire-editor-question';
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const title = document.createElement('h3');
    title.textContent = `Question ${index + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Delete question';
    remove.addEventListener('click', () => {
      questionnaireDraft.splice(index, 1);
      markQuestionnaireDirty();
      renderQuestionnaireEditor();
    });
    heading.append(title, remove);
    card.append(heading);
    card.append(...questionInput('Section', question.section, 80, `question-section-${index}`, value => { question.section = value; }));
    card.append(...questionInput('Question', question.prompt, 500, `question-prompt-${index}`, value => { question.prompt = value; }));
    question.choices.forEach((choice, choiceIndex) => {
      const row = document.createElement('div');
      row.className = 'questionnaire-choice-editor';
      row.append(...questionInput(`Answer ${choiceIndex + 1}`, choice, 200,
        `question-${index}-choice-${choiceIndex}`, value => { question.choices[choiceIndex] = value; }));
      const removeChoice = document.createElement('button');
      removeChoice.type = 'button';
      removeChoice.className = 'text-button';
      removeChoice.textContent = 'Delete answer';
      removeChoice.disabled = question.choices.length <= 2;
      removeChoice.addEventListener('click', () => {
        question.choices.splice(choiceIndex, 1);
        markQuestionnaireDirty();
        renderQuestionnaireEditor();
      });
      row.append(removeChoice);
      card.append(row);
    });
    const addChoice = document.createElement('button');
    addChoice.type = 'button';
    addChoice.className = 'text-button';
    addChoice.textContent = 'Add answer';
    addChoice.disabled = question.choices.length >= 6;
    addChoice.addEventListener('click', () => {
      question.choices.push('');
      markQuestionnaireDirty();
      renderQuestionnaireEditor();
    });
    card.append(addChoice);
    list.append(card);
  });
}

$('questionnaire-enabled').addEventListener('change', event => {
  questionnaireEnabled = event.target.checked;
  markQuestionnaireDirty();
});
$('add-question').addEventListener('click', () => {
  if (questionnaireDraft.length >= 100) return;
  questionnaireDraft.push({ section: '', prompt: '', choices: ['', ''] });
  markQuestionnaireDirty();
  renderQuestionnaireEditor();
  $('questionnaire-editor-list').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('questionnaire-editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isMasterAdmin) return status('questionnaire-editor-message', 'Master admin access required.', true);
  const button = $('save-questionnaire-config');
  button.disabled = true;
  status('questionnaire-editor-message', 'Saving questionnaire...');
  try {
    const result = await saveQuestionnaireConfig({
      enabled: questionnaireEnabled, expectedRevision: questionnaireRevision, questions: questionnaireDraft
    });
    questionnaireRevision = result.data.revision;
    questionnaireDirty = false;
    status('questionnaire-editor-message', questionnaireEnabled ? 'Questionnaire saved and on.' : 'Questionnaire saved and off.');
  } catch (error) {
    status('questionnaire-editor-message', error.message || 'Could not save questionnaire.', true);
  } finally {
    button.disabled = false;
  }
});

function renderApplicantSkills(data) {
  const entries = data?.version === 1 && Array.isArray(data.entries) ? data.entries : [];
  $('applicant-skills-summary').textContent = entries.length ? `Skills: ${entries.length} selected` : 'Skills: none added';
  const list = $('applicant-skills-list');
  list.replaceChildren();
  [...entries].sort((a, b) => b.years - a.years ||
    nameCollator.compare(catalog.byId.get(String(a.id))?.name || '', catalog.byId.get(String(b.id))?.name || ''))
    .forEach(entry => {
      const skill = catalog.byId.get(String(entry.id));
      if (!skill) return;
      const row = document.createElement('div');
      row.className = 'questionnaire-answer';
      const name = document.createElement('strong');
      name.textContent = `${skill.name} — ${entry.years} ${entry.years === 1 ? 'year' : 'years'}`;
      const detail = document.createElement('span');
      detail.textContent = `Company, organization, or homestead: ${entry.organization || 'Not provided'}`;
      row.append(name, detail);
      list.append(row);
    });
}

function renderMessages(snapshot) {
  const list = $('admin-messages');
  list.replaceChildren();
  snapshot.forEach(item => {
    const message = item.data();
    const bubble = document.createElement('div');
    bubble.className = `bubble ${message.senderUid === currentUser?.uid ? 'mine' : ''}`;
    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    const date = message.createdAt?.toDate?.();
    meta.textContent = `${message.senderRole === 'admin' ? 'Admin' : 'Applicant'}${date ? ` · ${date.toLocaleString()}` : ''}`;
    const body = document.createElement('div');
    body.textContent = message.text;
    bubble.append(meta, body);
    list.append(bubble);
  });
  list.scrollTop = list.scrollHeight;
}

function selectApplicant(uid) {
  if (uid === selectedUid) return;
  cleanSelection();
  selectedUid = uid;
  renderList();
  const selected = uid;
  profileUnsub = onSnapshot(doc(db, 'users', uid), snapshot => {
    if (selectedUid !== selected) return;
    if (!snapshot.exists()) {
      cleanSelection();
      renderList();
      return;
    }
    renderProfile(snapshot.data());
  }, error => status('page-message', error.message || 'Could not load profile.', true));
  questionnaireUnsub = onSnapshot(doc(db, 'questionnaires', uid), snapshot => {
    if (selectedUid === selected) renderQuestionnaire(snapshot.exists() ? snapshot.data() : null);
  }, error => status('page-message', error.message || 'Could not load questionnaire.', true));
  skillsUnsub = onSnapshot(doc(db, 'skills', uid), snapshot => {
    if (selectedUid === selected) {
      selectedSkillData = snapshot.exists() ? snapshot.data() : null;
      renderApplicantSkills(selectedSkillData);
    }
  }, error => status('page-message', error.message || 'Could not load skills.', true));
  conversationUnsub = onSnapshot(doc(db, 'conversations', uid), snapshot => {
    if (selectedUid !== selected) return;
    const opened = snapshot.exists();
    $('admin-chat-empty').hidden = opened;
    if (opened && !messagesUnsub) {
      messagesUnsub = onSnapshot(query(collection(db, 'conversations', uid, 'messages'), orderBy('createdAt', 'asc')), renderMessages, error => status('admin-message-status', error.message || 'Could not load messages.', true));
    } else if (!opened && messagesUnsub) {
      messagesUnsub();
      messagesUnsub = null;
      $('admin-messages').replaceChildren();
    }
  }, error => status('admin-message-status', error.message || 'Could not load conversation.', true));
}

function renderSkillCatalog() {
  const selectedSkill = $('rank-skill').value;
  $('rank-skill').replaceChildren(new Option('Choose a skill', ''));
  $('skill-categories').replaceChildren();
  for (const category of catalog.categories) {
    const categoryOption = document.createElement('option');
    categoryOption.value = category;
    $('skill-categories').append(categoryOption);
    const group = document.createElement('optgroup');
    group.label = category;
    catalog.skills.filter(skill => skill.category === category).forEach(skill => {
      const option = document.createElement('option');
      option.value = String(skill.id);
      option.textContent = skill.name;
      group.append(option);
    });
    $('rank-skill').append(group);
  }
  $('rank-skill').value = catalog.byId.has(selectedSkill) ? selectedSkill : '';
  if (selectedSkill && !$('rank-skill').value) {
    if (rankingsUnsub) rankingsUnsub();
    rankingsUnsub = null;
    rankings = [];
    renderRanking();
  }
  if (selectedUid) renderApplicantSkills(selectedSkillData);
}

renderSkillCatalog();

$('rank-skill').addEventListener('change', () => {
  if (rankingsUnsub) rankingsUnsub();
  rankingsUnsub = null;
  rankings = [];
  rankPage = 0;
  renderRanking();
  const id = $('rank-skill').value;
  if (id === '') return;
  rankingsUnsub = onSnapshot(collection(db, 'skillRankings', id, 'applicants'), snapshot => {
    rankings = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }));
    renderRanking();
  }, error => status('page-message', error.message || 'Could not load skill rankings.', true));
});

onAuthStateChanged(auth, async user => {
  const generation = ++authGeneration;
  cleanSubscriptions();
  isMasterAdmin = false;
  calendarReady = false;
  $('admin-management').hidden = true;
  $('questionnaire-editor').hidden = true;
  $('add-skill-card').hidden = true;
  questionnaireDirty = false;
  $('questionnaire-editor-form').hidden = true;
  currentUser = user;
  applicants = [];
  blocked = new Map();
  $('rank-skill').value = '';
  renderRanking();
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Sign in with an admin Google account to review profiles.');
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) return showAccess('This account cannot use Homesteader.');
    if (!(await getDoc(doc(db, 'admins', user.uid))).exists()) return showAccess('Only Homesteader admins can view applicant profiles.');
    if (generation !== authGeneration) return;
    isMasterAdmin = user.email?.toLowerCase() === masterAdminEmail;
    $('admin-management').hidden = !isMasterAdmin;
    $('questionnaire-editor').hidden = !isMasterAdmin;
    $('add-skill-card').hidden = !isMasterAdmin;
    if (isMasterAdmin) loadAdmins(generation);
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('profiles-view').hidden = false;
    loadCalendarStatus(generation);
    if (isMasterAdmin) questionnaireConfigUnsub = onSnapshot(doc(db, 'questionnaireConfig', 'main'), snapshot => {
      if (generation !== authGeneration) return;
      const config = snapshot.data();
      const revision = config?.revision || 0;
      if (questionnaireDirty) {
        if (revision !== questionnaireRevision) status('questionnaire-editor-message', 'The questionnaire changed in another session. Reload this page before saving.', true);
        return;
      }
      questionnaireRevision = revision;
      questionnaireEnabled = config?.enabled !== false;
      questionnaireDraft = (config?.questions || questions).map(question => ({
        section: question.section, prompt: question.prompt, choices: [...question.choices]
      }));
      renderQuestionnaireEditor();
      $('questionnaire-editor-form').hidden = false;
    }, error => status('questionnaire-editor-message', error.message || 'Could not load questionnaire settings.', true));
    catalogUnsub = onSnapshot(collection(db, 'skillCatalog'), snapshot => {
      if (generation !== authGeneration) return;
      catalog = buildSkillCatalog(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      renderSkillCatalog();
    }, error => status('page-message', error.message || 'Could not load skill catalog.', true));
    summariesUnsub = onSnapshot(collection(db, 'applicantSummaries'), snapshot => {
      applicants = snapshot.docs.map(item => ({ uid: item.id, ...item.data() }))
        .sort((a, b) => nameCollator.compare(a.name || '', b.name || '') || nameCollator.compare(a.email || '', b.email || ''));
      if (selectedUid && !applicants.some(person => person.uid === selectedUid)) cleanSelection();
      renderList();
      renderRanking();
    }, error => status('page-message', error.message || 'Could not load profiles.', true));
    blockedUnsub = onSnapshot(collection(db, 'blockedUsers'), snapshot => {
      blocked = new Map(snapshot.docs.map(item => [item.id, item.data()]));
      renderList();
      renderBlockedList();
      renderRanking();
      if (selectedUid) {
        $('detail-status').textContent = blocked.has(selectedUid) ? 'Blocked' : statusLabel(applicants.find(person => person.uid === selectedUid)?.status);
        $('block-applicant').textContent = blocked.has(selectedUid) ? 'Unblock account' : 'Block account';
        $('save-review').disabled = blocked.has(selectedUid);
        $('admin-send').disabled = blocked.has(selectedUid);
        $('schedule-interview').disabled = blocked.has(selectedUid) || selectedInterviewSource === 'calendar';
        $('cancel-interview').disabled = !selectedInterviewScheduled || (blocked.has(selectedUid) && selectedInterviewSource !== 'calendar');
        $('send-booking-invite').disabled = !calendarReady || blocked.has(selectedUid) || selectedInterviewScheduled;
        $('revoke-booking-invite').disabled = blocked.has(selectedUid);
      }
    }, error => status('page-message', error.message || 'Could not load blocked accounts.', true));
  } catch (error) {
    if (generation === authGeneration) showAccess(`Could not open private profiles: ${error.message || 'Please try again.'}`);
  }
});

$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });
$('calendar-availability-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await saveCalendarAvailability({
      days: [...document.querySelectorAll('input[name="calendar-day"]:checked')].map(input => Number(input.value)),
      startTime: $('calendar-start').value, endTime: $('calendar-end').value,
      durationMinutes: Number($('calendar-duration').value), bufferMinutes: Number($('calendar-buffer').value),
      leadHours: Number($('calendar-lead').value), horizonDays: Number($('calendar-horizon').value),
      timeZone: $('calendar-time-zone').value.trim(), timeZoneLabel: $('calendar-zone-label').value.trim()
    });
    status('calendar-availability-message', 'Bookable hours saved. You can now invite applicants to choose a time.');
    await loadCalendarStatus();
  } catch (error) { status('calendar-availability-message', error.message || 'Could not save bookable hours.', true); }
  finally { button.disabled = false; }
});
$('calendar-block-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  const start = new Date($('calendar-block-start').value);
  const end = new Date($('calendar-block-end').value);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return status('calendar-block-message', 'Choose a valid start and end time.', true);
  }
  button.disabled = true;
  try {
    await addCalendarBlock({ start: start.toISOString(), end: end.toISOString() });
    $('calendar-block-start').value = '';
    $('calendar-block-end').value = '';
    status('calendar-block-message', 'Time blocked. Applicants will not see it as available.');
    await loadCalendarStatus();
  } catch (error) { status('calendar-block-message', error.message || 'Could not block time.', true); }
  finally { button.disabled = false; }
});
$('applicant-search').addEventListener('input', () => { page = 0; renderList(); });
$('previous-page').addEventListener('click', () => { if (page > 0) { page--; renderList(); } });
$('next-page').addEventListener('click', () => { if ((page + 1) * pageSize < filteredApplicants().length) { page++; renderList(); } });
$('rank-previous').addEventListener('click', () => { if (rankPage > 0) { rankPage--; renderRanking(); } });
$('rank-next').addEventListener('click', () => { if ((rankPage + 1) * pageSize < rankedApplicants().length) { rankPage++; renderRanking(); } });

for (const radio of document.querySelectorAll('input[name="interview-mode"]')) radio.addEventListener('change', toggleMeetingLink);
$('booking-invite-mode').addEventListener('change', () => {
  $('booking-invite-link-row').hidden = $('booking-invite-mode').value !== 'zoom';
  if ($('booking-invite-mode').value !== 'zoom') $('booking-invite-link').value = '';
});
$('send-booking-invite').addEventListener('click', async () => {
  const uid = selectedUid;
  if (!uid) return;
  const button = $('send-booking-invite');
  button.disabled = true;
  try {
    await inviteToBook({
      uid, mode: $('booking-invite-mode').value,
      meetingLink: $('booking-invite-mode').value === 'zoom' ? $('booking-invite-link').value.trim() : '',
      note: $('booking-invite-note').value.trim()
    });
    if (selectedUid === uid) status('booking-invite-message', 'Invitation sent. The applicant can choose a time on their profile.');
  } catch (error) {
    if (selectedUid === uid) status('booking-invite-message', error.message || 'Could not send booking invitation.', true);
  } finally { if (selectedUid === uid) button.disabled = !calendarReady || blocked.has(uid) || selectedInterviewScheduled; }
});
$('revoke-booking-invite').addEventListener('click', async () => {
  const uid = selectedUid;
  if (!uid) return;
  const button = $('revoke-booking-invite');
  button.disabled = true;
  try {
    await revokeBookingInvite({ uid });
    if (selectedUid === uid) status('booking-invite-message', 'Booking invitation withdrawn.');
  } catch (error) {
    if (selectedUid === uid) status('booking-invite-message', error.message || 'Could not withdraw invitation.', true);
  } finally { if (selectedUid === uid) button.disabled = blocked.has(uid); }
});
$('interview-date').addEventListener('change', () => {
  if ($('interview-zone-label').value.trim()) return;
  const date = new Date($('interview-date').value);
  if (Number.isFinite(date.getTime())) $('interview-zone-label').value = readableTimeZone(date);
});
$('interview-form').addEventListener('submit', async event => {
  event.preventDefault();
  const uid = selectedUid;
  const mode = document.querySelector('input[name="interview-mode"]:checked')?.value;
  const when = new Date($('interview-date').value);
  const timeZoneLabel = $('interview-zone-label').value.trim();
  if (!uid || !mode || !Number.isFinite(when.getTime()) || when.getTime() <= Date.now()) {
    return status('interview-message', 'Choose an interview type and a future date and time.', true);
  }
  if (!timeZoneLabel || timeZoneLabel.length > 60 || /[<>\r\n/]/.test(timeZoneLabel)) {
    return status('interview-message', 'Enter a readable time zone, such as Central Time (CT).', true);
  }
  let meetingLink = '';
  try { meetingLink = mode === 'zoom' ? normalizeExternalUrl($('interview-link').value) : ''; }
  catch (error) { return status('interview-message', error.message, true); }
  const button = $('schedule-interview');
  button.disabled = true;
  try {
    await manageInterview({
      uid, action: 'schedule', mode, scheduledAt: when.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      timeZoneLabel,
      note: $('interview-note-input').value.trim(), meetingLink
    });
    if (selectedUid === uid) status('interview-message', 'Invitation sent. The applicant can reply in their inbox.');
  } catch (error) {
    if (selectedUid === uid) status('interview-message', error.message || 'Could not send the interview invitation.', true);
  } finally {
    if (selectedUid === uid) button.disabled = blocked.has(uid);
  }
});
$('cancel-interview').addEventListener('click', async () => {
  const uid = selectedUid;
  if (!uid) return;
  const button = $('cancel-interview');
  button.disabled = true;
  try {
    if (selectedInterviewSource === 'calendar') await cancelCalendarInterview({ uid });
    else await manageInterview({ uid, action: 'cancel' });
    if (selectedUid === uid) status('interview-message', 'Interview canceled. The applicant was notified in their inbox.');
  } catch (error) {
    if (selectedUid === uid) status('interview-message', error.message || 'Could not cancel the interview.', true);
  } finally {
    if (selectedUid === uid) button.disabled = !selectedInterviewScheduled || (blocked.has(uid) && selectedInterviewSource !== 'calendar');
  }
});

$('add-skill-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isMasterAdmin) return status('add-skill-message', 'Master admin access required.', true);
  const button = $('add-skill');
  const name = $('new-skill-name').value.trim();
  const category = $('new-skill-category').value.trim();
  if (catalog.skills.some(skill => skill.name.toLowerCase() === name.toLowerCase() &&
      skill.category.toLowerCase() === category.toLowerCase())) {
    status('add-skill-message', 'This skill is already in that category.', true);
    return;
  }
  button.disabled = true;
  try {
    await addSkill({ name, category });
    $('new-skill-name').value = '';
    status('add-skill-message', 'Skill added to the applicant picker and rankings.');
  } catch (error) {
    status('add-skill-message', error.message || 'Could not add skill.', true);
  } finally {
    button.disabled = false;
  }
});

$('save-review').addEventListener('click', async () => {
  if (!selectedUid) return;
  const button = $('save-review');
  button.disabled = true;
  try { await setReviewStatus({ uid: selectedUid, status: $('review-status').value }); status('review-message', 'Review status saved.'); }
  catch (error) { status('review-message', error.message || 'Could not save review status.', true); }
  finally { button.disabled = false; }
});

$('block-applicant').addEventListener('click', async () => {
  if (!selectedUid) return;
  const action = blocked.has(selectedUid) ? 'unblock' : 'block';
  const button = $('block-applicant');
  button.disabled = true;
  try { await manageApplicant({ uid: selectedUid, action }); status('account-action-message', action === 'block' ? 'Account blocked.' : 'Account unblocked.'); }
  catch (error) { status('account-action-message', error.message || 'Could not update account.', true); }
  finally { button.disabled = false; }
});

$('delete-applicant').addEventListener('click', async () => {
  if (!selectedUid || !confirm('Delete this profile, questionnaire, and conversation, and block the account from returning?')) return;
  const button = $('delete-applicant');
  button.disabled = true;
  try { await manageApplicant({ uid: selectedUid, action: 'delete' }); status('page-message', 'Profile deleted and account blocked.'); }
  catch (error) { status('account-action-message', error.message || 'Could not delete profile.', true); }
  finally { button.disabled = false; }
});

$('admin-message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const uid = selectedUid;
  const text = $('admin-message').value.trim();
  if (!uid || !text || !currentUser) return;
  const button = $('admin-send');
  button.disabled = true;
  try { await sendMessage({ targetUid: uid, text }); $('admin-message').value = ''; status('admin-message-status', 'Message sent.'); }
  catch (error) { status('admin-message-status', error.message || 'Could not send message.', true); }
  finally { button.disabled = false; }
});
