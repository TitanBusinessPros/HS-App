export const titanCompanyId = 'titan';

export function validCompanyId(value) {
  return value === titanCompanyId || /^[A-Za-z0-9]{20}$/.test(value || '');
}

export function requestedCompany() {
  const value = new URLSearchParams(location.search).get('company');
  return validCompanyId(value) ? value : titanCompanyId;
}

export function companySegments(companyId, ...parts) {
  return companyId === titanCompanyId ? parts : ['companies', companyId, ...parts];
}

export function companyLink(page, companyId) {
  return companyId === titanCompanyId ? page : `${page}?company=${encodeURIComponent(companyId)}`;
}
