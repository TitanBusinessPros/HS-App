import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSharedSkillEntries } from './shared-ranking.js';

test('shared rankings include another company and keep one best report per applicant', () => {
  const result = mergeSharedSkillEntries([
    { companyId: 'titan', entries: [
      { uid: 'one', years: 6, organization: 'Farm A' },
      { uid: 'two', years: 4, organization: 'Farm B' }
    ] },
    { companyId: 'newCompany', entries: [
      { uid: 'one', years: 3, organization: 'Farm C' },
      { uid: 'three', years: 8, organization: 'Farm D' }
    ] }
  ], 'newCompany');
  assert.deepEqual(result.map(person => [person.uid, person.years, person.sourceCompanyId]), [
    ['three', 8, 'newCompany'], ['one', 6, 'titan'], ['two', 4, 'titan']
  ]);
});

test('equal reports prefer the company being reviewed', () => {
  const result = mergeSharedSkillEntries([
    { companyId: 'titan', entries: [{ uid: 'one', years: 5, organization: 'Old' }] },
    { companyId: 'newCompany', entries: [{ uid: 'one', years: 5, organization: 'Current' }] }
  ], 'newCompany');
  assert.equal(result[0].organization, 'Current');
});
