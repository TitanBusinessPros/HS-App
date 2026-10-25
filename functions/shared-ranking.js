export function mergeSharedSkillEntries(sources, preferredCompanyId) {
  const byApplicant = new Map();
  for (const source of sources) {
    for (const entry of source.entries) {
      if (!Number.isFinite(entry.years) || entry.years < 0) continue;
      const previous = byApplicant.get(entry.uid);
      if (!previous || entry.years > previous.years ||
          (entry.years === previous.years && source.companyId === preferredCompanyId)) {
        byApplicant.set(entry.uid, {
          uid: entry.uid, years: entry.years,
          organization: entry.organization || '', sourceCompanyId: source.companyId
        });
      }
    }
  }
  return [...byApplicant.values()].sort((a, b) => b.years - a.years || a.uid.localeCompare(b.uid));
}
