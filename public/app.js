import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import { getFirestore, doc, collection, getDoc, setDoc, updateDoc, addDoc, writeBatch, onSnapshot, query, orderBy, serverTimestamp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const configured = firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME' && firebaseConfig.projectId !== 'REPLACE_ME' && firebaseConfig.appId !== 'REPLACE_ME';
if (!configured) {
  $('setup').hidden = false;
} else {
  start();
}

function start() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  let currentUser = null;
  let currentProfile = null;
  let isAdmin = false;
  let authMode = 'login';
  let pendingPhoto = null;
  let profileInitialized = false;
  let applicants = [];
  let selectedUid = null;
  let memberMessagesUnsub = null;
  let memberConversationUnsub = null;
  let adminMessagesUnsub = null;
  let adminConversationUnsub = null;
  let profileUnsub = null;
  let applicantsUnsub = null;
  let authGeneration = 0;

  function status(id, text, error = false) {
    const el = $(id);
    el.textContent = text;
    el.className = `message ${error ? 'error' : 'success'}`;
  }
  function showView(id) {
    for (const view of ['auth-view', 'member-view', 'admin-view']) $(view).hidden = view !== id;
  }
  function cleanSubscriptions() {
    for (const unsub of [memberMessagesUnsub, memberConversationUnsub, adminMessagesUnsub, adminConversationUnsub, profileUnsub, applicantsUnsub]) if (unsub) unsub();
    memberMessagesUnsub = memberConversationUnsub = adminMessagesUnsub = adminConversationUnsub = profileUnsub = applicantsUnsub = null;
  }
  function setAuthMode(mode) {
    authMode = mode;
    $('login-tab').classList.toggle('active', mode === 'login');
    $('signup-tab').classList.toggle('active', mode === 'signup');
    $('login-tab').setAttribute('aria-selected', String(mode === 'login'));
    $('signup-tab').setAttribute('aria-selected', String(mode === 'signup'));
    $('auth-heading').textContent = mode === 'login' ? 'Welcome back' : 'Create your account';
    $('auth-description').textContent = mode === 'login' ? 'Sign in to update your introduction or read messages.' : 'Your introduction will be private to you and the admins.';
    $('auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
    $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('reset-password').hidden = mode !== 'login';
    status('auth-message', '');
  }
  $('login-tab').addEventListener('click', () => setAuthMode('login'));
  $('signup-tab').addEventListener('click', () => setAuthMode('signup'));
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const button = $('auth-submit');
    button.disabled = true;
    status('auth-message', '');
    try {
      if (authMode === 'signup') await createUserWithEmailAndPassword(auth, email, password);
      else await signInWithEmailAndPassword(auth, email, password);
      $('auth-form').reset();
    } catch (error) {
      status('auth-message', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  $('reset-password').addEventListener('click', async () => {
    const email = $('auth-email').value.trim();
    if (!email) return status('auth-message', 'Enter your email address first.', true);
    try {
      await sendPasswordResetEmail(auth, email);
      status('auth-message', 'If this email has an account, a reset link is on its way.');
    } catch (error) {
      status('auth-message', readableError(error), true);
    }
  });
  $('sign-out').addEventListener('click', () => signOut(auth));

  onAuthStateChanged(auth, async user => {
    const generation = ++authGeneration;
    cleanSubscriptions();
    currentUser = user;
    currentProfile = null;
    profileInitialized = false;
    pendingPhoto = null;
    applicants = [];
    selectedUid = null;
    $('sign-out').hidden = !user;
    $('account-email').hidden = !user;
    $('account-email').textContent = user?.email || '';
    if (!user) return showView('auth-view');
    try {
      isAdmin = (await getDoc(doc(db, 'admins', user.uid))).exists();
      if (generation !== authGeneration) return;
      if (isAdmin) {
        showView('admin-view');
        watchApplicants();
      } else {
        showView('member-view');
        watchProfile(user.uid);
        watchMemberConversation(user.uid);
      }
    } catch (error) {
      showView('auth-view');
      status('auth-message', `Could not load your account: ${readableError(error)}`, true);
    }
  });

  function renderPhoto(src) {
    $('photo-preview').hidden = !src;
    $('photo-placeholder').hidden = Boolean(src);
    $('remove-photo').hidden = !src;
    if (src) $('photo-preview').src = src;
    else $('photo-preview').removeAttribute('src');
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
        renderPhoto(profile?.photoDataUrl || '');
        updateWordCount();
        profileInitialized = true;
      }
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
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      pendingPhoto = await preparePhoto(file);
      renderPhoto(pendingPhoto);
      status('profile-message', 'Photo ready. Save your introduction to keep it.');
    } catch (error) {
      status('profile-message', error.message, true);
      event.target.value = '';
    }
  });
  $('remove-photo').addEventListener('click', () => {
    pendingPhoto = '';
    $('profile-photo').value = '';
    renderPhoto('');
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
    const data = {
      profile: { name, location }, bio,
      photoDataUrl: pendingPhoto === null ? (currentProfile?.photoDataUrl || '') : pendingPhoto,
      status: 'submitted', updatedAt: serverTimestamp()
    };
    try {
      if (currentProfile) await updateDoc(doc(db, 'users', currentUser.uid), data);
      else await setDoc(doc(db, 'users', currentUser.uid), { ...data, email: currentUser.email, createdAt: serverTimestamp() });
      pendingPhoto = null;
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
      await addDoc(collection(db, 'conversations', currentUser.uid, 'messages'), messageData(currentUser.uid, 'member', text));
      $('member-message').value = '';
      status('member-message-status', 'Reply sent.');
    } catch (error) {
      status('member-message-status', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function watchApplicants() {
    applicantsUnsub = onSnapshot(collection(db, 'users'), snapshot => {
      applicants = snapshot.docs.map(item => ({ uid: item.id, ...item.data() })).sort((a, b) => (a.profile?.name || '').localeCompare(b.profile?.name || ''));
      $('applicant-count').textContent = String(applicants.length);
      renderApplicantList();
      if (selectedUid) {
        const selected = applicants.find(person => person.uid === selectedUid);
        if (selected) renderApplicantDetail(selected);
      }
    }, error => {
      $('applicant-empty').hidden = false;
      $('applicant-empty').textContent = readableError(error);
    });
  }
  function renderApplicantList() {
    const term = $('applicant-search').value.trim().toLowerCase();
    const shown = applicants.filter(person => [person.profile?.name, person.profile?.location, person.email].some(value => (value || '').toLowerCase().includes(term)));
    $('applicant-empty').hidden = shown.length > 0;
    $('applicant-empty').textContent = applicants.length ? 'No matching profiles.' : 'No profiles submitted yet.';
    const list = $('applicant-list');
    list.replaceChildren();
    for (const person of shown) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `applicant-row ${person.uid === selectedUid ? 'selected' : ''}`;
      const name = document.createElement('strong');
      name.textContent = person.profile?.name || 'Unnamed';
      const meta = document.createElement('span');
      meta.textContent = `${person.email || ''} · ${statusLabel(person.status)}`;
      button.append(name, meta);
      button.addEventListener('click', () => selectApplicant(person.uid));
      list.append(button);
    }
  }
  function selectApplicant(uid) {
    if (selectedUid !== uid) {
      if (adminMessagesUnsub) adminMessagesUnsub();
      if (adminConversationUnsub) adminConversationUnsub();
      adminMessagesUnsub = adminConversationUnsub = null;
      selectedUid = uid;
      $('admin-messages').replaceChildren();
      watchAdminConversation(uid);
    }
    renderApplicantList();
    const person = applicants.find(item => item.uid === uid);
    if (person) renderApplicantDetail(person);
  }
  function renderApplicantDetail(person) {
    $('admin-detail-empty').hidden = true;
    $('admin-detail').hidden = false;
    $('detail-name').textContent = person.profile?.name || 'Unnamed';
    $('detail-status').textContent = statusLabel(person.status);
    $('detail-email').textContent = person.email || '';
    $('detail-location').textContent = person.profile?.location ? `Location: ${person.profile.location}` : 'Location not provided';
    $('detail-bio').textContent = person.bio || 'No introduction yet.';
    $('detail-photo').hidden = !person.photoDataUrl;
    if (person.photoDataUrl) $('detail-photo').src = person.photoDataUrl;
    else $('detail-photo').removeAttribute('src');
    $('review-status').value = person.status || 'submitted';
    status('review-message', '');
  }
  $('applicant-search').addEventListener('input', renderApplicantList);
  $('save-review').addEventListener('click', async () => {
    if (!selectedUid) return;
    const button = $('save-review');
    button.disabled = true;
    try {
      await updateDoc(doc(db, 'users', selectedUid), { status: $('review-status').value, reviewedAt: serverTimestamp() });
      status('review-message', 'Review status saved.');
    } catch (error) {
      status('review-message', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  function watchAdminConversation(uid) {
    adminConversationUnsub = onSnapshot(doc(db, 'conversations', uid), snapshot => {
      const opened = snapshot.exists();
      $('admin-chat-empty').hidden = opened;
      if (opened && !adminMessagesUnsub) {
        adminMessagesUnsub = onSnapshot(query(collection(db, 'conversations', uid, 'messages'), orderBy('createdAt', 'asc')), messages => renderMessages('admin-messages', messages, currentUser.uid), error => status('admin-message-status', readableError(error), true));
      }
    }, error => status('admin-message-status', readableError(error), true));
  }
  $('admin-message-form').addEventListener('submit', async event => {
    event.preventDefault();
    const uid = selectedUid;
    const text = $('admin-message').value.trim();
    if (!uid || !text || !currentUser) return;
    const button = $('admin-send');
    button.disabled = true;
    try {
      const conversation = doc(db, 'conversations', uid);
      const exists = (await getDoc(conversation)).exists();
      if (exists) {
        await addDoc(collection(conversation, 'messages'), messageData(currentUser.uid, 'admin', text));
      } else {
        const batch = writeBatch(db);
        const firstMessage = doc(collection(conversation, 'messages'));
        batch.set(conversation, { participantUid: uid, openedBy: currentUser.uid, openedAt: serverTimestamp(), firstMessageId: firstMessage.id });
        batch.set(firstMessage, messageData(currentUser.uid, 'admin', text));
        await batch.commit();
      }
      $('admin-message').value = '';
      status('admin-message-status', 'Message sent.');
    } catch (error) {
      status('admin-message-status', readableError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function messageData(senderUid, senderRole, text) {
    return { senderUid, senderRole, text, createdAt: serverTimestamp() };
  }
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
      'auth/invalid-credential': 'Email or password is incorrect.',
      'auth/email-already-in-use': 'That email already has an account.',
      'auth/weak-password': 'Choose a stronger password.',
      'auth/invalid-email': 'Enter a valid email address.',
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
