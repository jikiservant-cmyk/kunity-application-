// lib/sms-templates.ts

export const SMS_EVENTS = {
  WELCOME: 'WELCOME',
  DEPOSIT_ALERT: 'DEPOSIT_ALERT',
  LOAN_APPROVED: 'LOAN_APPROVED',
  LOAN_REJECTED: 'LOAN_REJECTED',
  BROADCAST: 'BROADCAST'
} as const;

export type SmsEventType = keyof typeof SMS_EVENTS;

// Dictionary mapping event types to their allowed placeholders
export const EVENT_PLACEHOLDERS: Record<SmsEventType, string[]> = {
  WELCOME: ['{{first_name}}', '{{member_id}}', '{{sacco_name}}'],
  DEPOSIT_ALERT: ['{{first_name}}', '{{amount}}', '{{tx_ref}}', '{{payment_type}}'],
  LOAN_APPROVED: ['{{first_name}}', '{{loan_amount}}', '{{due_date}}'],
  LOAN_REJECTED: ['{{first_name}}', '{{loan_amount}}', '{{reason}}'],
  BROADCAST: ['{{first_name}}', '{{sacco_name}}']
};

/**
 * Validates a template string against the allowed placeholders for its event type.
 * Returns an array of invalid placeholders found.
 */
export function validateTemplatePlaceholders(eventType: SmsEventType, template: string): string[] {
  const allowedPlaceholders = EVENT_PLACEHOLDERS[eventType] || [];
  
  // Find all placeholders in the template matching {{anything}}
  const foundPlaceholdersMatch = template.match(/\{\{([^}]+)\}\}/g) || [];
  
  const invalidPlaceholders: string[] = [];

  for (const placeholder of foundPlaceholdersMatch) {
    if (!allowedPlaceholders.includes(placeholder)) {
      invalidPlaceholders.push(placeholder);
    }
  }

  return invalidPlaceholders;
}

/**
 * Helper to replace placeholders in a template with actual data values safely.
 */
export function interpolateTemplate(template: string, data: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `{{${key}}}`;
    result = result.split(placeholder).join(String(value)); // Replace all occurrences
  }
  return result;
}
