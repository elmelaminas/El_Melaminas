'use server';

import { revalidatePath } from 'next/cache';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { supabaseServer } from '@/lib/supabase/server';
import { ResolveIssueSchema, type ResolveIssueState } from './schema';

// NB: 'use server' file — solo async functions.

/**
 * `resolveIssueAction(_prev, formData)` — admin marca un delivery_issue
 * como resuelto. Triple defensa de role admin (middleware, page, action).
 */
export async function resolveIssueAction(
  _prev: ResolveIssueState,
  formData: FormData,
): Promise<ResolveIssueState> {
  try {
    const parsed = ResolveIssueSchema.safeParse({
      issue_id: formData.get('issue_id'),
    });
    if (!parsed.success) {
      return { status: 'error', message: 'issue_id inválido.' };
    }

    const userClient = await supabaseServer();
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) {
      return { status: 'error', message: 'Sesión no válida.' };
    }

    const admin = supabaseAdmin();

    // Role check: solo admin puede resolver issues.
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profileErr) {
      return {
        status: 'error',
        message: `No se pudo verificar tu rol: ${profileErr.message}`,
      };
    }
    if (profile?.role !== 'admin') {
      return {
        status: 'error',
        message: 'Solo un administrador puede resolver issues.',
      };
    }

    const { error: updErr } = await admin
      .from('delivery_issues')
      .update({ resolved: true })
      .eq('id', parsed.data.issue_id);
    if (updErr) {
      return {
        status: 'error',
        message: `No se pudo resolver: ${updErr.message}`,
      };
    }

    revalidatePath('/admin/entregas');
    return { status: 'success' };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error desconocido al resolver';
    console.error('[resolveIssueAction] excepción no controlada:', err);
    return { status: 'error', message };
  }
}
