import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const projectId = 'demo-homesteader';
const app = initializeApp({ projectId });
const db = getFirestore(app);
const companyA = 'aaaaaaaaaaaaaaaaaaaa';
const companyB = 'bbbbbbbbbbbbbbbbbbbb';

function token(uid) {
  const payload = {
    aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
    sub: uid, user_id: uid, auth_time: 1700000000,
    email: `${uid}@example.com`, firebase: { sign_in_provider: 'google.com' }
  };
  return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;
}

async function request(uid, path, method = 'GET') {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  assert.ok(host, 'Firestore emulator must be running');
  const response = await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents/${path}`, {
    method, headers: { Authorization: `Bearer ${token(uid)}`,
      ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'PATCH' ? { body: JSON.stringify({ fields: { leaked: { booleanValue: true } } }) } : {})
  });
  return response;
}

await Promise.all([
  db.doc('admins/titanAdmin').set({ email: 'titanbusinesspros@gmail.com' }),
  db.doc('admins/adminA').set({ companyId: companyA, role: 'admin' }),
  db.doc('admins/adminB').set({ companyId: companyB, role: 'owner' }),
  db.doc('users/applicant').set({ profile: { name: 'Applicant' }, status: 'reviewing' }),
  db.doc('applicantDirectory/applicant').set({ name: 'Applicant' }),
  db.doc('questionnaires/applicant').set({ answers: [1] }),
  db.doc(`companies/${companyA}`).set({ active: true, ownerUid: 'adminA' }),
  db.doc(`companies/${companyB}`).set({ active: true, ownerUid: 'adminB' }),
  db.doc(`companies/${companyA}/questionnaires/applicant`).set({ answers: [2] }),
  db.doc(`companies/${companyB}/questionnaires/applicant`).set({ answers: [3] }),
  db.doc(`companies/${companyA}/conversations/applicant/messages/a`).set({ text: 'A private message' }),
  db.doc(`companies/${companyB}/conversations/applicant/messages/b`).set({ text: 'B private message' })
]);

const discoveryIds = Array.from({ length: 10 }, (_, index) => `homestead${String(index).padStart(11, '0')}`);
await Promise.all(discoveryIds.flatMap((id, index) => [
  db.doc(`companyListings/${id}`).set({ name: `Homestead ${index}`, active: true }),
  db.doc(`companies/${id}/homesteadPage/main`).set({ name: `Homestead ${index}`, published: true })
]));

const cases = [
  ['adminA', 'applicantDirectory/applicant', 200],
  ['adminB', 'applicantDirectory/applicant', 200],
  ['applicant', 'applicantDirectory/applicant', 403],
  ['titanAdmin', 'users/applicant', 200],
  ['adminA', 'users/applicant', 403],
  ['adminB', 'users/applicant', 403],
  ['adminA', 'questionnaires/applicant', 403],
  ['adminA', `companies/${companyA}/questionnaires/applicant`, 200],
  ['adminA', `companies/${companyB}/questionnaires/applicant`, 403],
  ['adminB', `companies/${companyB}/questionnaires/applicant`, 200],
  ['adminB', `companies/${companyA}/questionnaires/applicant`, 403],
  ['adminA', `companies/${companyA}/conversations/applicant/messages/a`, 200],
  ['adminA', `companies/${companyB}/conversations/applicant/messages/b`, 403],
  ['adminB', `companies/${companyA}/conversations/applicant/messages/a`, 403],
  ['applicant', `companies/${companyA}/questionnaires/applicant`, 200],
  ['outsider', `companies/${companyA}/questionnaires/applicant`, 403],
  ['adminA', `companies/${companyA}/questionnaires/applicant`, 403, 'PATCH']
];

for (const [uid, path, expected, method] of cases) {
  const actual = (await request(uid, path, method)).status;
  assert.equal(actual, expected, `${uid} ${method || 'GET'} ${path}: expected ${expected}, got ${actual}`);
}

for (const uid of ['applicant', 'futureApplicant']) {
  const response = await request(uid, 'companyListings');
  assert.equal(response.status, 200, `${uid} can list homesteads`);
  const body = await response.json();
  assert.equal(body.documents?.length, 10, `${uid} sees every homestead listing`);
  for (const id of discoveryIds) {
    assert.equal((await request(uid, `companies/${id}/homesteadPage/main`)).status, 200,
      `${uid} can read ${id}'s published page`);
  }
}

console.log(`${cases.length} tenant isolation checks and 10 homestead discovery checks passed`);
