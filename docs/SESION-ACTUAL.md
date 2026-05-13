# EL MELAMINAS — Sesión de Desarrollo
**Última actualización:** Mayo 2026
**Repo:** https://github.com/elmelaminas/El_Melaminas
**Deploy:** https://el-melaminas.vercel.app
**Supabase:** ijtnpfiznwfytgzrakir.supabase.co
**Ruta local:** C:\Users\Usuario\OneDrive\Documentos\El_Melaminas\app

## Stack
Next.js 15 App Router + TypeScript + Tailwind + shadcn/ui
Supabase (PostgreSQL + Auth + Storage + Edge Functions)
n8n para automatizaciones
Git config: user.email=Rogelgranadoss@gmail.com / user.name=elmelaminas

## Roles del sistema
admin, seller, driver, warehouse, supervisor, contador

## Tablas Supabase
profiles, sellers, colors, inventory, leads, lead_colors, payments,
payment_deductibles, driver_deliveries, inventory_movements, notifications,
agent_logs, cash_transfers, delivery_issues

## Columnas especiales en leads
cuts_count, cuts_total, edge_banding_type, edge_banding_meters,
edge_banding_total, document_url, delivery_order, delivery_date,
failed_delivery_reason, failed_delivery_photo_url

## Buckets de Storage
- payments-evidence (privado)
- driver-evidence (privado)
- lead-documents (público)

## Módulos implementados
- /dashboard — métricas con filtro mes/año, cards clickeables
- /leads — listado con filtros, editar fecha/chofer, PDF adjunto
- /leads/new — formulario completo con cortes, cubrecanto, colores dinámicos
- /leads/[id]/edit — editar fecha y chofer
- /payments — historial con evidencia lightbox, tipo contra_entrega
- /payments/new — registrar pagos
- /driver — vista secuencial de rutas, reportar faltantes, no pude entregar
- /warehouse — stock, entradas, movimientos con cliente, marcar salida
- /admin/users — CRUD completo con edición de usuarios
- /admin/catalogs — vendedores y colores
- /admin/entregas — todas las entregas con issues y evidencia
- /admin/caja — tabs por validar / validados
- /contador — recibir efectivo de choferes
- /forgot-password, /reset-password

## Último commit
3998aa3 feat(users): edit user modal

## Reglas de comunicación con Sergio
- Instrucciones para Antigravity: en bloque de código copiable
- Git: user.email=Rogelgranadoss@gmail.com / user.name=elmelaminas
- PowerShell Windows, un comando a la vez
- tsc --noEmit + npm run build antes de cada push
- Schema separado de actions en todos los módulos
- supabaseAdmin() para lecturas administrativas, supabaseServer() para auth.uid()
- Notificaciones siempre non-fatal (try/catch separado)

## Próximas tareas pendientes
- Signed URLs para payments-evidence (imágenes de evidencia de pagos)
- Agentes n8n (AGENTE-01 stock, AGENTE-02 chofer, AGENTE-03 entrega)
- /reports para supervisores
