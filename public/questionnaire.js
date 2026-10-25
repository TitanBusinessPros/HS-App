import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { questions } from './questions.js';
import { requestedCompany, companySegments, companyLink } from './company-context.js';

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const companyId = requestedCompany();
const scopedDoc = (...parts) => doc(db, ...companySegments(companyId, ...parts));
document.querySelectorAll('a[href="./"]').forEach(link => { link.href = companyLink('./', companyId); });
const saveQuestionnaire = httpsCallable(getFunctions(app, 'us-west2'), 'saveQuestionnaire');
let currentQuestions = questions;
let currentRevision = 0;
let savedData = null;
let configUnsub = null;
let authGeneration = 0;

function showAccess(message) {
  $('loading').hidden = true;
  $('questionnaire-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function readAnswers() {
  return currentQuestions.map((question, index) => {
    const written = $(`written-answer-${index}`)?.value.trim() || '';
    if (!question.choices.length) return written ? { text: written } : null;
    const selected = document.querySelector(`input[name="answer-${index}"]:checked`);
    if (!selected) return null;
    if (selected.value === 'written') return written ? { text: written } : null;
    return Number(selected.value);
  });
}

function updateProgress() {
  const count = readAnswers().filter(answer => answer !== null).length;
  $('questionnaire-progress').textContent = `${count} of ${currentQuestions.length} answered`;
}

function renderQuestions(savedAnswers = []) {
  const list = $('questions-list');
  list.replaceChildren();
  let currentSection = '';
  currentQuestions.forEach((question, index) => {
    if (question.section !== currentSection) {
      currentSection = question.section;
      const heading = document.createElement('h2');
      heading.className = 'question-section';
      heading.textContent = currentSection;
      list.append(heading);
    }
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'question';
    const legend = document.createElement('legend');
    legend.textContent = `${index + 1}. ${question.prompt}`;
    fieldset.append(legend);
    const written = document.createElement('div');
    written.className = 'written-answer';
    written.hidden = question.choices.length > 0 && typeof savedAnswers[index]?.text !== 'string';
    const writtenLabel = document.createElement('label');
    writtenLabel.htmlFor = `written-answer-${index}`;
    writtenLabel.textContent = 'Your written answer (up to 500 characters)';
    const writtenInput = document.createElement('textarea');
    writtenInput.id = `written-answer-${index}`;
    writtenInput.rows = 3;
    writtenInput.maxLength = 500;
    writtenInput.value = typeof savedAnswers[index]?.text === 'string' ? savedAnswers[index].text : '';
    writtenInput.addEventListener('input', updateProgress);
    written.append(writtenLabel, writtenInput);
    question.choices.forEach((choice, choiceIndex) => {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `answer-${index}`;
      input.value = String(choiceIndex);
      input.checked = savedAnswers[index] === choiceIndex;
      input.addEventListener('change', () => { written.hidden = true; updateProgress(); });
      const span = document.createElement('span');
      span.textContent = choice;
      label.append(input, span);
      fieldset.append(label);
    });
    if (question.choices.length) {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `answer-${index}`;
      input.value = 'written';
      input.checked = typeof savedAnswers[index]?.text === 'string';
      input.addEventListener('change', () => {
        written.hidden = false;
        writtenInput.focus();
        updateProgress();
      });
      const span = document.createElement('span');
      span.textContent = 'Write my own answer';
      label.append(input, span);
      fieldset.append(label);
    }
    fieldset.append(written);
    list.append(fieldset);
  });
  updateProgress();
}

onAuthStateChanged(auth, async user => {
  const generation = ++authGeneration;
  if (configUnsub) configUnsub();
  configUnsub = null;
  savedData = null;
  currentQuestions = questions;
  currentRevision = 0;
  $('questions-list').replaceChildren();
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Open Homesteader and sign in with Google to take the questionnaire.');
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) return showAccess('This account cannot use Homesteader.');
    if ((await getDoc(doc(db, 'admins', user.uid))).exists()) return showAccess('Admins do not need an applicant questionnaire.');
    if (!(await getDoc(doc(db, 'users', user.uid))).exists()) return showAccess('Save your applicant profile first, then return to the questionnaire.');
    const saved = await getDoc(scopedDoc('questionnaires', user.uid));
    if (generation !== authGeneration) return;
    savedData = saved.exists() ? saved.data() : null;
    configUnsub = onSnapshot(scopedDoc('questionnaireConfig', 'main'), snapshot => {
      if (generation !== authGeneration) return;
      const config = snapshot.data();
      if (config?.enabled === false) return showAccess('The homesteading questionnaire is currently turned off.');
      const previousRevision = currentRevision;
      const pendingAnswers = readAnswers();
      currentQuestions = config?.questions || questions;
      currentRevision = config?.questionRevision || 0;
      const questionValues = value => JSON.stringify(value.map(question =>
        [question.section, question.prompt, question.choices]));
      const legacyQuestionsMatch = savedData?.version === 1 &&
        questionValues(currentQuestions) === questionValues(questions);
      const savedAnswers = (config && savedData?.version === 2 && savedData.revision === currentRevision) ||
        legacyQuestionsMatch ? savedData.answers : [];
      $('questionnaire-intro').textContent = `Answer these ${currentQuestions.length} questions about your experience, availability, and approach to homesteading. Choose a preset answer or write your own for each question. Only you and this company's admins can see these answers. You can return to update them.`;
      renderQuestions(previousRevision === currentRevision && pendingAnswers.some(answer => answer !== null) ? pendingAnswers : savedAnswers);
      $('loading').hidden = true;
      $('access-message').hidden = true;
      $('questionnaire-view').hidden = false;
    }, error => showAccess(`Could not open the questionnaire: ${error.message || 'Please try again.'}`));
  } catch (error) {
    if (generation === authGeneration) showAccess(`Could not open the questionnaire: ${error.message || 'Please try again.'}`);
  }
});

$('sign-out').addEventListener('click', async () => {
  await signOut(auth);
  location.href = './';
});

$('questionnaire-form').addEventListener('submit', async event => {
  event.preventDefault();
  const answers = readAnswers();
  const message = $('questionnaire-message');
  if (answers.some(answer => answer === null)) {
    message.className = 'message error';
    message.textContent = `Please choose or write an answer for all ${currentQuestions.length} questions before saving.`;
    return;
  }
  const button = $('save-questionnaire');
  const submittedRevision = currentRevision;
  button.disabled = true;
  message.textContent = 'Saving your answers...';
  message.className = 'message';
  try {
    await saveQuestionnaire({ answers, revision: submittedRevision, companyId });
    savedData = { version: submittedRevision ? 2 : 1, revision: submittedRevision, answers };
    message.className = 'message success';
    message.textContent = submittedRevision === currentRevision ?
      'Your answers have been saved for admin review.' :
      'Your answers were saved, but the questions changed. Please review the current questionnaire.';
  } catch (error) {
    message.className = 'message error';
    message.textContent = error.message || 'Could not save your answers. Please try again.';
  } finally {
    button.disabled = false;
  }
});
