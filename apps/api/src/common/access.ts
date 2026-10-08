export type ChatType = 'direct' | 'group';

export interface AccessInput {
  chatType: ChatType;
  fromNumber: string;
  allowed: string[];
  allowGroups: boolean;
}

export type AccessDecision = 'allow' | 'ignore';

export function decideAccess({
  chatType,
  fromNumber,
  allowed,
  allowGroups,
}: AccessInput): AccessDecision {
  if (chatType === 'group' && !allowGroups) return 'ignore';
  if (allowed.length === 0) return 'allow';
  return allowed.includes(fromNumber) ? 'allow' : 'ignore';
}
