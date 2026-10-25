import test from 'node:test';
import assert from 'node:assert/strict';
import { companySegments, companyLink, requestedCompany, questionnaireAvailable } from '../public/company-context.js';

test('Titan keeps existing paths while another company uses its own subtree', () => {
  const companyId = 'aaaaaaaaaaaaaaaaaaaa';
  assert.deepEqual(companySegments('titan', 'skills', 'applicant'), ['skills', 'applicant']);
  assert.deepEqual(companySegments(companyId, 'skills', 'applicant'),
    ['companies', companyId, 'skills', 'applicant']);
  assert.equal(companyLink('skills.html', companyId), `skills.html?company=${companyId}`);
  assert.equal(companyLink('skills.html', 'titan'), 'skills.html');
});

test('an invalid company URL falls back to Titan', () => {
  globalThis.location = { search: '?company=../../users' };
  assert.equal(requestedCompany(), 'titan');
  globalThis.location = { search: '?company=aaaaaaaaaaaaaaaaaaaa' };
  assert.equal(requestedCompany(), 'aaaaaaaaaaaaaaaaaaaa');
  delete globalThis.location;
});

test('a company questionnaire appears only after its owner publishes it', () => {
  const companyId = 'aaaaaaaaaaaaaaaaaaaa';
  assert.equal(questionnaireAvailable('titan', null), true);
  assert.equal(questionnaireAvailable('titan', { enabled: false }), false);
  assert.equal(questionnaireAvailable(companyId, null), false);
  assert.equal(questionnaireAvailable(companyId, { enabled: false, questions: [{}] }), false);
  assert.equal(questionnaireAvailable(companyId, { enabled: true, questions: [{}] }), true);
});
