import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, onSnapshot, query, orderBy } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { questions } from './questions.js';
import { buildSkillCatalog } from './skills.js';
import { normalizeExternalUrl } from './links.js';
import { companySegments, companyLink } from './company-context.js';

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
const deleteSkill = httpsCallable(functions, 'deleteSkill');
const saveQuestionnaireConfig = httpsCallable(functions, 'saveQuestionnaireConfig');
const listAdmins = httpsCallable(functions, 'listAdmins');
const addAdminEmail = httpsCallable(functions, 'addAdminEmail');
const cancelAdminEmail = httpsCallable(functions, 'cancelAdminEmail');
const claimAdminEmail = httpsCallable(functions, 'claimAdminEmail');
const removeAdmin = httpsCallable(functions, 'removeAdmin');
const manageTeam = httpsCallable(functions, 'manageTeam');
const setTeamMember = httpsCallable(functions, 'setTeamMember');
const calendarStatus = httpsCallable(functions, 'calendarStatus');
const saveCalendarAvailability = httpsCallable(functions, 'saveCalendarAvailability');
const addCalendarBlock = httpsCallable(functions, 'addCalendarBlock');
const removeCalendarBlock = httpsCallable(functions, 'removeCalendarBlock');
const inviteToBook = httpsCallable(functions, 'inviteToBook');
const revokeBookingInvite = httpsCallable(functions, 'revokeBookingInvite');
const cancelCalendarInterview = httpsCallable(functions, 'cancelCalendarInterview');
const claimCompanyEmail = httpsCallable(functions, 'claimCompanyEmail');
const getSharedApplicantProfile = httpsCallable(functions, 'getSharedApplicantProfile');
const listSharedSkillRanking = httpsCallable(functions, 'listSharedSkillRanking', { timeout: 120000 });
const masterAdminEmail = 'titanbusinesspros@gmail.com';
const pageSize = 25;
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
let currentUser = null;
let isMasterAdmin = false;
let canAddSkills = false;
let companyId = 'titan';
const scopedDoc = (...parts) => doc(db, ...companySegments(companyId, ...parts));
const scopedCollection = (...parts) => collection(db, ...companySegments(companyId, ...parts));
let applicants = [];
let directory = new Map();
let companySummaries = new Map();
let companySummariesUnsub = null;
let selectedSharedProfile = null;
let selectedApplication = null;
let blocked = new Map();
let selectedUid = null;
let selectedInterviewScheduled = false;
let selectedInterviewSource = '';
let calendarReady = false;
let calendarInterviewSignature = null;
let page = 0;
let summariesUnsub = null;
let blockedUnsub = null;
let profileUnsub = null;
let questionnaireUnsub = null;
let skillsUnsub = null;
let conversationUnsub = null;
let messagesUnsub = null;
let teamsUnsub = null;
let teamMembersUnsub = null;
let teams = [];
let rosterMemberIds = [];
let selectedTeamId = null;
let applicantTeamUnsubs = new Map();
let applicantTeamIds = new Set();
let applicantTeamPending = new Set();
let assignApplicantBusy = false;
let catalogUnsub = null;
let questionnaireConfigUnsub = null;
let questionnaireDraft = [];
let questionnaireEnabled = true;
let questionnaireRevision = 0;
let questionnaireDirty = false;
let catalog = buildSkillCatalog();
let selectedSkillData = null;
let rankings = [];
let rankLimit = 10;
let rankHasMore = false;
let rankLoading = false;
let rankError = '';
let rankRequestGeneration = 0;
let selectedRankEntry = null;
let authGeneration = 0;
const linkedApplicantUid = new URLSearchParams(location.search).get('applicant');
let linkedApplicantOpened = false;
let linkedApplicantScrolled = false;

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

function showAccess(message, retry = false) {
  $('loading').hidden = true;
  $('profiles-view').hidden = true;
  $('access-text').textContent = message;
  $('retry-profiles').hidden = !retry;
  $('access-message').hidden = false;
}

function timed(promise, label, milliseconds = 12000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} took too long. Check your connection and try again.`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function cleanSelection() {
  for (const unsub of [profileUnsub, questionnaireUnsub, skillsUnsub, conversationUnsub, messagesUnsub]) if (unsub) unsub();
  for (const unsub of applicantTeamUnsubs.values()) unsub();
  applicantTeamUnsubs = new Map();
  applicantTeamIds = new Set();
  applicantTeamPending = new Set();
  assignApplicantBusy = false;
  profileUnsub = questionnaireUnsub = skillsUnsub = conversationUnsub = messagesUnsub = null;
  selectedSharedProfile = null;
  selectedApplication = null;
  selectedUid = null;
  selectedInterviewScheduled = false;
  selectedInterviewSource = '';
  selectedSkillData = null;
  selectedRankEntry = null;
  photoPreview.hidden = true;
  $('detail-photos').replaceChildren();
  $('admin-messages').replaceChildren();
  $('applicant-team-list').replaceChildren();
  status('assign-applicant-message', '');
  $('admin-detail').hidden = true;
  $('admin-detail-empty').hidden = false;
}

function cleanSubscriptions() {
  cleanSelection();
  for (const unsub of [summariesUnsub, companySummariesUnsub, blockedUnsub, catalogUnsub, questionnaireConfigUnsub, teamsUnsub, teamMembersUnsub]) if (unsub) unsub();
  summariesUnsub = companySummariesUnsub = blockedUnsub = catalogUnsub = questionnaireConfigUnsub = teamsUnsub = teamMembersUnsub = null;
  ++rankRequestGeneration;
  rankLoading = false;
  rankError = '';
  rankHasMore = false;
  directory = new Map();
  companySummaries = new Map();
  rankings = [];
  teams = [];
  rosterMemberIds = [];
  selectedTeamId = null;
  $('team-list').replaceChildren();
  $('team-detail').hidden = true;
  $('team-empty').hidden = false;
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
  return rankings.filter(entry => !blocked.has(entry.uid))
    .sort((a, b) => b.years - a.years || nameCollator.compare(a.name || '', b.name || ''));
}

function renderRanking() {
  const sorted = rankedApplicants();
  if (sorted.length <= 10) rankLimit = 10;
  $('skill-rank-count').textContent = rankHasMore ? '25+' : String(sorted.length);
  const shown = sorted.slice(0, rankLimit);
  $('rank-summary').hidden = !sorted.length;
  $('rank-summary').textContent = sorted.length ?
    `Showing top ${shown.length}${rankHasMore ? ' of more than 25' : ` of ${sorted.length}`} qualified applicants across homestead companies.` : '';
  $('rank-show-more').hidden = sorted.length <= 10;
  $('rank-show-more').setAttribute('aria-expanded', String(rankLimit === 25));
  $('rank-show-more').textContent = rankLimit === 10 ?
    `View top ${Math.min(25, sorted.length)}` : 'Show top 10';
  $('rank-empty').hidden = sorted.length > 0;
  $('rank-empty').textContent = rankError || (rankLoading ? 'Loading skill rankings...' :
    $('rank-skill').value ? 'No applicants have reported this skill yet.' : 'Choose a skill to see its ranking.');
  const list = $('rank-list');
  list.replaceChildren();
  shown.forEach((entry, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rank-row';
    const heading = document.createElement('strong');
    heading.textContent = `${index + 1}. ${entry.name || 'Unnamed'} — ${entry.years} ${entry.years === 1 ? 'year' : 'years'}`;
    const detail = document.createElement('span');
    detail.textContent = `${entry.organization || 'Organization not provided'} · ${entry.email || ''} · Reported at ${entry.sourceCompany}`;
    button.append(heading, detail);
    button.addEventListener('click', () => {
      selectApplicant(entry.uid, { ...entry, skillName: catalog.byId.get(String($('rank-skill').value))?.name || 'Selected skill' });
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

function renderApplicantTeams() {
  const list = $('applicant-team-list');
  const select = $('assign-applicant-team');
  const previous = select.value;
  list.replaceChildren();
  select.replaceChildren(new Option('Choose a team', ''));
  for (const team of teams) {
    if (!applicantTeamIds.has(team.id)) {
      select.add(new Option(team.name, team.id));
      continue;
    }
    const row = document.createElement('div');
    row.className = 'roster-member-row';
    const name = document.createElement('strong');
    name.textContent = team.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      const uid = selectedUid;
      remove.disabled = true;
      try {
        await setTeamMember({ action: 'remove', teamId: team.id, uid });
        if (selectedUid === uid) status('assign-applicant-message', `Removed from ${team.name}.`);
      } catch (error) {
        if (selectedUid === uid) status('assign-applicant-message', error.message || 'Could not remove this applicant.', true);
        remove.disabled = false;
      }
    });
    row.append(name, remove);
    list.append(row);
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
  const loading = applicantTeamPending.size > 0;
  $('applicant-team-empty').hidden = applicantTeamIds.size > 0;
  $('applicant-team-empty').textContent = loading ? 'Loading teams...' : 'Not on a team yet.';
  select.disabled = assignApplicantBusy || blocked.has(selectedUid) || select.options.length < 2;
  $('assign-applicant-team-button').disabled = select.disabled;
}

function syncApplicantTeamListeners() {
  for (const [teamId, unsub] of applicantTeamUnsubs) {
    if (selectedUid && teams.some(team => team.id === teamId)) continue;
    unsub();
    applicantTeamUnsubs.delete(teamId);
    applicantTeamIds.delete(teamId);
    applicantTeamPending.delete(teamId);
  }
  if (!selectedUid) return renderApplicantTeams();
  const uid = selectedUid;
  const generation = authGeneration;
  for (const team of teams) {
    if (applicantTeamUnsubs.has(team.id)) continue;
    applicantTeamPending.add(team.id);
    const unsub = onSnapshot(scopedDoc('teams', team.id, 'members', uid), snapshot => {
      if (generation !== authGeneration || selectedUid !== uid) return;
      applicantTeamPending.delete(team.id);
      if (snapshot.exists()) applicantTeamIds.add(team.id);
      else applicantTeamIds.delete(team.id);
      renderApplicantTeams();
    }, error => {
      if (generation !== authGeneration || selectedUid !== uid) return;
      applicantTeamPending.delete(team.id);
      status('assign-applicant-message', error.message || 'Could not load team membership.', true);
      renderApplicantTeams();
    });
    applicantTeamUnsubs.set(team.id, unsub);
  }
  renderApplicantTeams();
}

function renderTeamMembers() {
  const list = $('team-members');
  list.replaceChildren();
  $('team-member-count').textContent = String(rosterMemberIds.length);
  $('team-members-empty').hidden = rosterMemberIds.length > 0;
  const byUid = new Map(applicants.map(person => [person.uid, person]));
  const members = [...rosterMemberIds].sort((a, b) =>
    nameCollator.compare(byUid.get(a)?.name || '', byUid.get(b)?.name || ''));
  for (const uid of members) {
    const person = byUid.get(uid);
    const row = document.createElement('div');
    row.className = 'roster-member-row';
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = person?.name || 'Former applicant';
    const meta = document.createElement('span');
    meta.textContent = person ? `${person.email || ''}${blocked.has(uid) ? ' · Blocked' : ''}` : 'Profile no longer available';
    details.append(name, meta);
    const actions = document.createElement('div');
    actions.className = 'roster-member-actions';
    if (person) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'text-button';
      open.textContent = 'Open profile';
      open.addEventListener('click', () => {
        selectApplicant(uid);
        $('admin-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      actions.append(open);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      const teamId = selectedTeamId;
      remove.disabled = true;
      try {
        await setTeamMember({ teamId, uid, action: 'remove' });
        if (selectedTeamId === teamId) status('team-message', `${name.textContent} removed from this team.`);
      } catch (error) {
        if (selectedTeamId === teamId) status('team-message', error.message || 'Could not remove this applicant.', true);
        remove.disabled = false;
      }
    });
    actions.append(remove);
    row.append(details, actions);
    list.append(row);
  }
}

function renderTeams() {
  const list = $('team-list');
  list.replaceChildren();
  $('team-empty').hidden = teams.length > 0;
  for (const team of teams) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `roster-team ${team.id === selectedTeamId ? 'selected' : ''}`;
    button.textContent = team.name;
    button.addEventListener('click', () => selectTeam(team.id));
    list.append(button);
  }
  const selected = teams.find(team => team.id === selectedTeamId);
  if (selected) {
    $('team-title').textContent = selected.name;
    if (document.activeElement !== $('team-name')) $('team-name').value = selected.name;
  }
}

function selectTeam(teamId) {
  if (teamMembersUnsub) teamMembersUnsub();
  teamMembersUnsub = null;
  selectedTeamId = teamId;
  rosterMemberIds = [];
  $('team-detail').hidden = !teamId;
  status('team-message', '');
  renderTeams();
  if (!teamId) return;
  $('team-members-empty').textContent = 'Loading team members...';
  renderTeamMembers();
  const generation = authGeneration;
  teamMembersUnsub = onSnapshot(scopedCollection('teams', teamId, 'members'), snapshot => {
    if (generation !== authGeneration || selectedTeamId !== teamId) return;
    rosterMemberIds = snapshot.docs.map(item => item.id);
    $('team-members-empty').textContent = 'No applicants on this team yet.';
    renderTeamMembers();
  }, error => {
    if (generation === authGeneration && selectedTeamId === teamId) status('team-message', error.message || 'Could not load team members.', true);
  });
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
  if (selectedUid === linkedApplicantUid && !linkedApplicantScrolled) {
    linkedApplicantScrolled = true;
    requestAnimationFrame(() => $('admin-detail').scrollIntoView({ block: 'start' }));
  }
  $('detail-name').textContent = person.profile?.name || 'Unnamed';
  $('roster-applicant-name').textContent = person.profile?.name || 'this applicant';
  $('detail-status').textContent = blocked.has(selectedUid) ? 'Blocked' : statusLabel(person.status);
  $('detail-email').textContent = person.email || '';
  $('detail-location').textContent = person.profile?.location ? `Location: ${person.profile.location}` : 'Location not provided';
  $('detail-bio').textContent = person.bio || 'No introduction yet.';
  renderSharedQualificationNote();
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
  $('block-applicant').textContent = blocked.has(selectedUid) ?
    (companyId === 'titan' ? 'Unblock account' : 'Unblock for company') :
    (companyId === 'titan' ? 'Block account' : 'Block for company');
  $('save-review').disabled = blocked.has(selectedUid);
  $('admin-send').disabled = blocked.has(selectedUid);
  renderInterviewEditor(person.interview);
  renderBookingInviteEditor(person.bookingInvite, person.interview);
}

function renderSharedQualificationNote() {
  const note = $('shared-qualification-note');
  note.hidden = !selectedRankEntry || selectedRankEntry.uid !== selectedUid;
  note.textContent = note.hidden ? '' :
    `Shared skill report: ${selectedRankEntry.skillName} — ${selectedRankEntry.years} ${selectedRankEntry.years === 1 ? 'year' : 'years'}; ${selectedRankEntry.organization || 'organization not provided'}; reported at ${selectedRankEntry.sourceCompany}. The skill list below shows submissions to this company.`;
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

async function loadCalendarStatus(generation = authGeneration, updateForm = true) {
  try {
    const { data } = await calendarStatus();
    if (generation !== authGeneration) return;
    calendarReady = Boolean(data.availability);
    $('calendar-connection-status').textContent = calendarReady ?
      'Your bookable hours are saved. Invite an applicant below, or block time when you are unavailable.' :
      'Save your bookable hours to start accepting interview bookings.';
    renderCalendarAgenda(data);
    if (updateForm) {
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
    }
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
      detail.textContent = admin.master ? (companyId === 'titan' ? 'Master admin' : 'Company owner') : 'Admin';
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
    const pendingList = $('pending-admin-list');
    pendingList.replaceChildren();
    const pending = result.data.pending || [];
    $('pending-admin-empty').hidden = pending.length > 0;
    for (const email of pending) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = email;
      const detail = document.createElement('span');
      detail.textContent = 'Waiting for this Google account to sign in';
      identity.append(name, detail);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'danger-button';
      button.textContent = 'Cancel access';
      button.addEventListener('click', async () => {
        if (!confirm(`Cancel pending admin access for ${email}?`)) return;
        button.disabled = true;
        try {
          await cancelAdminEmail({ email });
          status('admin-management-message', 'Pending admin access canceled.');
          await loadAdmins(generation);
        } catch (error) {
          status('admin-management-message', error.message || 'Could not cancel admin access.', true);
          button.disabled = false;
        }
      });
      row.append(identity, button);
      pendingList.append(row);
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
    const selected = data.answers[index];
    answer.textContent = Number.isInteger(selected) ? (question.choices[selected] || 'No answer') :
      typeof selected?.text === 'string' ? `Written answer: ${selected.text}` : 'No answer';
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
  $('questionnaire-question-count').textContent = `${questionnaireDraft.length} questions. Each can have 0 to 6 preset answers; applicants can always write their own answer. The limit is 100 questions.`;
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
      removeChoice.disabled = false;
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
  questionnaireDraft.push({ section: '', prompt: '', choices: [] });
  markQuestionnaireDirty();
  renderQuestionnaireEditor();
  $('questionnaire-editor-list').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('questionnaire-editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isMasterAdmin) return status('questionnaire-editor-message', 'Company owner access required.', true);
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
  const entries = data?.version === 1 && Array.isArray(data.entries) ?
    data.entries.filter(entry => catalog.byId.has(String(entry.id))) : [];
  $('applicant-skills-summary').textContent = entries.length ?
    `Skills submitted to this company: ${entries.length}` : 'Skills submitted to this company: none';
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

function selectApplicant(uid, rankEntry = null) {
  if (uid === selectedUid) {
    selectedRankEntry = rankEntry;
    renderSharedQualificationNote();
    return;
  }
  cleanSelection();
  selectedUid = uid;
  selectedRankEntry = rankEntry;
  syncApplicantTeamListeners();
  renderList();
  const selected = uid;
  if (companyId === 'titan') {
    profileUnsub = onSnapshot(doc(db, 'users', uid), snapshot => {
      if (selectedUid !== selected) return;
      if (!snapshot.exists()) { cleanSelection(); renderList(); return; }
      renderProfile(snapshot.data());
    }, error => status('page-message', error.message || 'Could not load profile.', true));
  } else {
    getSharedApplicantProfile({ uid }).then(result => {
      if (selectedUid !== selected) return;
      selectedSharedProfile = result.data;
      renderProfile({ ...(companySummaries.get(uid) || {}), ...(selectedApplication || {}), ...selectedSharedProfile });
    }).catch(error => status('page-message', error.message || 'Could not load profile.', true));
    profileUnsub = onSnapshot(scopedDoc('applications', uid), snapshot => {
      if (selectedUid !== selected) return;
      selectedApplication = snapshot.data() || {};
      if (selectedSharedProfile) renderProfile({ ...(companySummaries.get(uid) || {}), ...selectedApplication, ...selectedSharedProfile });
    }, error => status('page-message', error.message || 'Could not load application.', true));
  }
  questionnaireUnsub = onSnapshot(scopedDoc('questionnaires', uid), snapshot => {
    if (selectedUid === selected) renderQuestionnaire(snapshot.exists() ? snapshot.data() : null);
  }, error => status('page-message', error.message || 'Could not load questionnaire.', true));
  skillsUnsub = onSnapshot(scopedDoc('skills', uid), snapshot => {
    if (selectedUid === selected) {
      selectedSkillData = snapshot.exists() ? snapshot.data() : null;
      renderApplicantSkills(selectedSkillData);
    }
  }, error => status('page-message', error.message || 'Could not load skills.', true));
  conversationUnsub = onSnapshot(scopedDoc('conversations', uid), snapshot => {
    if (selectedUid !== selected) return;
    const opened = snapshot.exists();
    $('admin-chat-empty').hidden = opened;
    if (opened && !messagesUnsub) {
      messagesUnsub = onSnapshot(query(scopedCollection('conversations', uid, 'messages'), orderBy('createdAt', 'asc')), renderMessages, error => status('admin-message-status', error.message || 'Could not load messages.', true));
    } else if (!opened && messagesUnsub) {
      messagesUnsub();
      messagesUnsub = null;
      $('admin-messages').replaceChildren();
    }
  }, error => status('admin-message-status', error.message || 'Could not load conversation.', true));
}

function renderSkillCatalog() {
  const selectedSkill = $('rank-skill').value;
  const selectedForDeletion = $('delete-skill-select').value;
  $('rank-skill').replaceChildren(new Option('Choose a skill', ''));
  $('delete-skill-select').replaceChildren(new Option('Choose a skill', ''));
  $('skill-categories').replaceChildren();
  for (const category of catalog.categories) {
    const categoryOption = document.createElement('option');
    categoryOption.value = category;
    $('skill-categories').append(categoryOption);
    const group = document.createElement('optgroup');
    group.label = category;
    const deleteGroup = document.createElement('optgroup');
    deleteGroup.label = category;
    catalog.skills.filter(skill => skill.category === category).forEach(skill => {
      const option = document.createElement('option');
      option.value = String(skill.id);
      option.textContent = skill.name;
      group.append(option);
      const deleteOption = document.createElement('option');
      deleteOption.value = String(skill.id);
      deleteOption.textContent = skill.name;
      deleteGroup.append(deleteOption);
    });
    if (group.children.length) {
      $('rank-skill').append(group);
      $('delete-skill-select').append(deleteGroup);
    }
  }
  $('rank-skill').value = catalog.byId.has(selectedSkill) ? selectedSkill : '';
  $('delete-skill-select').value = catalog.byId.has(selectedForDeletion) ? selectedForDeletion : '';
  if (selectedSkill && !$('rank-skill').value) {
    ++rankRequestGeneration;
    rankings = [];
    rankHasMore = false;
    rankLoading = false;
    rankError = '';
    rankLimit = 10;
    $('refresh-rankings').hidden = true;
    renderRanking();
  }
  if (selectedUid) renderApplicantSkills(selectedSkillData);
}

renderSkillCatalog();

const initialAuthTimer = setTimeout(() => {
  if (!$('loading').hidden) showAccess('Sign-in is taking too long. Check your connection and try again.', true);
}, 15000);

async function loadSharedRanking() {
  const skillId = $('rank-skill').value;
  const requestGeneration = ++rankRequestGeneration;
  const currentAuthGeneration = authGeneration;
  rankings = [];
  rankHasMore = false;
  rankError = '';
  rankLimit = 10;
  rankLoading = Boolean(skillId);
  $('refresh-rankings').hidden = !skillId;
  $('refresh-rankings').disabled = Boolean(skillId);
  renderRanking();
  if (!skillId) return;
  try {
    const { data } = await listSharedSkillRanking({ skillId });
    if (requestGeneration !== rankRequestGeneration || currentAuthGeneration !== authGeneration ||
        skillId !== $('rank-skill').value) return;
    rankings = data.rankings || [];
    rankHasMore = data.hasMore === true;
    rankLoading = false;
    rankError = '';
    renderRanking();
  } catch (error) {
    if (requestGeneration !== rankRequestGeneration) return;
    rankLoading = false;
    rankError = error.message || 'Could not load skill rankings. Press Refresh rankings to try again.';
    renderRanking();
    status('page-message', rankError, true);
  } finally {
    if (requestGeneration === rankRequestGeneration) $('refresh-rankings').disabled = false;
  }
}

$('rank-skill').addEventListener('change', loadSharedRanking);
$('refresh-rankings').addEventListener('click', loadSharedRanking);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && $('rank-skill').value && !$('profiles-view').hidden) loadSharedRanking();
});

onAuthStateChanged(auth, async user => {
  clearTimeout(initialAuthTimer);
  const generation = ++authGeneration;
  cleanSubscriptions();
  linkedApplicantOpened = false;
  linkedApplicantScrolled = false;
  isMasterAdmin = false;
  canAddSkills = false;
  calendarReady = false;
  calendarInterviewSignature = null;
  $('admin-management').hidden = true;
  $('questionnaire-editor').hidden = true;
  $('add-skill-card').hidden = true;
  $('delete-skill-card').hidden = true;
  questionnaireDirty = false;
  $('questionnaire-editor-form').hidden = true;
  currentUser = user;
  applicants = [];
  blocked = new Map();
  $('rank-skill').value = '';
  rankLimit = 10;
  renderRanking();
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Sign in with an admin Google account to review profiles.');
  try {
    const token = await timed(user.getIdTokenResult(), 'Sign-in');
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    let blockedRecord;
    let adminRecord;
    try {
      [blockedRecord, adminRecord] = await timed(Promise.all([
        getDoc(doc(db, 'blockedUsers', user.uid)),
        getDoc(doc(db, 'admins', user.uid))
      ]), 'Checking admin access');
    } catch (error) {
      if (!error.message?.includes('took too long')) throw error;
      // A pending admin may claim access even if this browser's Firestore read stalls.
      const companyClaim = await timed(claimCompanyEmail(), 'Checking company invitation');
      if (!companyClaim.data.claimed) await timed(claimAdminEmail(), 'Checking admin invitation');
      blockedRecord = { exists: () => false };
      adminRecord = await timed(getDoc(doc(db, 'admins', user.uid)), 'Loading admin account');
    }
    if (blockedRecord.exists()) return showAccess('This account cannot use Homesteader.');
    if (!adminRecord.exists()) {
      const companyClaim = await timed(claimCompanyEmail(), 'Checking company invitation');
      if (!companyClaim.data.claimed) await timed(claimAdminEmail(), 'Checking admin invitation');
      adminRecord = await timed(getDoc(doc(db, 'admins', user.uid)), 'Loading admin account');
      if (!adminRecord.exists()) return showAccess('Only Homesteader admins can view applicant profiles.');
    }
    if (generation !== authGeneration) return;
    companyId = adminRecord.data().companyId || 'titan';
    $('delete-applicant').textContent = companyId === 'titan' ? 'Delete profile and block account' : 'Delete company records and block';
    isMasterAdmin = companyId === 'titan' ? user.email?.toLowerCase() === masterAdminEmail : adminRecord.data().role === 'owner';
    canAddSkills = companyId === 'titan' && isMasterAdmin;
    $('profiles-company-name').textContent = companyId === 'titan' ? 'Titan Business Pros' :
      (await timed(getDoc(doc(db, 'companies', companyId)), 'Loading company')).data()?.name || 'Homestead company';
    document.querySelectorAll('a[href="./"]').forEach(link => { link.href = companyLink('./', companyId); });
    $('admin-management').hidden = !isMasterAdmin;
    $('questionnaire-editor').hidden = !isMasterAdmin;
    $('add-skill-card').hidden = !canAddSkills;
    $('delete-skill-card').hidden = !canAddSkills;
    if (isMasterAdmin) loadAdmins(generation);
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('profiles-view').hidden = false;
    if (isMasterAdmin && location.hash === '#admin-management') {
      requestAnimationFrame(() => $('admin-management').scrollIntoView({ block: 'start' }));
    }
    loadCalendarStatus(generation);
    if (isMasterAdmin) questionnaireConfigUnsub = onSnapshot(scopedDoc('questionnaireConfig', 'main'), snapshot => {
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
    catalogUnsub = onSnapshot(scopedCollection('skillCatalog'), snapshot => {
      if (generation !== authGeneration) return;
      catalog = buildSkillCatalog(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      renderSkillCatalog();
    }, error => status('page-message', error.message || 'Could not load skill catalog.', true));
    teamsUnsub = onSnapshot(scopedCollection('teams'), snapshot => {
      if (generation !== authGeneration) return;
      teams = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        .sort((a, b) => nameCollator.compare(a.name || '', b.name || ''));
      if (selectedTeamId && !teams.some(team => team.id === selectedTeamId)) selectTeam(null);
      else if (!selectedTeamId && teams.length) selectTeam(teams[0].id);
      else renderTeams();
      syncApplicantTeamListeners();
    }, error => status('roster-message', error.message || 'Could not load teams.', true));
    summariesUnsub = onSnapshot(companyId === 'titan' ? scopedCollection('applicantSummaries') : collection(db, 'applicantDirectory'), snapshot => {
      if (generation !== authGeneration) return;
      directory = new Map(snapshot.docs.map(item => [item.id, item.data()]));
      applicants = snapshot.docs.map(item => ({ uid: item.id, ...item.data(), ...(companySummaries.get(item.id) || {}) }))
        .sort((a, b) => nameCollator.compare(a.name || '', b.name || '') || nameCollator.compare(a.email || '', b.email || ''));
      const nextSignature = applicants.map(person => `${person.uid}:${person.interviewAt?.toMillis?.() || ''}`).join('|');
      if (calendarInterviewSignature !== null && nextSignature !== calendarInterviewSignature) {
        loadCalendarStatus(generation, false);
      }
      calendarInterviewSignature = nextSignature;
      if (selectedUid && !applicants.some(person => person.uid === selectedUid)) cleanSelection();
      renderList();
      if (linkedApplicantUid && !linkedApplicantOpened && applicants.some(person => person.uid === linkedApplicantUid)) {
        linkedApplicantOpened = true;
        selectApplicant(linkedApplicantUid);
      }
      renderRanking();
      renderTeamMembers();
      if (selectedUid) renderApplicantTeams();
    }, error => status('page-message', error.message || 'Could not load profiles.', true));
    if (companyId !== 'titan') companySummariesUnsub = onSnapshot(scopedCollection('applicantSummaries'), snapshot => {
      companySummaries = new Map(snapshot.docs.map(item => [item.id, item.data()]));
      applicants = [...directory].map(([uid, person]) => ({ uid, ...person, ...(companySummaries.get(uid) || {}) }))
        .sort((a, b) => nameCollator.compare(a.name || '', b.name || ''));
      const nextSignature = applicants.map(person => `${person.uid}:${person.interviewAt?.toMillis?.() || ''}`).join('|');
      if (calendarInterviewSignature !== null && nextSignature !== calendarInterviewSignature) loadCalendarStatus(generation, false);
      calendarInterviewSignature = nextSignature;
      renderList(); renderRanking(); renderTeamMembers();
      if (selectedUid) renderApplicantTeams();
    }, error => status('page-message', error.message || 'Could not load company applications.', true));
    blockedUnsub = onSnapshot(companyId === 'titan' ? collection(db, 'blockedUsers') : scopedCollection('blockedApplicants'), snapshot => {
      blocked = new Map(snapshot.docs.map(item => [item.id, item.data()]));
      renderList();
      renderBlockedList();
      renderRanking();
      renderTeamMembers();
      if (selectedUid) renderApplicantTeams();
      if (selectedUid) {
        $('detail-status').textContent = blocked.has(selectedUid) ? 'Blocked' : statusLabel(applicants.find(person => person.uid === selectedUid)?.status);
        $('block-applicant').textContent = blocked.has(selectedUid) ?
          (companyId === 'titan' ? 'Unblock account' : 'Unblock for company') :
          (companyId === 'titan' ? 'Block account' : 'Block for company');
        $('save-review').disabled = blocked.has(selectedUid);
        $('admin-send').disabled = blocked.has(selectedUid);
        $('schedule-interview').disabled = blocked.has(selectedUid) || selectedInterviewSource === 'calendar';
        $('cancel-interview').disabled = !selectedInterviewScheduled || (blocked.has(selectedUid) && selectedInterviewSource !== 'calendar');
        $('send-booking-invite').disabled = !calendarReady || blocked.has(selectedUid) || selectedInterviewScheduled;
        $('revoke-booking-invite').disabled = blocked.has(selectedUid);
      }
    }, error => status('page-message', error.message || 'Could not load blocked accounts.', true));
  } catch (error) {
    if (generation === authGeneration) showAccess(`Could not open private profiles: ${error.message || 'Please try again.'}`, true);
  }
}, error => {
  clearTimeout(initialAuthTimer);
  showAccess(`Could not check your sign-in: ${error.message || 'Please try again.'}`, true);
});

$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });
$('add-admin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await addAdminEmail({ email: $('new-admin-email').value.trim() });
    if (result.data.state === 'added') {
      $('new-admin-email').value = '';
      status('admin-management-message', 'Admin email saved. They will get access when they sign in with that Google account.');
    } else {
      status('admin-management-message', result.data.state === 'active' ? 'This account is already an admin.' : 'This email is already waiting for sign-in.');
    }
    await loadAdmins(authGeneration);
  } catch (error) { status('admin-management-message', error.message || 'Could not add admin.', true); }
  finally { button.disabled = false; }
});
$('refresh-admin-list').addEventListener('click', () => loadAdmins(authGeneration));
$('create-team-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  const name = $('new-team-name').value.trim();
  button.disabled = true;
  try {
    const result = await manageTeam({ action: 'create', name });
    $('new-team-name').value = '';
    selectTeam(result.data.teamId);
    $('team-title').textContent = name;
    $('team-name').value = name;
    status('roster-message', `Team ${name} created.`);
  } catch (error) { status('roster-message', error.message || 'Could not create team.', true); }
  finally { button.disabled = false; }
});
$('rename-team-form').addEventListener('submit', async event => {
  event.preventDefault();
  const teamId = selectedTeamId;
  if (!teamId) return;
  const button = event.submitter || event.target.querySelector('button[type="submit"]');
  const name = $('team-name').value.trim();
  button.disabled = true;
  try {
    await manageTeam({ action: 'rename', teamId, name });
    if (selectedTeamId === teamId) status('team-message', 'Team renamed.');
  } catch (error) { if (selectedTeamId === teamId) status('team-message', error.message || 'Could not rename team.', true); }
  finally { button.disabled = false; }
});
$('assign-applicant-team-form').addEventListener('submit', async event => {
  event.preventDefault();
  const teamId = $('assign-applicant-team').value;
  const uid = selectedUid;
  if (!teamId || !uid) return;
  assignApplicantBusy = true;
  renderApplicantTeams();
  try {
    await setTeamMember({ action: 'add', teamId, uid });
    if (selectedUid === uid) {
      $('assign-applicant-team').value = '';
      status('assign-applicant-message', `Added to ${teams.find(team => team.id === teamId)?.name || 'team'}.`);
    }
  } catch (error) { if (selectedUid === uid) status('assign-applicant-message', error.message || 'Could not add this applicant.', true); }
  finally { if (selectedUid === uid) { assignApplicantBusy = false; renderApplicantTeams(); } }
});
$('delete-team').addEventListener('click', async () => {
  const teamId = selectedTeamId;
  const name = teams.find(team => team.id === teamId)?.name || 'this team';
  if (!teamId || !confirm(`Delete ${name} and remove everyone from it?`)) return;
  const button = $('delete-team');
  button.disabled = true;
  try {
    await manageTeam({ action: 'delete', teamId });
    if (selectedTeamId === teamId) selectTeam(null);
    status('roster-message', `${name} deleted.`);
  } catch (error) { status('team-message', error.message || 'Could not delete team.', true); }
  finally { button.disabled = false; }
});
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
  if (start < new Date() || start.getTime() > Date.now() + 90 * 24 * 60 * 60 * 1000 ||
      end.getTime() - start.getTime() > 90 * 24 * 60 * 60 * 1000) {
    return status('calendar-block-message', 'Choose a block starting within the next 90 days and lasting no more than 90 days.', true);
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
$('rank-show-more').addEventListener('click', () => { rankLimit = rankLimit === 10 ? 25 : 10; renderRanking(); });

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
  if (!canAddSkills) return status('add-skill-message', 'Platform owner access required.', true);
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

$('delete-skill-button').addEventListener('click', async () => {
  if (!canAddSkills) return status('delete-skill-message', 'Platform owner access required.', true);
  const skill = catalog.byId.get($('delete-skill-select').value);
  if (!skill || !confirm(`Delete ${skill.name} from ${skill.category}? It will disappear from the applicant picker and active rankings. Past submissions will remain stored.`)) return;
  const button = $('delete-skill-button');
  button.disabled = true;
  try {
    await deleteSkill({ id: skill.id });
    status('delete-skill-message', `${skill.name} deleted from the active skill list.`);
  } catch (error) {
    status('delete-skill-message', error.message || 'Could not delete skill.', true);
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
  try { await manageApplicant({ uid: selectedUid, action }); status('account-action-message',
    companyId === 'titan' ? (action === 'block' ? 'Account blocked.' : 'Account unblocked.') :
      (action === 'block' ? 'Applicant blocked for this company.' : 'Applicant unblocked for this company.')); }
  catch (error) { status('account-action-message', error.message || 'Could not update account.', true); }
  finally { button.disabled = false; }
});

$('delete-applicant').addEventListener('click', async () => {
  if (!selectedUid || !confirm(companyId === 'titan' ?
    'Delete this profile, questionnaire, and conversation, and block the account from returning?' :
    'Delete this company’s questionnaire, skills, messages, interview, and team assignments, and block the applicant from this company? Their shared profile remains available to other companies.')) return;
  const button = $('delete-applicant');
  button.disabled = true;
  try { await manageApplicant({ uid: selectedUid, action: 'delete' }); status('page-message',
    companyId === 'titan' ? 'Profile deleted and account blocked.' : 'Company records deleted and applicant blocked for this company.'); }
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
