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
const addSkill = httpsCallable(functions, 'addSkill');
const pageSize = 25;
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });
let currentUser = null;
let applicants = [];
let blocked = new Map();
let selectedUid = null;
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
  selectedSkillData = null;
  photoPreview.hidden = true;
  $('detail-photos').replaceChildren();
  $('admin-messages').replaceChildren();
  $('admin-detail').hidden = true;
  $('admin-detail-empty').hidden = false;
}

function cleanSubscriptions() {
  cleanSelection();
  for (const unsub of [summariesUnsub, blockedUnsub, rankingsUnsub, catalogUnsub]) if (unsub) unsub();
  summariesUnsub = blockedUnsub = rankingsUnsub = catalogUnsub = null;
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
    meta.textContent = `${person.email || ''} · ${blocked.has(person.uid) ? 'Blocked' : statusLabel(person.status)}${person.questionnaireCompletedAt ? ' · Questionnaire complete' : ''}`;
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
}

function renderQuestionnaire(data) {
  const complete = data?.version === 1 && Array.isArray(data.answers) && data.answers.length === questions.length;
  $('questionnaire-summary').textContent = complete ? 'Questionnaire: complete' : 'Questionnaire: not completed';
  $('questionnaire-results').open = false;
  const list = $('questionnaire-answers');
  list.replaceChildren();
  if (!complete) return;
  questions.forEach((question, index) => {
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
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('profiles-view').hidden = false;
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
      }
    }, error => status('page-message', error.message || 'Could not load blocked accounts.', true));
  } catch (error) {
    if (generation === authGeneration) showAccess(`Could not open private profiles: ${error.message || 'Please try again.'}`);
  }
});

$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });
$('applicant-search').addEventListener('input', () => { page = 0; renderList(); });
$('previous-page').addEventListener('click', () => { if (page > 0) { page--; renderList(); } });
$('next-page').addEventListener('click', () => { if ((page + 1) * pageSize < filteredApplicants().length) { page++; renderList(); } });
$('rank-previous').addEventListener('click', () => { if (rankPage > 0) { rankPage--; renderRanking(); } });
$('rank-next').addEventListener('click', () => { if ((rankPage + 1) * pageSize < rankedApplicants().length) { rankPage++; renderRanking(); } });

$('add-skill-form').addEventListener('submit', async event => {
  event.preventDefault();
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
