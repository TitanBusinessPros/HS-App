import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { questions } from './questions.js';

const $ = id => document.getElementById(id);
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
const auth = getAuth(app);
const db = getFirestore(app);
const saveQuestionnaire = httpsCallable(getFunctions(app, 'us-west2'), 'saveQuestionnaire');

function showAccess(message) {
  $('loading').hidden = true;
  $('questionnaire-view').hidden = true;
  $('access-text').textContent = message;
  $('access-message').hidden = false;
}

function updateProgress() {
  const count = questions.filter((_, index) => document.querySelector(`input[name="answer-${index}"]:checked`)).length;
  $('questionnaire-progress').textContent = `${count} of ${questions.length} answered`;
}

function renderQuestions(savedAnswers = []) {
  const list = $('questions-list');
  list.replaceChildren();
  let currentSection = '';
  questions.forEach((question, index) => {
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
    question.choices.forEach((choice, choiceIndex) => {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `answer-${index}`;
      input.value = String(choiceIndex);
      input.checked = savedAnswers[index] === choiceIndex;
      input.addEventListener('change', updateProgress);
      const span = document.createElement('span');
      span.textContent = choice;
      label.append(input, span);
      fieldset.append(label);
    });
    list.append(fieldset);
  });
  updateProgress();
}

onAuthStateChanged(auth, async user => {
  $('account-email').textContent = user?.email || '';
  $('sign-out').hidden = !user;
  if (!user) return showAccess('Open Homesteader and sign in with Google to take the questionnaire.');
  try {
    const token = await user.getIdTokenResult();
    if (token.claims.firebase?.sign_in_provider !== 'google.com') return showAccess('Sign in with Google to continue.');
    if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) return showAccess('This account cannot use Homesteader.');
    if ((await getDoc(doc(db, 'admins', user.uid))).exists()) return showAccess('Admins do not need an applicant questionnaire.');
    if (!(await getDoc(doc(db, 'users', user.uid))).exists()) return showAccess('Save your applicant profile first, then return to the questionnaire.');
    const saved = await getDoc(doc(db, 'questionnaires', user.uid));
    renderQuestions(saved.exists() && saved.data().version === 1 ? saved.data().answers : []);
    $('loading').hidden = true;
    $('access-message').hidden = true;
    $('questionnaire-view').hidden = false;
  } catch (error) {
    showAccess(`Could not open the questionnaire: ${error.message || 'Please try again.'}`);
  }
});

$('sign-out').addEventListener('click', async () => {
  await signOut(auth);
  location.href = './';
});

$('questionnaire-form').addEventListener('submit', async event => {
  event.preventDefault();
  const answers = questions.map((_, index) => {
    const selected = document.querySelector(`input[name="answer-${index}"]:checked`);
    return selected ? Number(selected.value) : null;
  });
  const message = $('questionnaire-message');
  if (answers.some(answer => answer === null)) {
    message.className = 'message error';
    message.textContent = 'Please answer all 30 questions before saving.';
    return;
  }
  const button = $('save-questionnaire');
  button.disabled = true;
  message.textContent = 'Saving your answers...';
  message.className = 'message';
  try {
    await saveQuestionnaire({ answers });
    message.className = 'message success';
    message.textContent = 'Your answers have been saved for admin review.';
  } catch (error) {
    message.className = 'message error';
    message.textContent = error.message || 'Could not save your answers. Please try again.';
  } finally {
    button.disabled = false;
  }
});
