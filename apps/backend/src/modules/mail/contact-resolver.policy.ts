export type ExactContactMapping = {
  id: string;
  status: string;
  companyId: string | null;
  confidence: number;
  verified: boolean;
};

export type ContactResolution = {
  status: 'matched' | 'unresolved';
  confidence: number;
  reason: string;
  companyId: string | null;
  companyReason: string;
};

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.de',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'fastmail.com', 'gmx.com', 'gmx.de', 'yandex.com', 'yandex.ru',
]);

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase().replace(/\.$/, ''));
}

export function knownCompanyForEmail(
  _email: string,
  explicitContactCompanyId: string | null,
  _explicitlyMappedDomainCompanyId: string | null,
): string | null {
  return explicitContactCompanyId;
}

export function resolveContactMapping(
  exactMatch: ExactContactMapping | null,
  _explicitDomainCompanyId: string | null,
): ContactResolution {
  const confirmedMapping = exactMatch?.status === 'confirmed' && exactMatch.verified;
  const companyId = confirmedMapping ? exactMatch.companyId : null;
  return {
    status: confirmedMapping ? 'matched' : 'unresolved',
    confidence: confirmedMapping ? 1 : 0,
    reason: confirmedMapping
      ? 'Exact normalized sender email matches a confirmed, user-registered contact mapping'
      : 'No active user-registered contact matches this exact normalized email; no contact is created',
    companyId,
    companyReason: confirmedMapping && exactMatch.companyId
      ? 'Company comes from the user-selected contact relationship'
      : 'No company is inferred from the sender domain',
  };
}
