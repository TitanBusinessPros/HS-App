import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillCatalog, skills } from '../public/skills.js';

test('deleted built-in and custom skills leave the active catalog', () => {
  const customId = 'custom_0123456789abcdef0123456789abcdef';
  const activeId = 'custom_fedcba9876543210fedcba9876543210';
  const catalog = buildSkillCatalog([
    { id: '0', deleted: true },
    { id: customId, name: 'Retired Skill', category: 'Poultry', deleted: true },
    { id: activeId, name: 'Active Skill', category: 'Poultry' }
  ]);
  assert.equal(catalog.byId.has('0'), false);
  assert.equal(catalog.byId.has(customId), false);
  assert.equal(catalog.byId.get(activeId)?.name, 'Active Skill');
  assert.equal(catalog.skills.length, skills.length);
});
