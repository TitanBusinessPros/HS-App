import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { skills, skillCategories } from './skills.js';

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const saveSkills = httpsCallable(getFunctions(app, 'us-west2'), 'saveSkills');
const selected = new Map();

function showAccess(message) {
  $('loading').hidden = true;
  $('skills-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function renderCatalog() {
  const term = $('skill-search').value.trim().toLowerCase();
  const catalog = $('skill-catalog');
  catalog.replaceChildren();
  let shown = 0;
  for (const category of skillCategories) {
    const matching = skills.filter(skill => skill.category === category.name &&
      (`${skill.name} ${skill.category}`).toLowerCase().includes(term));
    if (!matching.length) continue;
    shown += matching.length;
    const heading = document.createElement('h3');
    heading.className = 'skill-category-heading';
    heading.textContent = category.name;
    const grid = document.createElement('div');
    grid.className = 'skill-options';
    matching.forEach(skill => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `skill-option ${selected.has(skill.id) ? 'selected' : ''}`;
      button.setAttribute('aria-pressed', String(selected.has(skill.id)));
      button.textContent = skill.name;
      button.addEventListener('click', () => {
        if (selected.has(skill.id)) selected.delete(skill.id);
        else selected.set(skill.id, { id: skill.id, years: '', organization: '' });
        renderCatalog();
        renderSelected();
      });
      grid.append(button);
    });
    catalog.append(heading, grid);
  }
  if (!shown) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No matching skills.';
    catalog.append(empty);
  }
  $('selected-count').textContent = `${selected.size} of ${skills.length} skills selected`;
}

function renderSelected() {
  const list = $('selected-skills');
  list.replaceChildren();
  if (!selected.size) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Select a skill above to add your experience.';
    list.append(empty);
    return;
  }
  [...selected.values()].sort((a, b) => a.id - b.id).forEach(entry => {
    const skill = skills[entry.id];
    const card = document.createElement('div');
    card.className = 'selected-skill';
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const title = document.createElement('h3');
    title.textContent = skill.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => { selected.delete(entry.id); renderCatalog(); renderSelected(); });
    heading.append(title, remove);
    const yearsLabel = document.createElement('label');
    yearsLabel.htmlFor = `skill-years-${entry.id}`;
    yearsLabel.textContent = 'Years of experience';
    const years = document.createElement('input');
    years.id = yearsLabel.htmlFor;
    years.type = 'number';
    years.min = '0';
    years.max = '80';
    years.step = '0.5';
    years.required = true;
    years.value = entry.years;
    years.addEventListener('input', () => { entry.years = years.value; });
    const proofLabel = document.createElement('label');
    proofLabel.htmlFor = `skill-organization-${entry.id}`;
    proofLabel.textContent = 'Can you prove you are skilled in this area? Enter the company or organization you worked for or with.';
    const proof = document.createElement('input');
    proof.id = proofLabel.htmlFor;
    proof.type = 'text';
    proof.maxLength = 120;
    proof.required = true;
    proof.placeholder = 'Company, organization, or your homestead';
    proof.value = entry.organization;
    proof.addEventListener('input', () => { entry.organization = proof.value; });
    card.append(heading, yearsLabel, years, proofLabel, proof);
    list.append(card);
  });
}

onAuthStateChanged(auth, async user => {
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Sign in with Google and save your applicant profile before adding skills.');
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) return showAccess('This account cannot use Homesteader.');
    if ((await getDoc(doc(db, 'admins', user.uid))).exists()) return showAccess('Admins do not need applicant skills.');
    if (!(await getDoc(doc(db, 'users', user.uid))).exists()) return showAccess('Save your applicant profile first, then return to add skills.');
    const saved = await getDoc(doc(db, 'skills', user.uid));
    selected.clear();
    if (saved.exists() && saved.data().version === 1) {
      for (const entry of saved.data().entries || []) {
        if (Number.isInteger(entry.id) && entry.id >= 0 && entry.id < skills.length) {
          selected.set(entry.id, { id: entry.id, years: String(entry.years), organization: entry.organization || '' });
        }
      }
    }
    renderCatalog();
    renderSelected();
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('skills-view').hidden = false;
  } catch (error) {
    showAccess(`Could not open skills: ${error.message || 'Please try again.'}`);
  }
});

$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });
$('skill-search').addEventListener('input', renderCatalog);

$('skills-form').addEventListener('submit', async event => {
  event.preventDefault();
  const entries = [...selected.values()].sort((a, b) => a.id - b.id).map(entry => ({
    id: entry.id,
    years: entry.years === '' ? NaN : Number(entry.years),
    organization: entry.organization.trim()
  }));
  const message = $('skills-message');
  if (entries.some(entry => !Number.isFinite(entry.years) || entry.years < 0 || entry.years > 80 ||
      !Number.isInteger(entry.years * 2) || entry.organization.length < 2)) {
    message.className = 'message error';
    message.textContent = 'Enter valid years and a company, organization, or homestead for every selected skill.';
    return;
  }
  const button = $('save-skills');
  button.disabled = true;
  message.className = 'message';
  message.textContent = 'Saving skills...';
  try {
    await saveSkills({ entries });
    message.className = 'message success';
    message.textContent = 'Your skills have been saved for admin review.';
  } catch (error) {
    message.className = 'message error';
    message.textContent = error.message || 'Could not save skills. Please try again.';
  } finally {
    button.disabled = false;
  }
});
