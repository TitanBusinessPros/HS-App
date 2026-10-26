import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { questions } from './questions.js';
import { requestedCompany, companySegments, companyLink, questionnaireAvailable } from './company-context.js';
import { readQuestionnaireAnswers, renderQuestionnaireQuestions } from './questionnaire-form.js';

const $ = id => document.getElementById(id);
const questionnairePanel = $('homestead-questionnaire');
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
let companyId = requestedCompany();
const scopedDoc = (...parts) => doc(db, ...companySegments(companyId, ...parts));
const scopedCollection = (...parts) => collection(db, ...companySegments(companyId, ...parts));
const functions = getFunctions(app, 'us-west2');
const savePage = httpsCallable(functions, 'saveHomesteadPage');
const addPhoto = httpsCallable(functions, 'addHomesteadPhoto');
const deletePhoto = httpsCallable(functions, 'deleteHomesteadPhoto');
const saveQuestionnaire = httpsCallable(functions, 'saveQuestionnaire');
const suggestedTopics = [
  'Location area', 'Acreage', 'Number of structures', 'Rent or work trade for structures',
  'Current residents', 'Maximum residents'
];
let isAdmin = false;
let isMasterAdmin = false;
let pageUnsub = null;
let photosUnsub = null;
let questionnaireConfigUnsub = null;
let authGeneration = 0;
let editorInitialized = false;
let topics = [];
let photos = [];
let pagePublished = false;
let questionnaireConfigLoaded = false;
let questionnaireConfig = null;
let questionnaireQuestions = questions;
let questionnaireRevision = 0;
let savedQuestionnaire = null;
let applicantProfileExists = false;

function status(id, message, error = false) {
  $(id).textContent = message;
  $(id).className = `message ${error ? 'error' : 'success'}`;
}

function showAccess(message) {
  $('loading').hidden = true;
  $('page-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function questionnaireAnswers() {
  return readQuestionnaireAnswers($('homestead-questionnaire-form'), questionnaireQuestions);
}

function updateQuestionnaireProgress() {
  const answered = questionnaireAnswers().filter(answer => answer !== null).length;
  $('homestead-questionnaire-progress').textContent = `${answered} of ${questionnaireQuestions.length} answered`;
}

function updateQuestionnaireVisibility() {
  if (!questionnairePanel) return;
  questionnairePanel.hidden = isAdmin || !pagePublished || !questionnaireConfigLoaded ||
    !questionnaireAvailable(companyId, questionnaireConfig);
}

function renderApplicantQuestionnaire(savedAnswers = []) {
  renderQuestionnaireQuestions($('homestead-questions-list'), questionnaireQuestions,
    savedAnswers, updateQuestionnaireProgress);
  $('homestead-questionnaire-profile-note').hidden = applicantProfileExists;
  $('homestead-save-questionnaire').disabled = !applicantProfileExists;
}

function matchingSavedAnswers() {
  const legacyMatch = savedQuestionnaire?.version === 1 &&
    JSON.stringify(questionnaireQuestions) === JSON.stringify(questions);
  return (savedQuestionnaire?.version === 2 &&
    savedQuestionnaire.revision === questionnaireRevision) || legacyMatch ?
    savedQuestionnaire.answers : [];
}

async function loadApplicantQuestionnaireData(generation, uid) {
  try {
    const profileExists = (await getDoc(doc(db, 'users', uid))).exists();
    let saved = null;
    if (profileExists) {
      try {
        const snapshot = await getDoc(scopedDoc('questionnaires', uid));
        saved = snapshot.exists() ? snapshot.data() : null;
      } catch (error) {
        if (error.code !== 'permission-denied') throw error;
      }
    }
    if (generation !== authGeneration) return;
    applicantProfileExists = profileExists;
    savedQuestionnaire = saved;
    if (questionnaireConfigLoaded && questionnaireAvailable(companyId, questionnaireConfig)) {
      const pendingAnswers = questionnaireAnswers();
      renderApplicantQuestionnaire(pendingAnswers.some(answer => answer !== null) ?
        pendingAnswers : matchingSavedAnswers());
    }
  } catch (error) {
    if (generation === authGeneration) status('page-message',
      `The homestead page opened, but your questionnaire details could not load: ${error.message || 'Please reload.'}`, true);
  }
}

function wordCount() {
  const count = $('edit-homestead-description').value.trim().split(/\s+/).filter(Boolean).length;
  $('description-count').textContent = `${count} / 2,000 words`;
  $('description-count').style.color = count > 2000 ? '#a33d2f' : '';
  return count;
}

function renderTopics() {
  const list = $('topic-editor');
  list.replaceChildren();
  topics.forEach((topic, index) => {
    const row = document.createElement('div');
    row.className = 'topic-edit-row';
    const label = document.createElement('input');
    label.type = 'text';
    label.maxLength = 80;
    label.required = true;
    label.placeholder = 'Topic name';
    label.setAttribute('aria-label', `Topic ${index + 1} name`);
    label.value = topic.label;
    label.addEventListener('input', () => { topic.label = label.value; });
    const detail = document.createElement('textarea');
    detail.rows = 2;
    detail.maxLength = 500;
    detail.placeholder = 'Information for applicants';
    detail.setAttribute('aria-label', `Topic ${index + 1} details`);
    detail.value = topic.value;
    detail.addEventListener('input', () => { topic.value = detail.value; });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'text-button';
    remove.textContent = 'Remove topic';
    remove.addEventListener('click', () => { topics.splice(index, 1); renderTopics(); });
    row.append(label, detail, remove);
    list.append(row);
  });
}

function renderPage(data) {
  const published = data?.published === true;
  pagePublished = published;
  updateQuestionnaireVisibility();
  $('homestead-empty').hidden = published;
  $('homestead-content').hidden = !published && !isAdmin;
  $('homestead-about-section').hidden = !published;
  $('homestead-details-section').hidden = !published;
  $('homestead-name').textContent = published ? data.name : 'About the homestead';
  if (published) {
    $('homestead-description').textContent = data.description || '';
    const details = $('homestead-details');
    details.replaceChildren();
    for (const field of data.fields || []) {
      if (!field.value) continue;
      const row = document.createElement('div');
      row.className = 'homestead-detail';
      const label = document.createElement('strong');
      label.textContent = field.label;
      const value = document.createElement('span');
      value.textContent = field.value;
      row.append(label, value);
      details.append(row);
    }
    $('homestead-details-section').hidden = !details.childElementCount;
  }
  if (isMasterAdmin && !editorInitialized) {
    $('edit-homestead-name').value = data?.name || '';
    $('edit-homestead-description').value = data?.description || '';
    topics = Array.isArray(data?.fields) ? data.fields.map(field => ({ label: field.label, value: field.value })) :
      suggestedTopics.map(label => ({ label, value: '' }));
    renderTopics();
    wordCount();
    editorInitialized = true;
  }
}

function renderPhotos() {
  const gallery = $('homestead-gallery');
  gallery.replaceChildren();
  $('homestead-photo-count').textContent = String(photos.length);
  $('homestead-no-photos').hidden = photos.length > 0;
  for (const [index, item] of photos.entries()) {
    const card = document.createElement('figure');
    card.className = 'homestead-photo';
    const img = document.createElement('img');
    img.src = item.photo;
    img.alt = `Homestead photo ${index + 1}`;
    card.append(img);
    if (isMasterAdmin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button';
      remove.textContent = 'Remove photo';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await deletePhoto({ id: item.id }); status('photo-upload-message', 'Photo removed.'); }
        catch (error) { status('photo-upload-message', error.message || 'Could not remove photo.', true); remove.disabled = false; }
      });
      card.append(remove);
    }
    gallery.append(card);
  }
}

function watchPhotos(generation) {
  if (photosUnsub) return;
  photosUnsub = onSnapshot(scopedCollection('homesteadPhotos'), snapshot => {
    if (generation !== authGeneration) return;
    photos = snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
      .sort((a, b) => (a.addedAt?.toMillis?.() || 0) - (b.addedAt?.toMillis?.() || 0));
    renderPhotos();
  }, error => status('page-message', error.message || 'Could not load homestead photos.', true));
}

onAuthStateChanged(auth, async user => {
  const generation = ++authGeneration;
  if (pageUnsub) pageUnsub();
  if (photosUnsub) photosUnsub();
  if (questionnaireConfigUnsub) questionnaireConfigUnsub();
  pageUnsub = photosUnsub = questionnaireConfigUnsub = null;
  editorInitialized = false;
  isAdmin = false;
  isMasterAdmin = false;
  photos = [];
  pagePublished = false;
  questionnaireConfigLoaded = false;
  questionnaireConfig = null;
  questionnaireQuestions = questions;
  questionnaireRevision = 0;
  savedQuestionnaire = null;
  applicantProfileExists = false;
  if (questionnairePanel) {
    questionnairePanel.hidden = true;
    questionnairePanel.open = false;
    $('homestead-questions-list').replaceChildren();
  }
  renderPhotos();
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Sign in with Google to see the homestead.');
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) return showAccess('This account cannot use Homesteader.');
    const adminRecord = await getDoc(doc(db, 'admins', user.uid));
    isAdmin = adminRecord.exists();
    if (isAdmin) companyId = adminRecord.data().companyId || 'titan';
    isMasterAdmin = isAdmin && (companyId === 'titan' ?
      user.email?.toLowerCase() === 'titanbusinesspros@gmail.com' : adminRecord.data().role === 'owner');
    document.querySelectorAll('a[href="./"]').forEach(link => { link.href = companyLink('./', companyId); });
    if (generation !== authGeneration) return;
    if (questionnairePanel) $('homestead-questionnaire-profile-link').href = companyLink('./', companyId);
    $('admin-editor').hidden = !isMasterAdmin;
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('page-view').hidden = false;
    pageUnsub = onSnapshot(scopedDoc('homesteadPage', 'main'), snapshot => {
      if (generation !== authGeneration) return;
      const data = snapshot.exists() ? snapshot.data() : null;
      renderPage(data);
      if (isAdmin || data?.published === true) watchPhotos(generation);
      else if (photosUnsub) {
        photosUnsub();
        photosUnsub = null;
        photos = [];
        renderPhotos();
      }
    }, error => status('page-message', error.message || 'Could not load homestead details.', true));
    if (!isAdmin && questionnairePanel) questionnaireConfigUnsub = onSnapshot(scopedDoc('questionnaireConfig', 'main'), snapshot => {
      if (generation !== authGeneration) return;
      const previousRevision = questionnaireRevision;
      const pendingAnswers = questionnaireAnswers();
      questionnaireConfig = snapshot.data() || null;
      questionnaireConfigLoaded = true;
      questionnaireQuestions = questionnaireConfig?.questions || questions;
      questionnaireRevision = questionnaireConfig?.questionRevision || 0;
      if (questionnaireAvailable(companyId, questionnaireConfig)) {
        const savedAnswers = matchingSavedAnswers();
        renderApplicantQuestionnaire(previousRevision === questionnaireRevision &&
          pendingAnswers.some(answer => answer !== null) ? pendingAnswers : savedAnswers);
      }
      updateQuestionnaireVisibility();
    }, error => status('page-message', error.message || 'Could not load questionnaire.', true));
    if (!isAdmin && questionnairePanel) loadApplicantQuestionnaireData(generation, user.uid);
  } catch (error) {
    if (generation === authGeneration) showAccess(`Could not open the homestead page: ${error.message || 'Please try again.'}`);
  }
});

questionnairePanel?.querySelector('form')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (isAdmin || !applicantProfileExists || !pagePublished ||
      !questionnaireAvailable(companyId, questionnaireConfig)) return;
  const answers = questionnaireAnswers();
  if (answers.some(answer => answer === null)) {
    return status('homestead-questionnaire-message',
      `Please answer all ${questionnaireQuestions.length} questions before saving.`, true);
  }
  const button = $('homestead-save-questionnaire');
  button.disabled = true;
  status('homestead-questionnaire-message', 'Saving your answers...');
  try {
    const revision = questionnaireRevision;
    await saveQuestionnaire({ answers, revision, companyId });
    savedQuestionnaire = { version: questionnaireConfig ? 2 : 1, revision, answers };
    status('homestead-questionnaire-message', 'Your answers were saved for this homestead to review.');
  } catch (error) {
    status('homestead-questionnaire-message', error.message || 'Could not save your answers.', true);
  } finally {
    button.disabled = false;
  }
});

$('sign-out').addEventListener('click', async () => { await signOut(auth); location.href = './'; });
$('edit-homestead-description').addEventListener('input', wordCount);
$('add-topic').addEventListener('click', () => {
  if (topics.length >= 40) return status('save-page-message', 'Remove a topic before adding another.', true);
  topics.push({ label: '', value: '' });
  renderTopics();
  $('topic-editor').lastElementChild?.querySelector('input')?.focus();
});
$('homestead-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isMasterAdmin) return status('save-page-message', 'Company owner access required.', true);
  if (wordCount() > 2000) return status('save-page-message', 'Keep the description within 2,000 words.', true);
  const button = $('save-homestead');
  button.disabled = true;
  try {
    await savePage({
      name: $('edit-homestead-name').value.trim(),
      description: $('edit-homestead-description').value.trim(),
      fields: topics.map(topic => ({ label: topic.label.trim(), value: topic.value.trim() }))
    });
    status('save-page-message', 'Homestead page saved.');
  } catch (error) {
    status('save-page-message', error.message || 'Could not save the homestead page.', true);
  } finally {
    button.disabled = false;
  }
});

$('add-homestead-photos').addEventListener('change', async event => {
  if (!isMasterAdmin) return status('photo-upload-message', 'Company owner access required.', true);
  const files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;
  if (photos.length + files.length > 20) return status('photo-upload-message', 'The homestead page can show up to 20 photos.', true);
  event.target.disabled = true;
  try {
    for (const [index, file] of files.entries()) {
      status('photo-upload-message', `Preparing photo ${index + 1} of ${files.length}...`);
      const photo = await preparePhoto(file);
      await addPhoto({ photo });
      status('photo-upload-message', `Added photo ${index + 1} of ${files.length}.`);
    }
  } catch (error) {
    status('photo-upload-message', error.message || 'Could not add a photo.', true);
  } finally {
    event.target.disabled = false;
  }
});

async function preparePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('Choose a JPG, PNG, or WebP image smaller than 10 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 7; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const photo = canvas.toDataURL('image/jpeg', Math.max(0.45, 0.78 - attempt * 0.05));
      if (photo.length <= 200000) return photo;
      scale *= 0.78;
    }
    throw new Error('This photo is too detailed. Choose a smaller image.');
  } finally {
    bitmap.close();
  }
}
