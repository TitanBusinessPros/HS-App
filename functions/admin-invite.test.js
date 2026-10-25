import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAdminEmail, verifiedGoogleEmail } from './admin-invite.js';

test('admin email is normalized and malformed addresses are rejected', () => {
  assert.equal(normalizeAdminEmail('  Admin.Example@Gmail.com  '), 'admin.example@gmail.com');
  for (const value of ['admin', 'admin@', 'admin@example', 'admin@example.com/other', 'a b@example.com', '']) {
    assert.equal(normalizeAdminEmail(value), '');
  }
});

test('claim requires a verified matching Google account', () => {
  const user = { token: { email: 'Admin.Example@Gmail.com', email_verified: true,
    firebase: { sign_in_provider: 'google.com' } } };
  const account = { email: 'admin.example@gmail.com', emailVerified: true,
    providerData: [{ providerId: 'google.com', email: 'admin.example@gmail.com' }] };
  assert.equal(verifiedGoogleEmail(user, account), 'admin.example@gmail.com');
  assert.equal(verifiedGoogleEmail({ token: { ...user.token, email_verified: false } }, account), '');
  assert.equal(verifiedGoogleEmail({ token: { ...user.token, firebase: { sign_in_provider: 'password' } } }, account), '');
  assert.equal(verifiedGoogleEmail(user, { ...account, email: 'other@gmail.com' }), '');
  assert.equal(verifiedGoogleEmail(user, { ...account, emailVerified: false }), '');
  assert.equal(verifiedGoogleEmail(user, { ...account, providerData: [] }), '');
});
