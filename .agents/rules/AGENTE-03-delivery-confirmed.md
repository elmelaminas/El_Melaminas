# AGENTE-03 — Notificación al Admin: Entrega Confirmada por Chofer
**EL MELAMINAS · Sistema de Agentes n8n · v1.0**

---

## Metadata

| Propiedad | Valor |
|---|---|
| ID del workflow | `melaminas-agent-03-delivery-confirmed` |
| Trigger | Supabase DB Webhook → tabla `driver_deliveries` → evento `INSERT` |
| Condición de disparo | Cualquier INSERT (toda confirmación de entrega es relevante) |
| Destinatario | Admin receptor: `profiles.id = driver_deliveries.admin_receiver_id` |
| Canal | Notificación in-app (`notifications`) + WhatsApp al admin receptor |
| Acciones adicionales | Actualiza `leads.delivery_status = 'entregado'` · Ejecuta descuento definitivo de stock vía Edge Function |
| Reintentos | **5 intentos** · backoff: 15s → 1min → 3min → 10min → 30min (prioridad crítica) |

---

## Responsabilidad

Es el agente más crítico del sistema. Al confirmarse una entrega por parte del chofer, este agente: notifica al administrador receptor con el detalle completo del cobro (bruto, deducibles, neto), actualiza el estado de entrega del lead, y dispara el descuento definitivo de inventario en una transacción atómica en Supabase. Si este agente falla, tiene el mayor número de reintentos y escala a todos los admins activos.

---

## Flujo paso a paso

```
Chofer presiona "Entregado a [Admin]" en la app
        │
        ▼
INSERT en driver_deliveries (desde la app)
        │
        ▼
[1] Webhook n8n recibe payload
        │
        ▼
[2] Consultas en paralelo:
    (A) Lead completo + lead_colors
    (B) Perfil del chofer
    (C) Perfil del admin receptor
        │
        ▼
[3] Calcular monto neto (amount - deducibles)
        │
        ▼
[4] PATCH leads → delivery_status: 'entregado'
        │
        ▼
[5] POST Edge Function commit-stock-delivery
        │
        ▼
[6] Construir mensaje para el admin (Code JS)
        │
        ▼
[7] INSERT en tabla notifications → admin receptor
        │
        ▼
[8] WhatsApp al admin receptor (Meta Cloud API)
        │
        ▼
[9] Log en agent_logs → status: success
```

En caso de error → `[ERR] Error Handler crítico` → 5 reintentos → si todos fallan: notificación de emergencia a **todos** los admins activos.

---

## Nodos del workflow n8n

| # | Nodo | Tipo n8n | Configuración |
|---|---|---|---|
| 1 | Webhook Supabase | Webhook POST | Valida `x-webhook-secret`. Responde 200 async inmediatamente. |
| 2A | Consultar lead | HTTP Request (paralelo) | `GET {{SUPABASE_URL}}/rest/v1/leads?id=eq.{{lead_id}}&select=*,lead_colors(quantity,colors(name))` |
| 2B | Consultar chofer | HTTP Request (paralelo) | `GET {{SUPABASE_URL}}/rest/v1/profiles?id=eq.{{driver_id}}&select=id,full_name,phone` |
| 2C | Consultar admin | HTTP Request (paralelo) | `GET {{SUPABASE_URL}}/rest/v1/profiles?id=eq.{{admin_receiver_id}}&select=id,full_name,phone` |
| 3 | Calcular monto neto | Code (JS) | Consulta `payment_deductibles` del pago más reciente del lead. Neto = `amount_collected - total_deducibles`. |
| 4 | Actualizar lead | HTTP Request | `PATCH {{SUPABASE_URL}}/rest/v1/leads?id=eq.{{lead_id}}` · Body: `{"delivery_status": "entregado"}` |
| 5 | Commit stock | HTTP Request | `POST {{SUPABASE_URL}}/functions/v1/commit-stock-delivery` · Body: `{"lead_id": "..."}` |
| 6 | Construir mensaje | Code (JS) | Arma notificación con chofer, cliente, materiales, monto bruto, deducibles, neto, timestamp. |
| 7 | Insertar notification | HTTP Request | `POST {{SUPABASE_URL}}/rest/v1/notifications` · `recipient_id = admin_receiver_id` |
| 8 | WhatsApp admin | HTTP Request | POST Meta Cloud API · Template: `melaminas_entrega_confirmada` |
| 9 | Log ejecución | HTTP Request | `POST agent_logs` con todos los IDs y `status: success`. |
| ERR | Error Handler crítico | Error Trigger | 5 reintentos. Si todos fallan → notifica a **todos** los admins activos. |

---

## Configuración del nodo Code JS — Paso 3: Calcular monto neto

```javascript
// Paso 3: Obtener deducibles del pago más reciente del lead
const lead_id   = $('Webhook Supabase').first().json.record.lead_id;
const amount_collected = $('Webhook Supabase').first().json.record.amount_collected ?? 0;

// Consultar payment_deductibles del pago más reciente
const paymentsRes = await $http.request({
  method: 'GET',
  url: `${process.env.SUPABASE_URL}/rest/v1/payments?lead_id=eq.${lead_id}&order=created_at.desc&limit=1&select=id,amount`,
  headers: {
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'apikey': process.env.SUPABASE_SERVICE_KEY,
  }
});

const payment_id = paymentsRes.data?.[0]?.id;
let total_deducibles = 0;

if (payment_id) {
  const deductiblesRes = await $http.request({
    method: 'GET',
    url: `${process.env.SUPABASE_URL}/rest/v1/payment_deductibles?payment_id=eq.${payment_id}&select=concept,amount`,
    headers: {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'apikey': process.env.SUPABASE_SERVICE_KEY,
    }
  });
  total_deducibles = deductiblesRes.data.reduce((acc, d) => acc + parseFloat(d.amount), 0);
}

const neto = amount_collected - total_deducibles;

return [{
  json: {
    amount_collected,
    total_deducibles,
    neto,
    payment_id,
  }
}];
```

---

## Configuración del nodo Code JS — Paso 6: Construir mensaje

```javascript
// Paso 6: Construir mensaje completo para el admin
const delivery  = $('Webhook Supabase').first().json.record;
const lead      = $('Consultar lead').first().json;
const chofer    = $('Consultar chofer').first().json;
const admin     = $('Consultar admin').first().json;
const montos    = $('Calcular monto neto').first().json;

// Lista de materiales
const materiales = lead.lead_colors
  .map(lc => `• ${lc.quantity} hojas ${lc.colors.name}`)
  .join('\n');

// Timestamp formateado
const ts = new Date(delivery.delivered_at);
const fechaStr = ts.toLocaleString('es-MX', {
  timeZone: 'America/Mexico_City',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit'
});

const mensaje =
  `✅ Entrega confirmada\n\n` +
  `🚚 Chofer: ${chofer.full_name}\n` +
  `👤 Cliente: ${lead.client_name}\n` +
  `📍 Dirección: ${lead.address}\n\n` +
  `📦 Material entregado:\n${materiales}\n\n` +
  `💵 Cobrado en campo: $${montos.amount_collected.toFixed(2)} MXN\n` +
  `➖ Deducibles: $${montos.total_deducibles.toFixed(2)} MXN\n` +
  `✅ Ingreso neto: $${montos.neto.toFixed(2)} MXN\n\n` +
  `🕐 Confirmado: ${fechaStr} hrs\n\n` +
  `El inventario ha sido actualizado automáticamente.`;

return [{
  json: {
    recipient_id:  delivery.admin_receiver_id,
    type:          'delivery_confirmed',
    message:       mensaje,
    is_read:       false,
    // extras para WhatsApp
    _admin_name:   admin.full_name,
    _admin_phone:  admin.phone,
    _chofer_name:  chofer.full_name,
    _client_name:  lead.client_name,
    _amount:       montos.amount_collected,
    _deducibles:   montos.total_deducibles,
    _neto:         montos.neto,
    _timestamp:    fechaStr,
  }
}];
```

---

## Edge Function Supabase — `commit-stock-delivery`

Esta función corre **dentro de Supabase** (no en n8n) para garantizar consistencia transaccional. El AGENTE-03 la invoca en el paso 5.

**Ruta:** `supabase/functions/commit-stock-delivery/index.ts`

```typescript
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  const { lead_id } = await req.json()
  if (!lead_id) return new Response('lead_id requerido', { status: 400 })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // 1. Obtener todos los colores del lead
  const { data: leadColors, error: lcError } = await supabase
    .from('lead_colors')
    .select('color_id, quantity')
    .eq('lead_id', lead_id)

  if (lcError) return new Response(JSON.stringify(lcError), { status: 500 })

  // 2. Por cada color: descontar stock_total y stock_committed
  for (const lc of leadColors) {
    const { error: invError } = await supabase.rpc('decrement_stock', {
      p_color_id: lc.color_id,
      p_quantity:  lc.quantity,
    })
    if (invError) return new Response(JSON.stringify(invError), { status: 500 })

    // 3. Registrar movimiento de salida definitiva
    await supabase.from('inventory_movements').insert({
      color_id:       lc.color_id,
      movement_type:  'salida',
      quantity:        lc.quantity,
      lead_id:         lead_id,
      reference:       'Entrega confirmada por chofer',
    })
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})
```

**Función SQL auxiliar `decrement_stock` (crear en Supabase SQL Editor):**

```sql
CREATE OR REPLACE FUNCTION decrement_stock(p_color_id uuid, p_quantity integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inventory
  SET
    stock_total     = stock_total     - p_quantity,
    stock_committed = stock_committed - p_quantity,
    updated_at      = now()
  WHERE color_id = p_color_id;
END;
$$;
```

**Desplegar la función:**
```bash
supabase functions deploy commit-stock-delivery
```

---

## Payload de entrada (Supabase Webhook)

```json
{
  "type": "INSERT",
  "table": "driver_deliveries",
  "schema": "public",
  "record": {
    "id": "delivery-uuid-001",
    "lead_id": "lead-uuid-001",
    "driver_id": "driver-uuid-007",
    "admin_receiver_id": "admin-uuid-003",
    "amount_collected": 3250.00,
    "evidence_photo_url": "https://xxxx.supabase.co/storage/v1/object/sign/...",
    "delivered_at": "2026-05-05T14:32:00Z",
    "notes": null
  },
  "old_record": null
}
```

---

## Registro generado en `notifications`

```json
{
  "recipient_id": "admin-uuid-003",
  "type": "delivery_confirmed",
  "message": "✅ Entrega confirmada\n\n🚚 Chofer: Carlos Ramírez\n👤 Cliente: Juan Pérez García\n📍 Dirección: Calle Roble 45, Col. Centro, CDMX\n\n📦 Material entregado:\n• 5 hojas Negra\n• 6 hojas Gris\n• 2 hojas Parota\n\n💵 Cobrado en campo: $3,250.00 MXN\n➖ Deducibles: $180.00 MXN\n✅ Ingreso neto: $3,070.00 MXN\n\n🕐 Confirmado: 05/05/2026 14:32 hrs",
  "is_read": false
}
```

---

## Mensaje WhatsApp — Template `melaminas_entrega_confirmada`

```
✅ EL MELAMINAS — Entrega Confirmada

Hola María, el chofer ha confirmado la entrega:

🚚 Chofer: Carlos Ramírez
👤 Cliente: Juan Pérez García
📍 Calle Roble 45, Col. Centro, CDMX

📦 Material entregado:
   • 5 hojas Negra
   • 6 hojas Gris
   • 2 hojas Parota

💵 Cobrado en campo:  $3,250.00 MXN
➖ Deducibles:         $180.00 MXN
✅ Ingreso neto:      $3,070.00 MXN

🕐 Confirmado: 05/05/2026 14:32 hrs

El stock fue actualizado automáticamente.
```

**Variables del template (en orden):**
1. `{{1}}` — nombre del admin receptor
2. `{{2}}` — nombre del chofer
3. `{{3}}` — nombre del cliente
4. `{{4}}` — dirección
5. `{{5}}` — monto cobrado en campo
6. `{{6}}` — total deducibles
7. `{{7}}` — ingreso neto
8. `{{8}}` — timestamp formateado

---

## Configuración del Webhook en Supabase

Panel: **Database → Webhooks → Create new webhook**

| Campo | Valor |
|---|---|
| Nombre | `on_driver_delivery_insert` |
| Tabla | `public.driver_deliveries` |
| Eventos | `INSERT` |
| URL | `https://tu-n8n.com/webhook/melaminas-agent-03-delivery-confirmed` |
| Header | `x-webhook-secret: {{N8N_WEBHOOK_SECRET}}` |

---

## Variables de entorno requeridas

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJh...
N8N_WEBHOOK_SECRET=min-32-caracteres-aleatorios
WHATSAPP_API_URL=https://graph.facebook.com/v19.0
WHATSAPP_TOKEN=EAAxxxxx
WHATSAPP_PHONE_ID=1234567890
APP_URL=https://elmelaminas.com
```

---

## Registro en `agent_logs` al finalizar

```json
{
  "workflow_id": "melaminas-agent-03-delivery-confirmed",
  "event_type": "delivery_confirmed",
  "status": "success",
  "lead_id": "lead-uuid-001",
  "driver_id": "driver-uuid-007",
  "payload_summary": {
    "admin_receiver_id": "admin-uuid-003",
    "amount_collected": 3250.00,
    "total_deducibles": 180.00,
    "neto": 3070.00,
    "stock_committed": true,
    "whatsapp_sent": true
  },
  "duration_ms": 1240,
  "attempt": 1
}
```

---

## Checklist de activación

- [ ] Edge Function `commit-stock-delivery` desplegada: `supabase functions deploy commit-stock-delivery`
- [ ] Función SQL `decrement_stock` creada en Supabase SQL Editor
- [ ] Workflow `melaminas-agent-03-delivery-confirmed` creado y activo en n8n
- [ ] Webhook `on_driver_delivery_insert` creado en Supabase (INSERT en `driver_deliveries`)
- [ ] Template `melaminas_entrega_confirmada` aprobado en Meta Business Suite (8 variables)
- [ ] Test: INSERT manual en `driver_deliveries` desde Supabase Studio
- [ ] Verificar PATCH en `leads.delivery_status = 'entregado'`
- [ ] Verificar descuento de stock en tabla `inventory` y registro en `inventory_movements`
- [ ] Verificar notificación in-app recibida por el admin receptor
- [ ] Verificar WhatsApp recibido por el admin
- [ ] Verificar registro en `agent_logs` con `status: success`
- [ ] Test de fallo: simular error en Edge Function → verificar 5 reintentos y escalado a todos los admins
