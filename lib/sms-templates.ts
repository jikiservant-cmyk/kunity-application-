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
 * Supports both snake_case and camelCase forms (e.g. {{first_name}} and {{firstName}}).
 */
export function interpolateTemplate(template: string, data: Record<string, string | number>): string {
  let result = template;
  
  // Expand data to have both camelCase and snake_case equivalents
  const normalizedData: Record<string, string | number> = { ...data };
  for (const [key, value] of Object.entries(data)) {
    // snake_case to camelCase
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(camelKey in normalizedData)) {
      normalizedData[camelKey] = value;
    }
    // camelCase to snake_case
    const snakeKey = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (!(snakeKey in normalizedData)) {
      normalizedData[snakeKey] = value;
    }
  }

  for (const [key, value] of Object.entries(normalizedData)) {
    const placeholder = `{{${key}}}`;
    result = result.split(placeholder).join(String(value ?? ''));
  }
  return result;
}
