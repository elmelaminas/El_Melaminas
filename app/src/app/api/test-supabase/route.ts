// ============================================================================
// 🛠 DIAGNÓSTICO — eliminar después de validar la conexión a Supabase en prod.
// ============================================================================
//
// GET /api/test-supabase
//
// Devuelve un reporte estructurado del estado del cliente admin de Supabase
// en el entorno de ejecución actual. **No retorna datos de usuarios** —
// solo banderas booleanas, conteos, y mensajes de error si los hay. Es
// seguro de llamar desde cualquier máquina sin filtrar PII.
//
// Si en algún campo `ok: false`, el campo `error` contiene la causa exacta
// (env var faltante, RLS bloqueando, key inválida, etc.).
// ============================================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';

// Forzamos Node runtime (service_role no debe correr en Edge) y que cada
// request se ejecute sin caché — queremos el estado actual.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ProbeResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

type Report = {
  timestamp: string;
  env: {
    NEXT_PUBLIC_SUPABASE_URL: boolean;
    NEXT_PUBLIC_SUPABASE_ANON_KEY: boolean;
    SUPABASE_SERVICE_ROLE_KEY: boolean;
  };
  adminClient: { ok: true } | { ok: false; error: string };
  profilesSelect: ProbeResult;
  authListUsers: ProbeResult;
};

export async function GET(): Promise<NextResponse<Report>> {
  const report: Report = {
    timestamp: new Date().toISOString(),
    env: {
      NEXT_PUBLIC_SUPABASE_URL: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      NEXT_PUBLIC_SUPABASE_ANON_KEY: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    },
    adminClient: { ok: true },
    profilesSelect: { ok: false, error: 'no ejecutado' },
    authListUsers: { ok: false, error: 'no ejecutado' },
  };

  // 1. Construcción del cliente admin
  let admin;
  try {
    admin = supabaseAdmin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.adminClient = { ok: false, error: message };
    return NextResponse.json(report, { status: 200 });
  }

  // 2. Probe de SELECT count(*) sobre profiles. Usamos head:true + count:'exact'
  //    para no traer filas — solo queremos saber si la query corre.
  try {
    const { count, error } = await admin
      .from('profiles')
      .select('*', { count: 'exact', head: true });
    if (error) {
      report.profilesSelect = { ok: false, error: error.message };
    } else {
      report.profilesSelect = { ok: true, count: count ?? 0 };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.profilesSelect = { ok: false, error: message };
  }

  // 3. Probe de auth.admin.listUsers — confirma que la service_role real
  //    funciona (no solo que las env vars están presentes).
  try {
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1 });
    if (error) {
      report.authListUsers = { ok: false, error: error.message };
    } else {
      // `data.users.length` es 1 si hay al menos un usuario; no es el total.
      // Para el total real haría falta paginar — para diagnóstico basta
      // saber que la API respondió sin error.
      report.authListUsers = { ok: true, count: data.users.length };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.authListUsers = { ok: false, error: message };
  }

  return NextResponse.json(report, { status: 200 });
}
