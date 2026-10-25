import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { questions } from './questions.js';
import { requestedCompany, companySegments, companyLink, questionnaireAvailable } from './company-context.js';
import { readQuestionnaireAnswers, renderQuestionnaireQuestions } from './questionnaire-form.js';

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
let currentConfig = null;
let savedData = null;
let configUnsub = null;
let authGeneration = 0;

function showAccess(message) {
  $('loading').hidden = true;
  $('questionnaire-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function readAnswers() { return readQuestionnaireAnswers($('questionnaire-form'), currentQuestions); }

function updateProgress() {
  const count = readAnswers().filter(answer => answer !== null).length;
  $('questionnaire-progress').textContent = `${count} of ${currentQuestions.length} answered`;
}

function renderQuestions(savedAnswers = []) {
  renderQuestionnaireQuestions($('questions-list'), currentQuestions, savedAnswers, updateProgress);
}

onAuthStateChanged(auth, async user => {
  const generation = ++authGeneration;
  if (configUnsub) configUnsub();
  configUnsub = null;
  savedData = null;
  currentQuestions = questions;
  currentRevision = 0;
  currentConfig = null;
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
      if (!questionnaireAvailable(companyId, config)) return showAccess('This homestead does not have a questionnaire available.');
      currentConfig = config || null;
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
    savedData = { version: currentConfig ? 2 : 1, revision: submittedRevision, answers };
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
