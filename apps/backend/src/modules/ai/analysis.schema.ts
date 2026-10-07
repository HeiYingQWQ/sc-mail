const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableEnum = (values: string[]) => ({ anyOf: [{ type: 'string', enum: values }, { type: 'null' }] });

const changeFields = {
  title: nullableString,
  description: nullableString,
  kind: nullableEnum(['action', 'reply', 'confirmation']),
  owner_type: nullableEnum(['us', 'customer', 'third_party']),
  owner_id: nullableString,
  waiting_on: nullableEnum(['us', 'customer', 'third_party', 'mixed', 'none']),
  status: nullableEnum(['open', 'in_progress', 'waiting', 'done', 'cancelled', 'proposed', 'accepted', 'rejected']),
  priority: nullableEnum(['low', 'normal', 'high', 'urgent']),
  deadline_at: nullableString,
  deadline_date: nullableString,
  deadline_timezone: nullableString,
  deadline_text: nullableString,
  text: nullableString,
  project_name: nullableString,
  stage: nullableEnum(['lead', 'planning', 'design', 'quotation', 'revision', 'approval', 'production', 'delivery', 'completed', 'on_hold', 'cancelled']),
  topic_name: nullableString,
  topic_type: nullableEnum(['design', 'graphics', 'quotation', 'budget', 'technical', 'logistics', 'invoice', 'contract', 'meeting', 'product_display', 'custom']),
  topic_description: nullableString,
};

export const ANALYSIS_SCHEMA_VERSION = '3';
export const ANALYSIS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'classification', 'classification_confidence', 'classification_evidence', 'summary', 'operations', 'reply_required_suggestion', 'importance', 'requires_deep_analysis', 'review_reasons'],
  properties: {
    schema_version: { type: 'string', enum: [ANALYSIS_SCHEMA_VERSION] },
    classification: { type: 'string', enum: ['BUSINESS_HUMAN', 'OUTREACH_OUTBOUND', 'DELIVERY_FAILURE', 'DELIVERY_DELAY', 'OUT_OF_OFFICE', 'AUTO_ACKNOWLEDGEMENT', 'TICKET_CONFIRMATION', 'UNSUBSCRIBE', 'NEWSLETTER', 'MARKETING', 'SYSTEM_NOTIFICATION', 'SPAM', 'UNKNOWN'] },
    classification_confidence: { type: 'number', minimum: 0, maximum: 1 },
    classification_evidence: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 4, maxLength: 500 } },
    summary: { type: 'string', maxLength: 2000 },
    operations: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        required: ['entity_type', 'action', 'target_id', 'source_message_id', 'evidence', 'confidence', 'task_outcome', 'changes'],
        properties: {
          entity_type: { type: 'string', enum: ['task', 'requirement', 'decision', 'project', 'topic'] },
          action: { type: 'string', enum: ['create', 'update', 'complete', 'cancel'] },
          target_id: nullableString,
          source_message_id: { type: 'string', minLength: 1, maxLength: 100 },
          evidence: { type: 'string', minLength: 4, maxLength: 1000 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          task_outcome: { type: 'string', enum: ['none', 'acknowledged', 'planned', 'partial', 'completed', 'unclear'] },
          changes: {
            type: 'object', additionalProperties: false,
            required: Object.keys(changeFields), properties: changeFields,
          },
        },
      },
    },
    reply_required_suggestion: { type: 'boolean' },
    importance: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
    requires_deep_analysis: { type: 'boolean' },
    review_reasons: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 500 } },
  },
} as const;

export type AnalysisOperation = {
  entity_type: 'task' | 'requirement' | 'decision' | 'project' | 'topic';
  action: 'create' | 'update' | 'complete' | 'cancel';
  target_id: string | null;
  source_message_id: string;
  evidence: string;
  confidence: number;
  task_outcome: 'none' | 'acknowledged' | 'planned' | 'partial' | 'completed' | 'unclear';
  changes: Record<string, string | null>;
};

export type AnalysisResult = {
  schema_version: string;
  classification: string;
  classification_confidence: number;
  classification_evidence: string[];
  summary: string;
  operations: AnalysisOperation[];
  reply_required_suggestion: boolean;
  importance: 'low' | 'normal' | 'high' | 'urgent';
  requires_deep_analysis: boolean;
  review_reasons: string[];
};
