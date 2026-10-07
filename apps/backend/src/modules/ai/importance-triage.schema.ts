export const IMPORTANCE_TRIAGE_SCHEMA_VERSION = '1';

export const IMPORTANCE_TRIAGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'importance', 'intent', 'confidence', 'reason', 'evidence', 'review_required'],
  properties: {
    schema_version: { type: 'string', enum: [IMPORTANCE_TRIAGE_SCHEMA_VERSION] },
    importance: { type: 'string', enum: ['low', 'normal', 'high', 'urgent', 'uncertain'] },
    intent: { type: 'string', enum: ['customer_inquiry', 'materials_request', 'reply_request', 'important_change', 'deadline', 'routine', 'non_actionable', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 4, maxLength: 500 },
    evidence: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', minLength: 4, maxLength: 300 } },
    review_required: { type: 'boolean' },
  },
} as const;

export type ImportanceTriageResult = {
  schema_version: typeof IMPORTANCE_TRIAGE_SCHEMA_VERSION;
  importance: 'low' | 'normal' | 'high' | 'urgent' | 'uncertain';
  intent: 'customer_inquiry' | 'materials_request' | 'reply_request' | 'important_change' | 'deadline' | 'routine' | 'non_actionable' | 'uncertain';
  confidence: number;
  reason: string;
  evidence: string[];
  review_required: boolean;
};
