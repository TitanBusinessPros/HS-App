import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { buildSkillCatalog } from './skills.js';
import { questions as defaultQuestions } from './questions.js';
import { companyLink } from './company-context.js';

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, 'us-west2');
const listCompanies = httpsCallable(functions, 'listCompanies');
const getOverview = httpsCallable(functions, 'getCompanyAccountOverview');
const listApplicants = httpsCallable(functions, 'listCompanyAccountApplicants');
const listTeamMembers = httpsCallable(functions, 'listCompanyAccountTeamMembers');
const getApplicant = httpsCallable(functions, 'getCompanyAccountApplicant');
let companies = [];
let selectedCompanyId = '';
let selectedTeamId = '';
let applicantCursor = null;
let teamCursor = null;
let overviewGeneration = 0;
let applicantGeneration = 0;
let applicantDetailGeneration = 0;
let teamGeneration = 0;
let selectedCatalog = buildSkillCatalog();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function status(message, error = false) {
  $('page-message').textContent = message;
  $('page-message').className = `message${error ? ' error' : ''}`;
}

function dateText(value) {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not set' : date.toLocaleString();
}

function empty(container, message) {
  container.replaceChildren(node('p', message, 'muted'));
}

function item(container, title, detail = '') {
  const row = node('div', null, 'company-account-item');
  row.append(node('strong', title));
  if (detail) row.append(node('span', detail));
  container.append(row);
  return row;
}

function buttonItem(container, title, detail, click) {
  const button = node('button', null, 'company-account-item company-account-button');
  button.type = 'button';
  button.append(node('strong', title));
  if (detail) button.append(node('span', detail));
  button.addEventListener('click', click);
  container.append(button);
  return button;
}

function showAccess(message, retry = false) {
  $('loading').hidden = true;
  $('companies-view').hidden = true;
  $('access-text').textContent = message;
  $('retry-companies').hidden = !retry;
  $('access-message').hidden = false;
}

function renderCompanyList() {
  const term = $('company-search').value.trim().toLowerCase();
  const list = $('company-account-list');
  list.replaceChildren();
  const shown = companies.filter(company => `${company.name} ${company.ownerEmail}`.toLowerCase().includes(term));
  $('company-count').textContent = String(companies.length);
  $('company-list-empty').hidden = shown.length > 0;
  shown.forEach(company => {
    const button = buttonItem(list, company.name, company.ownerEmail || 'Owner email unavailable', () => selectCompany(company.id));
    button.classList.toggle('selected', company.id === selectedCompanyId);
    button.setAttribute('aria-current', company.id === selectedCompanyId ? 'true' : 'false');
  });
}

async function selectCompany(companyId) {
  if (!companies.some(company => company.id === companyId)) return;
  selectedCompanyId = companyId;
  selectedTeamId = '';
  applicantCursor = null;
  teamCursor = null;
  const generation = ++overviewGeneration;
  ++applicantGeneration;
  ++applicantDetailGeneration;
  ++teamGeneration;
  const url = new URL(location.href);
  url.searchParams.set('company', companyId);
  history.replaceState(null, '', url);
  renderCompanyList();
  $('company-detail').hidden = true;
  status('Loading company account...');
  try {
    const { data } = await getOverview({ companyId });
    if (generation !== overviewGeneration) return;
    renderOverview(data);
    $('company-detail').hidden = false;
    status('');
    loadMoreApplicants(true);
  } catch (error) {
    if (generation === overviewGeneration) status(error.message || 'Could not open this company account.', true);
  }
}

function renderOverview(data) {
  const company = data.company;
  $('selected-company-name').textContent = company.name;
  $('selected-company-owner').textContent = `Owner: ${company.ownerEmail || 'Not available'}`;
  $('selected-company-state').textContent = `${company.active ? 'Active' : 'Inactive'} · ${company.listed ? 'Available to applicants' : 'Not listed for applicants'}${company.createdAt ? ` · Created ${dateText(company.createdAt)}` : ''}`;
  $('selected-company-count').textContent = `${data.applicantCount || 0} applicant${data.applicantCount === 1 ? '' : 's'} with company activity`;
  $('selected-company-page').href = companyLink('homestead.html', company.id);

  const admins = $('company-admins');
  admins.replaceChildren();
  if (!data.admins.length) empty(admins, 'No active admins.');
  for (const admin of data.admins) {
    const availability = admin.availability;
    const calendar = availability ? ` · Interview calendar: ${availability.timeZoneLabel || 'configured'}` : '';
    item(admins, admin.email || admin.uid, `${admin.role === 'owner' ? 'Owner' : 'Admin'}${calendar}`);
  }
  const pending = $('company-pending-admins');
  pending.replaceChildren();
  if (!data.pendingAdmins.length) empty(pending, 'No pending admin invitations.');
  for (const email of data.pendingAdmins) item(pending, email);

  const homestead = data.homestead;
  $('company-homestead-status').textContent = homestead.published ? 'Published' : 'Not published';
  $('company-homestead-name').textContent = homestead.name || 'No homestead page name';
  $('company-homestead-description').textContent = homestead.description || 'No description yet.';
  const fields = $('company-homestead-fields');
  fields.replaceChildren();
  for (const field of homestead.fields) item(fields, field.label || 'Detail', field.value || '');
  const photos = $('company-homestead-photos');
  photos.replaceChildren();
  for (const photo of homestead.photos) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photo.photo || '')) continue;
    const image = node('img');
    image.src = photo.photo;
    image.alt = 'Homestead photo';
    image.loading = 'lazy';
    const figure = node('figure', null, 'homestead-photo');
    figure.append(image);
    photos.append(figure);
  }

  const questionnaire = data.questionnaire;
  const configuredQuestions = Array.isArray(questionnaire.questions) ? questionnaire.questions : defaultQuestions;
  $('company-questionnaire-status').textContent = `${questionnaire.enabled ? 'On' : 'Off'} · ${configuredQuestions.length} questions`;
  const questionList = $('company-questions');
  questionList.replaceChildren();
  if (!configuredQuestions.length) empty(questionList, 'No questions configured.');
  configuredQuestions.forEach((question, index) => item(questionList, `${index + 1}. ${question.prompt || 'Untitled question'}`, `${question.section || 'General'} · ${Array.isArray(question.choices) && question.choices.length ? question.choices.join(' · ') : 'Written answer only'}`));

  selectedCatalog = buildSkillCatalog(data.catalog || []);
  const activeSkills = selectedCatalog.skills;
  $('company-skills-summary').textContent = `${activeSkills.length} active skills · ${(data.catalog || []).filter(skill => skill.deleted).length} removed`;
  const skillList = $('company-skills');
  skillList.replaceChildren();
  if (!activeSkills.length) empty(skillList, 'No active skills.');
  for (const skill of activeSkills) item(skillList, skill.name, skill.category);

  const teams = $('company-teams');
  teams.replaceChildren();
  $('company-team-members').hidden = true;
  if (!data.teams.length) empty(teams, 'No teams yet.');
  for (const team of data.teams) buttonItem(teams, team.name, 'View team members', () => selectTeam(team));

  const interviews = $('company-interviews');
  interviews.replaceChildren();
  if (!data.upcomingInterviews.length) empty(interviews, 'No upcoming interviews.');
  for (const interview of data.upcomingInterviews) {
    buttonItem(interviews, interview.name, `${dateText(interview.scheduledAt)} · ${interview.mode}`, () => selectApplicant(interview.uid));
  }

  $('company-applicants').replaceChildren();
  $('company-applicant-detail').hidden = true;
  $('more-company-applicants').hidden = true;
}

async function loadMoreApplicants(reset = false) {
  const companyId = selectedCompanyId;
  const generation = reset ? ++applicantGeneration : applicantGeneration;
  const cursor = reset ? null : applicantCursor;
  const more = $('more-company-applicants');
  more.disabled = true;
  try {
    const { data } = await listApplicants({ companyId, cursor });
    if (companyId !== selectedCompanyId || generation !== applicantGeneration) return;
    const list = $('company-applicants');
    if (reset) list.replaceChildren();
    if (reset && !data.applicants.length) empty(list, 'No applicants have company activity yet.');
    for (const applicant of data.applicants) {
      const detail = [applicant.email, applicant.status, applicant.skillCount ? `${applicant.skillCount} skills` : '', applicant.interviewAt ? `Interview ${dateText(applicant.interviewAt)}` : ''].filter(Boolean).join(' · ');
      buttonItem(list, applicant.name, detail, () => selectApplicant(applicant.uid));
    }
    applicantCursor = data.nextCursor;
    more.hidden = !applicantCursor;
  } catch (error) {
    if (generation === applicantGeneration) status(error.message || 'Could not load applicants.', true);
  } finally { more.disabled = false; }
}

async function selectTeam(team) {
  selectedTeamId = team.id;
  teamCursor = null;
  const generation = ++teamGeneration;
  $('company-team-name').textContent = team.name;
  $('company-team-member-list').replaceChildren();
  $('company-team-members').hidden = false;
  $('more-team-members').hidden = true;
  await loadMoreTeamMembers(true, generation);
}

async function loadMoreTeamMembers(reset = false, expectedGeneration = teamGeneration) {
  const companyId = selectedCompanyId;
  const teamId = selectedTeamId;
  const cursor = reset ? null : teamCursor;
  const more = $('more-team-members');
  more.disabled = true;
  try {
    const { data } = await listTeamMembers({ companyId, teamId, cursor });
    if (companyId !== selectedCompanyId || teamId !== selectedTeamId || expectedGeneration !== teamGeneration) return;
    const list = $('company-team-member-list');
    if (reset) list.replaceChildren();
    if (reset && !data.members.length) empty(list, 'No team members yet.');
    for (const member of data.members) buttonItem(list, member.name, member.email, () => selectApplicant(member.uid));
    teamCursor = data.nextCursor;
    more.hidden = !teamCursor;
  } catch (error) {
    if (expectedGeneration === teamGeneration) status(error.message || 'Could not load team members.', true);
  } finally { more.disabled = false; }
}

async function selectApplicant(uid) {
  const companyId = selectedCompanyId;
  const generation = ++applicantDetailGeneration;
  const detail = $('company-applicant-detail');
  detail.hidden = false;
  detail.replaceChildren(node('p', 'Loading applicant...', 'muted'));
  try {
    const { data } = await getApplicant({ companyId, uid });
    if (companyId !== selectedCompanyId || generation !== applicantDetailGeneration) return;
    renderApplicant(data, detail);
  } catch (error) {
    if (generation === applicantDetailGeneration) empty(detail, error.message || 'Could not open this applicant.');
  }
}

function renderApplicant(data, detail) {
  detail.replaceChildren();
  detail.append(node('h3', data.profile.name || 'Applicant'));
  const facts = [data.email, data.profile.location, `Review status: ${data.status}`].filter(Boolean);
  detail.append(node('p', facts.join(' · '), 'field-help'));
  if (data.bio) detail.append(node('p', data.bio, 'detail-bio'));
  if (data.website) item(detail, 'Website', data.website);
  for (const link of data.socialLinks || []) item(detail, 'Social link', String(link));
  const photos = node('div', null, 'detail-photos');
  for (const photo of data.photos || []) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(photo)) continue;
    const image = node('img');
    image.src = photo;
    image.alt = 'Applicant photo';
    image.loading = 'lazy';
    photos.append(image);
  }
  detail.append(photos);

  detail.append(node('h4', 'Questionnaire answers'));
  const answerList = node('div', null, 'company-account-items');
  const submission = data.questionnaire;
  const questions = Array.isArray(submission?.questions) ? submission.questions : defaultQuestions;
  if (!submission || !Array.isArray(submission.answers) || !submission.answers.length) empty(answerList, 'No questionnaire answers.');
  else submission.answers.forEach((answer, index) => {
    const question = questions[index] || {};
    const answerText = Number.isInteger(answer) ? question.choices?.[answer] || 'No answer' :
      typeof answer?.text === 'string' ? `Written answer: ${answer.text}` : 'No answer';
    item(answerList, question.prompt || `Question ${index + 1}`, answerText);
  });
  detail.append(answerList);

  detail.append(node('h4', 'Selected skills'));
  const skills = node('div', null, 'company-account-items');
  if (!data.skills.length) empty(skills, 'No skills selected.');
  for (const entry of data.skills) {
    const skill = selectedCatalog.byId.get(String(entry.id));
    item(skills, `${skill?.name || 'Removed skill'} · ${entry.years || 0} years`, entry.organization || 'No organization listed');
  }
  detail.append(skills);

  detail.append(node('h4', 'Interview'));
  const interview = node('div', null, 'company-account-items');
  if (!data.interview) empty(interview, 'No interview scheduled.');
  else item(interview, `${dateText(data.interview.scheduledAt)} · ${data.interview.timeZoneLabel || 'Time zone not listed'}`, [data.interview.mode, data.interview.note, data.interview.meetingLink].filter(Boolean).join(' · '));
  detail.append(interview);

  detail.append(node('h4', 'Recent company messages (up to 100)'));
  const messages = node('div', null, 'company-account-items');
  if (!data.messages.length) empty(messages, 'No messages.');
  for (const message of data.messages) item(messages, `${message.senderRole === 'admin' ? 'Admin' : 'Applicant'} · ${dateText(message.createdAt)}`, message.text);
  detail.append(messages);
}

$('company-search').addEventListener('input', renderCompanyList);
$('more-company-applicants').addEventListener('click', () => loadMoreApplicants());
$('more-team-members').addEventListener('click', () => loadMoreTeamMembers());
$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });

onAuthStateChanged(auth, async user => {
  if (!user) return showAccess('Sign in with the Titan Business Pros master admin account to view company accounts.');
  $('account-email').textContent = user.email || '';
  $('sign-out').hidden = false;
  if (user.email?.toLowerCase() !== 'titanbusinesspros@gmail.com' ||
      !user.providerData.some(provider => provider.providerId === 'google.com')) {
    return showAccess('Only the Titan Business Pros master admin account can view company accounts.');
  }
  try {
    const [admin, blocked, result] = await Promise.all([
      getDoc(doc(db, 'admins', user.uid)), getDoc(doc(db, 'blockedUsers', user.uid)), listCompanies()
    ]);
    if (!admin.exists() || blocked.exists() || (admin.data().companyId || 'titan') !== 'titan') {
      return showAccess('Only the Titan Business Pros master admin account can view company accounts.');
    }
    companies = [{ id: 'titan', name: 'Titan Business Pros', ownerEmail: 'titanbusinesspros@gmail.com' },
      ...(result.data.companies || [])].sort((a, b) => a.id === 'titan' ? -1 : b.id === 'titan' ? 1 : a.name.localeCompare(b.name));
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('companies-view').hidden = false;
    renderCompanyList();
    const requested = new URLSearchParams(location.search).get('company');
    selectCompany(companies.some(company => company.id === requested) ? requested : 'titan');
  } catch (error) {
    showAccess(`Could not open company accounts: ${error.message || 'Please try again.'}`, true);
  }
});
