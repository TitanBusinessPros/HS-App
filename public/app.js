import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, onSnapshot, query, orderBy } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app-check.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-functions.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';

const $ = id => document.getElementById(id);
const configured = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME' && firebaseConfig.projectId !== 'REPLACE_ME' && firebaseConfig.appId !== 'REPLACE_ME' && appCheckSiteKey && appCheckSiteKey !== 'REPLACE_ME';
if (!configured) {
  $('setup').hidden = false;
} else {
  start();
}

function start() {
  const app = initializeApp(firebaseConfig);
  initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey), isTokenAutoRefreshEnabled: true });
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, 'us-west2');
  const saveProfileCall = httpsCallable(functions, 'saveProfile');
  const sendMessageCall = httpsCallable(functions, 'sendMessage');
  let currentUser = null;
  let currentProfile = null;
  let isAdmin = false;
  let pendingPhotos = null;
  let profileInitialized = false;
  let memberMessagesUnsub = null;
  let memberConversationUnsub = null;
  let profileUnsub = null;
  let questionnaireUnsub = null;
  let skillsUnsub = null;
  let authGeneration = 0;
  const photoPreview = document.createElement('img');
  photoPreview.className = 'photo-hover-preview';
  photoPreview.alt = '';
  photoPreview.hidden = true;
  document.body.append(photoPreview);

  function hidePhotoPreview() {
    photoPreview.hidden = true;
    photoPreview.removeAttribute('src');
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
    img.addEventListener('mouseleave', hidePhotoPreview);
    img.addEventListener('focus', () => {
      const rect = img.getBoundingClientRect();
      photoPreview.src = img.src;
      photoPreview.hidden = false;
      positionPhotoPreview(rect.right, rect.top);
    });
    img.addEventListener('blur', hidePhotoPreview);
  }
  window.addEventListener('scroll', hidePhotoPreview, { passive: true });
  window.addEventListener('resize', hidePhotoPreview);

  function status(id, text, error = false) {
    const el = $(id);
    el.textContent = text;
    el.className = `message ${error ? 'error' : 'success'}`;
  }
  function showView(id) {
    for (const view of ['auth-view', 'member-view', 'admin-view']) $(view).hidden = view !== id;
  }
  function cleanSubscriptions() {
    for (const unsub of [memberMessagesUnsub, memberConversationUnsub, profileUnsub, questionnaireUnsub, skillsUnsub]) if (unsub) unsub();
    memberMessagesUnsub = memberConversationUnsub = profileUnsub = questionnaireUnsub = skillsUnsub = null;
  }
  $('google-sign-in').addEventListener('click', async () => {
    const button = $('google-sign-in');
    button.disabled = true;
    status('auth-message', '');
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      status('auth-message', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  $('sign-out').addEventListener('click', () => signOut(auth));

  onAuthStateChanged(auth, async user => {
    const generation = ++authGeneration;
    cleanSubscriptions();
    currentUser = user;
    currentProfile = null;
    profileInitialized = false;
    pendingPhotos = null;
    $('sign-out').hidden = !user;
    $('account-email').hidden = !user;
    $('account-email').textContent = user?.email || '';
    if (!user) return showView('auth-view');
    try {
      const token = await user.getIdTokenResult();
      if (token.claims.firebase?.sign_in_provider !== 'google.com') {
        await signOut(auth);
        status('auth-message', 'Please sign in with Google.');
        return;
      }
      if ((await getDoc(doc(db, 'blockedUsers', user.uid))).exists()) {
        await signOut(auth);
        status('auth-message', 'This account has been blocked.', true);
        return;
      }
      isAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists();
      if (generation !== authGeneration) return;
      if (isAdmin) {
        showView('admin-view');
      } else {
        showView('member-view');
        watchProfile(user.uid);
        questionnaireUnsub = onSnapshot(doc(db, 'questionnaires', user.uid), snapshot => {
          $('questionnaire-status').textContent = snapshot.exists() ? 'Completed. You can update your answers.' : 'Not completed yet.';
        }, error => status('profile-message', readableError(error), true));
        skillsUnsub = onSnapshot(doc(db, 'skills', user.uid), snapshot => {
          const count = snapshot.exists() ? (snapshot.data().entries || []).length : 0;
          $('skills-status').textContent = count ? `${count} skills saved. You can update them.` : 'No skills added yet.';
        }, error => status('profile-message', readableError(error), true));
        watchMemberConversation(user.uid);
      }
    } catch (error) {
      showView('auth-view');
      status('auth-message', `Could not load your account: ${readableError(error)}`, true);
    }
  });

  function savedPhotos() {
    return currentProfile?.photos || (currentProfile?.photoDataUrl ? [currentProfile.photoDataUrl] : []);
  }
  function photosCanChange() {
    const changedAt = currentProfile?.photoChangedAt?.toDate?.();
    return !savedPhotos().length || !changedAt || Date.now() - changedAt.getTime() >= 30 * 24 * 60 * 60 * 1000;
  }
  function renderPhotos() {
    const photos = pendingPhotos === null ? savedPhotos() : pendingPhotos;
    const canChange = photosCanChange();
    const list = $('photo-list');
    hidePhotoPreview();
    list.replaceChildren();
    for (const [index, src] of photos.entries()) {
      const item = document.createElement('div');
      item.className = 'photo-item';
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Profile photo ${index + 1}`;
      attachPhotoPreview(img);
      item.append(img);
      if (canChange) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          pendingPhotos = [...photos];
          pendingPhotos.splice(index, 1);
          renderPhotos();
        });
        item.append(remove);
      }
      list.append(item);
    }
    $('profile-photo').disabled = !canChange || photos.length >= 3;
    $('photo-help').textContent = canChange
      ? `${photos.length} of 3 photos. You can change the set once every 30 days. JPG, PNG, or WebP.`
      : `Photos can be changed again ${new Date(currentProfile.photoChangedAt.toDate().getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}.`;
  }
  function watchProfile(uid) {
    profileUnsub = onSnapshot(doc(db, 'users', uid), snapshot => {
      currentProfile = snapshot.exists() ? snapshot.data() : null;
      const profile = currentProfile;
      $('profile-status').textContent = statusLabel(profile?.status || 'none');
      if (!profileInitialized) {
        $('profile-name').value = profile?.profile?.name || '';
        $('profile-location').value = profile?.profile?.location || '';
        $('profile-bio').value = profile?.bio || '';
        updateWordCount();
        profileInitialized = true;
      }
      if (pendingPhotos === null) renderPhotos();
    }, error => status('profile-message', readableError(error), true));
  }
  function updateWordCount() {
    const count = $('profile-bio').value.trim().split(/\s+/).filter(Boolean).length;
    $('word-count').textContent = `${count} / 500 words`;
    $('word-count').style.color = count > 500 ? '#a33d2f' : '';
    return count;
  }
  $('profile-bio').addEventListener('input', updateWordCount);
  $('profile-photo').addEventListener('change', async event => {
    const files = [...(event.target.files || [])];
    if (!files.length) return;
    try {
      const current = pendingPhotos === null ? savedPhotos() : pendingPhotos;
      if (!photosCanChange() || current.length + files.length > 3) throw new Error('You can keep no more than three photos.');
      const prepared = await Promise.all(files.map(preparePhoto));
      pendingPhotos = [...current, ...prepared];
      renderPhotos();
      status('profile-message', 'Photos ready. Save your introduction to keep them.');
    } catch (error) {
      status('profile-message', error.message, true);
    }
    event.target.value = '';
  });
  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const name = $('profile-name').value.trim();
    const location = $('profile-location').value.trim();
    const bio = $('profile-bio').value.trim();
    if (!name || !bio) return status('profile-message', 'Add a name and introduction.', true);
    if (updateWordCount() > 500) return status('profile-message', 'Keep your introduction within 500 words.', true);
    const button = $('save-profile');
    button.disabled = true;
    const data = { profile: { name, location }, bio, photos: pendingPhotos === null ? savedPhotos() : pendingPhotos };
    try {
      await saveProfileCall(data);
      pendingPhotos = null;
      renderPhotos();
      status('profile-message', 'Your introduction has been saved for admin review.');
    } catch (error) {
      status('profile-message', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function watchMemberConversation(uid) {
    memberConversationUnsub = onSnapshot(doc(db, 'conversations', uid), snapshot => {
      const opened = snapshot.exists();
      $('inbox-empty').hidden = opened;
      $('member-chat').hidden = !opened;
      if (opened && !memberMessagesUnsub) {
        memberMessagesUnsub = onSnapshot(query(collection(db, 'conversations', uid, 'messages'), orderBy('createdAt', 'asc')), messages => renderMessages('member-messages', messages, uid), error => status('member-message-status', readableError(error), true));
      }
    }, error => status('member-message-status', readableError(error), true));
  }
  $('member-message-form').addEventListener('submit', async event => {
    event.preventDefault();
    const text = $('member-message').value.trim();
    if (!text || !currentUser) return;
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      await sendMessageCall({ targetUid: currentUser.uid, text });
      $('member-message').value = '';
      status('member-message-status', 'Reply sent.');
    } catch (error) {
      status('member-message-status', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function renderMessages(id, snapshot, myUid) {
    const container = $(id);
    container.replaceChildren();
    snapshot.forEach(item => {
      const message = item.data();
      const bubble = document.createElement('div');
      bubble.className = `bubble ${message.senderUid === myUid ? 'mine' : ''}`;
      const meta = document.createElement('div');
      meta.className = 'bubble-meta';
      const date = message.createdAt?.toDate?.();
      meta.textContent = `${message.senderRole === 'admin' ? 'Admin' : 'Applicant'}${date ? ` · ${date.toLocaleString()}` : ''}`;
      const body = document.createElement('div');
      body.textContent = message.text;
      bubble.append(meta, body);
      container.append(bubble);
    });
    container.scrollTop = container.scrollHeight;
  }
  function statusLabel(value) {
    return ({ submitted: 'Submitted', reviewing: 'Reviewing', 'good-fit': 'Good fit', declined: 'Declined', none: 'Not submitted' })[value] || 'Submitted';
  }
  function readableError(error) {
    const map = {
      'auth/popup-closed-by-user': 'Google sign-in was canceled.',
      'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow popups and try again.',
      'auth/unauthorized-domain': 'This website must be added to Firebase Authentication authorized domains.',
      'auth/operation-not-allowed': 'Google sign-in must be enabled in Firebase Authentication.',
      'auth/account-exists-with-different-credential': 'This email has an account using another sign-in method. Contact an admin for help.',
      'permission-denied': 'Access was denied. Check the Firebase rules and admin setup.'
    };
    return map[error.code] || error.message || 'Something went wrong. Please try again.';
  }
}

async function preparePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a photo smaller than 5 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const result = canvas.toDataURL('image/jpeg', 0.72);
  if (result.length > 200000) throw new Error('This photo is too detailed. Choose a smaller image.');
  return result;
}
