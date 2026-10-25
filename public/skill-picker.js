import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { buildSkillCatalog } from './skills.js';
import { requestedCompany, companySegments, companyLink } from './company-context.js';

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const companyId = requestedCompany();
const scopedDoc = (...parts) => doc(db, ...companySegments(companyId, ...parts));
const scopedCollection = (...parts) => collection(db, ...companySegments(companyId, ...parts));
document.querySelectorAll('a[href="./"]').forEach(link => { link.href = companyLink('./', companyId); });
const saveSkills = httpsCallable(getFunctions(app, 'us-west2'), 'saveSkills');
const selected = new Map();
let catalog = buildSkillCatalog();
let catalogUnsub = null;
let authGeneration = 0;

function showAccess(message) {
  $('loading').hidden = true;
  $('skills-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function renderCatalog() {
  const term = $('skill-search').value.trim().toLowerCase();
  const list = $('skill-catalog');
  list.replaceChildren();
  let shown = 0;
  for (const category of catalog.categories) {
    const matching = catalog.skills.filter(skill => skill.category === category &&
      (`${skill.name} ${skill.category}`).toLowerCase().includes(term));
    if (!matching.length) continue;
    shown += matching.length;
    const heading = document.createElement('h3');
    heading.className = 'skill-category-heading';
    heading.textContent = category;
    const grid = document.createElement('div');
    grid.className = 'skill-options';
    matching.forEach(skill => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `skill-option ${selected.has(String(skill.id)) ? 'selected' : ''}`;
      button.setAttribute('aria-pressed', String(selected.has(String(skill.id))));
      button.textContent = skill.name;
      button.addEventListener('click', () => {
        const key = String(skill.id);
        if (selected.has(key)) selected.delete(key);
        else if (selected.size >= 10) {
          $('skills-message').className = 'message error';
          $('skills-message').textContent = 'Choose no more than 10 skills. Remove one before adding another.';
          return;
        } else selected.set(key, { id: skill.id, years: '', organization: '' });
        renderCatalog();
        renderSelected();
      });
      grid.append(button);
    });
    list.append(heading, grid);
  }
  if (!shown) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No matching skills.';
    list.append(empty);
  }
  $('selected-count').textContent = `${selected.size} of 10 skills selected`;
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
  [...selected.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))).forEach(entry => {
    const skill = catalog.byId.get(String(entry.id));
    const card = document.createElement('div');
    card.className = 'selected-skill';
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const title = document.createElement('h3');
    title.textContent = skill?.name || 'Skill no longer available';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => { selected.delete(String(entry.id)); renderCatalog(); renderSelected(); });
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
  const generation = ++authGeneration;
  if (catalogUnsub) catalogUnsub();
  catalogUnsub = null;
  selected.clear();
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Sign in with Google and save your applicant profile before adding skills.');
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) return showAccess('This account cannot use Homesteader.');
    if ((await getDoc(doc(db, 'admins', user.uid))).exists()) return showAccess('Admins do not need applicant skills.');
    if (!(await getDoc(doc(db, 'users', user.uid))).exists()) return showAccess('Save your applicant profile first, then return to add skills.');
    const saved = await getDoc(scopedDoc('skills', user.uid));
    if (generation !== authGeneration) return;
    if (saved.exists() && saved.data().version === 1) {
      for (const entry of saved.data().entries || []) {
        if ((Number.isInteger(entry.id) && entry.id >= 0 && entry.id < 100) ||
            (typeof entry.id === 'string' && /^custom_[a-f0-9]{32}$/.test(entry.id))) {
          selected.set(String(entry.id), { id: entry.id, years: String(entry.years), organization: entry.organization || '' });
        }
      }
    }
    catalogUnsub = onSnapshot(scopedCollection('skillCatalog'), snapshot => {
      if (generation !== authGeneration) return;
      catalog = buildSkillCatalog(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      for (const id of selected.keys()) if (!catalog.byId.has(id)) selected.delete(id);
      renderCatalog();
      renderSelected();
      $('loading').hidden = true;
      $('access-message').hidden = true;
      $('skills-view').hidden = false;
    }, error => {
      if (generation === authGeneration) showAccess(`Could not load skills: ${error.message || 'Please try again.'}`);
    });
  } catch (error) {
    if (generation === authGeneration) showAccess(`Could not open skills: ${error.message || 'Please try again.'}`);
  }
});

$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });
$('skill-search').addEventListener('input', renderCatalog);

$('skills-form').addEventListener('submit', async event => {
  event.preventDefault();
  const entries = [...selected.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(entry => ({
    id: entry.id,
    years: entry.years === '' ? NaN : Number(entry.years),
    organization: entry.organization.trim()
  }));
  const message = $('skills-message');
  if (entries.length > 10) {
    message.className = 'message error';
    message.textContent = 'Choose no more than 10 skills before saving.';
    return;
  }
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
    await saveSkills({ entries, companyId });
    message.className = 'message success';
    message.textContent = 'Your skills have been saved for admin review.';
  } catch (error) {
    message.className = 'message error';
    message.textContent = error.message || 'Could not save skills. Please try again.';
  } finally {
    button.disabled = false;
  }
});
