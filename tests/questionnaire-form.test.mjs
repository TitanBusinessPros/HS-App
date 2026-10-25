import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuestionnaireAnswers } from '../public/questionnaire-form.js';

test('shared questionnaire form reads preset, written, and unanswered responses', () => {
  const inputs = new Map([
    ['#written-answer-0', { value: '' }],
    ['input[name="answer-0"]:checked', { value: '1' }],
    ['#written-answer-1', { value: '  I can help with harvests.  ' }],
    ['input[name="answer-1"]:checked', { value: 'written' }],
    ['#written-answer-2', { value: '  Available weekends  ' }]
  ]);
  const form = { querySelector: selector => inputs.get(selector) || null };
  const questions = [{ choices: ['No', 'Yes'] }, { choices: ['No', 'Yes'] },
    { choices: [] }, { choices: ['No', 'Yes'] }];
  assert.deepEqual(readQuestionnaireAnswers(form, questions), [
    1, { text: 'I can help with harvests.' }, { text: 'Available weekends' }, null
  ]);
});
