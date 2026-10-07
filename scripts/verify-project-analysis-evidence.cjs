require('reflect-metadata');
const assert = require('node:assert/strict');
const { validateProjectAssignmentEvidence } = require('../dist/modules/ai/project-assignment.schema.js');

const assigned = (evidence, text='Thanks') => ({
  schema_version: '1', outcome: 'assigned', project_id: 'project-de', project_ids: ['project-de'],
  confidence: 0.95, evidence, reason: 'The current mail confirms the project decision.',
});

const noParent = new Map([['current', 'Thanks.']]);
const currentAckEvidence = [{ source_message_id: 'current', excerpt: 'Thanks.' }];
assert.ok(validateProjectAssignmentEvidence(assigned(currentAckEvidence), { currentMessageId: 'current', candidateProjectIds: ['project-de'], messageTextById: noParent }).includes('PROJECT_ACK_PARENT_EVIDENCE_REQUIRED'),
  'a short ACK cannot be assigned from its own “Thanks” evidence');

const withParent = new Map([
  ['current', 'Thanks.'],
  ['parent', 'We confirm the Germany booth design and the quoted frame dimensions.'],
]);
assert.deepEqual(validateProjectAssignmentEvidence(assigned([
  ...currentAckEvidence,
  { source_message_id: 'parent', excerpt: 'We confirm the Germany booth design' },
]), { currentMessageId: 'current', candidateProjectIds: ['project-de'], messageTextById: withParent }), [],
  'an ACK may be classified only when real parent context provides verified project evidence');

assert.ok(validateProjectAssignmentEvidence(assigned(currentAckEvidence), { currentMessageId: 'current', candidateProjectIds: ['project-de'], messageTextById: withParent }).includes('PROJECT_ACK_PARENT_EVIDENCE_REQUIRED'),
  'current-message evidence must not bypass the parent requirement for acknowledgements');

const futureOpportunity = {
  schema_version: '1', outcome: 'new_opportunity', project_id: null, project_ids: [], confidence: 0.96,
  evidence: [{ source_message_id: 'current', excerpt: 'For the 2027 exhibition we would like to start a new cooperation.' }],
  reason: 'The email proposes a separate future-year cooperation.',
};
assert.deepEqual(validateProjectAssignmentEvidence(futureOpportunity, {
  currentMessageId: 'current', candidateProjectIds: ['project-de'],
  messageTextById: new Map([['current', 'For the 2027 exhibition we would like to start a new cooperation.']]),
}), [], 'future cooperation must remain an opportunity rather than being forced into the prior project');

const mixed = {
  schema_version: '1', outcome: 'multi_project', project_id: null, project_ids: ['project-de', 'project-us'], confidence: 0.91,
  evidence: [{ source_message_id: 'current', excerpt: 'Germany and USA booths both need final lighting plans.' }],
  reason: 'The current email substantively covers two projects.',
};
assert.deepEqual(validateProjectAssignmentEvidence(mixed, {
  currentMessageId: 'current', candidateProjectIds: ['project-de', 'project-us'],
  messageTextById: new Map([['current', 'Germany and USA booths both need final lighting plans.']]),
}), [], 'multiple real projects remain unresolved instead of selecting an arbitrary primary project');

assert.ok(validateProjectAssignmentEvidence({ ...futureOpportunity, evidence: [{ source_message_id: 'parent', excerpt: 'For the 2027 exhibition' }] }, {
  currentMessageId: 'current', candidateProjectIds: ['project-de'],
  messageTextById: new Map([['current', 'For the 2027 exhibition we would like to start a new cooperation.'], ['parent', 'For the 2027 exhibition we would like to start a new cooperation.']]),
}).includes('PROJECT_CURRENT_EVIDENCE_REQUIRED'), 'old-thread evidence cannot stand in for current content');

console.log('project-analysis evidence regressions passed');
