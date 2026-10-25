export function normalizeAdminEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@/<>]+@[^\s@/<>]+\.[^\s@/<>]+$/.test(email) ? email : '';
}

export function verifiedGoogleEmail(user, account) {
  const email = normalizeAdminEmail(user?.token?.email);
  return email && user.token.firebase?.sign_in_provider === 'google.com' &&
    user.token.email_verified === true && account?.emailVerified === true &&
    normalizeAdminEmail(account.email) === email &&
    account.providerData?.some(provider => provider.providerId === 'google.com' &&
      normalizeAdminEmail(provider.email) === email) ? email : '';
}
