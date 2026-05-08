/**
 * Schema y tipos para /admin/entregas — solo el action de resolver
 * issues. El SELECT principal de leads no usa Zod (es server-side
 * input vía searchParams, validado con whitelists en page.tsx).
 */

import { z } from 'zod';

export const ResolveIssueSchema = z.object({
  issue_id: z.string().uuid('issue_id inválido'),
});

export type ResolveIssueState =
  | { status: 'idle' }
  | { status: 'success' }
  | { status: 'error'; message: string };

export const initialResolveIssueState: ResolveIssueState = { status: 'idle' };
