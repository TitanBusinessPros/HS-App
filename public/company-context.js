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

export function questionnaireAvailable(companyId, config) {
  if (config?.enabled === false) return false;
  if (companyId === titanCompanyId && !config) return true;
  return config?.enabled === true && Array.isArray(config.questions) && config.questions.length > 0;
}
