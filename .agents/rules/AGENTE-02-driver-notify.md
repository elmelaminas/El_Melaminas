# AGENTE-02 — Notificación al Chofer: Lead Listo para Entregar
**EL MELAMINAS · Sistema de Agentes n8n · v1.0**

---

## Metadata

| Propiedad | Valor |
|---|---|
| ID del workflow | `melaminas-agent-02-driver-notify` |
| Trigger | Supabase DB Webhook → tabla `leads` → eventos `INSERT` y `UPDATE` |
| Condición de disparo | `driver_id` se asigna por primera vez (de `null` a UUID válido) |
| Destinatario | El chofer asignado (`profiles.id = leads.driver_id`) |
| Canal | Notificación in-app (`notifications`) + WhatsApp al teléfono del chofer |
| Reintentos | 3 intentos · backoff: 30s → 2min → 5min |

---

## Responsabilidad

Notificar al chofer asignado en el momento exacto en que un lead queda listo para su despacho, entregándole toda la información que necesita para realizar la entrega: nombre y datos del cliente, dirección con link a Google Maps, desglose exacto de materiales por color, adeudo pendiente y enlace directo a su vista en la app.

---

## Flujo paso a paso

```
Supabase INSERT o UPDATE en leads
        │
        ▼
[1] Webhook n8n recibe payload
        │
        ▼
[2] Switch: ¿driver_id asignado ahora?
        │ NO → NoOp (termina)
        │ SÍ
        ▼
[3] Consultar perfil del chofer
        │
        ▼
[4] Validar chofer activo
        │ is_active = false → Log advertencia + termina
        │ is_active = true
        ▼
[5] Consultar lead completo + lead_colors + colors
        │
        ▼
[6] Construir mensaje (Code JS)
        │
        ▼
[7] INSERT en tabla notifications
        │
        ▼
[8] WhatsApp al chofer (Meta Cloud API)
        │
        ▼
[9] Log en agent_logs → status: success
```

En caso de error → `[ERR] Error Handler` → log + llama al Orquestador.

---

## Condiciones de disparo evaluadas en el nodo Switch (Paso 2)

El webhook se dispara en **todos** los INSERT y UPDATE de `leads`. El nodo Switch filtra los casos relevantes:

| Caso | Condición | Acción |
|---|---|---|
| Lead nuevo con chofer | `type = INSERT` AND `record.driver_id != null` | Notificar |
| Chofer asignado en update | `type = UPDATE` AND `old_record.driver_id = null` AND `record.driver_id != null` | Notificar |
| Reasignación de chofer | `type = UPDATE` AND `old_record.driver_id != null` AND `record.driver_id != old_record.driver_id` | Notificar al nuevo chofer |
| Cualquier otro update | Ninguna de las anteriores | NoOp — termina silenciosamente |

---

## Nodos del workflow n8n

| # | Nodo | Tipo n8n | Configuración |
|---|---|---|---|
| 1 | Webhook Supabase | Webhook POST | Valida `x-webhook-secret`. Responde 200 inmediatamente (async). |
| 2 | Evaluar condición | IF / Switch | Aplica las 4 condiciones de la tabla anterior. |
| 3 | Consultar chofer | HTTP Request | `GET {{SUPABASE_URL}}/rest/v1/profiles?id=eq.{{driver_id}}&select=id,full_name,phone,is_active` |
| 4 | Validar activo | IF | `is_active = true`. Si false → log advertencia + NoOp. |
| 5 | Consultar lead + materiales | HTTP Request | `GET {{SUPABASE_URL}}/rest/v1/leads?id=eq.{{lead_id}}&select=*,lead_colors(quantity,colors(name))` |
| 6 | Construir mensaje | Code (JS) | Arma texto con cliente, dirección, materiales, adeudo y deep link. |
| 7 | Insertar notification | HTTP Request | `POST {{SUPABASE_URL}}/rest/v1/notifications` con `recipient_id = driver_id`. |
| 8 | WhatsApp chofer | HTTP Request | POST Meta Cloud API · Template: `melaminas_entrega_asignada` |
| 9 | Log ejecución | HTTP Request | `POST agent_logs` con `lead_id`, `driver_id`, `status: success`. |
| ERR | Error Handler | Error Trigger | Log `status: error` + llama webhook del Orquestador. |

---

## Configuración del nodo Code JS — Paso 6

```javascript
// Paso 6: Construir mensaje de notificación para el chofer
const lead   = $('Consultar lead + materiales').first().json;
const chofer = $('Consultar chofer').first().json;

// Construir lista de materiales
const materiales = lead.lead_colors
  .map(lc => `• ${lc.quantity} hojas ${lc.colors.name}`)
  .join('\n');

const totalHojas = lead.lead_colors.reduce((acc, lc) => acc + lc.quantity, 0);

// Calcular adeudo (traído del lead; el campo real viene del AGENTE-03 o de payments)
const adeudo = lead.total_amount; // simplificado; en producción consultar payments

const mensaje =
  `🚚 Nueva entrega asignada\n\n` +
  `👤 Cliente: ${lead.client_name}\n` +
  `📍 Dirección: ${lead.address}\n` +
  `🗺️ Ver mapa: ${lead.maps_url ?? 'No disponible'}\n\n` +
  `📦 Materiales (${totalHojas} hojas):\n${materiales}\n\n` +
  `💰 Adeudo del cliente: $${adeudo.toFixed(2)} MXN\n\n` +
  `📱 Ver en la app: ${process.env.APP_URL}/driver`;

return [{
  json: {
    recipient_id: lead.driver_id,
    type: 'new_delivery',
    message: mensaje,
    is_read: false,
    // extras para WhatsApp
    _driver_phone: chofer.phone,
    _driver_name:  chofer.full_name,
    _client_name:  lead.client_name,
    _address:      lead.address,
    _maps_url:     lead.maps_url,
    _total_hojas:  totalHojas,
    _adeudo:       adeudo,
  }
}];
```

---

## Payload de entrada (Supabase Webhook) — UPDATE con asignación de chofer

```json
{
  "type": "UPDATE",
  "table": "leads",
  "schema": "public",
  "record": {
    "id": "lead-uuid-001",
    "client_name": "Juan Pérez García",
    "address": "Calle Roble 45, Col. Centro, CDMX",
    "maps_url": "https://maps.google.com/?q=19.4326,-99.1332",
    "phone": "5512345678",
    "sheets_count": 13,
    "driver_id": "driver-uuid-007",
    "delivery_status": "pendiente",
    "total_amount": 8750.00,
    "payment_status": "parcial"
  },
  "old_record": {
    "driver_id": null,
    "delivery_status": "pendiente"
  }
}
```

---

## Registro generado en `notifications`

```json
{
  "recipient_id": "driver-uuid-007",
  "type": "new_delivery",
  "message": "🚚 Nueva entrega asignada\n\n👤 Cliente: Juan Pérez García\n📍 Dirección: Calle Roble 45, Col. Centro, CDMX\n🗺️ Ver mapa: https://maps.google.com/?q=...\n\n📦 Materiales (13 hojas):\n• 5 hojas Negra\n• 6 hojas Gris\n• 2 hojas Parota\n\n💰 Adeudo del cliente: $8750.00 MXN\n\n📱 Ver en la app: https://elmelaminas.com/driver",
  "is_read": false
}
```

---

## Mensaje WhatsApp — Template `melaminas_entrega_asignada`

```
🚚 EL MELAMINAS — Nueva entrega asignada

Hola Carlos, tienes una nueva entrega:

👤 Cliente: Juan Pérez García
📍 Dirección: Calle Roble 45, Col. Centro, CDMX
🗺️ Ver en mapa: https://maps.google.com/?q=19.4326,-99.1332

📦 Materiales:
   • 5 hojas Negra
   • 6 hojas Gris
   • 2 hojas Parota
   Total: 13 hojas

💰 Adeudo del cliente: $8,750.00 MXN

📱 Ver detalle en la app:
   https://elmelaminas.com/driver
```

**Variables del template (en orden):**
1. `{{1}}` — nombre del chofer
2. `{{2}}` — nombre del cliente
3. `{{3}}` — dirección de entrega
4. `{{4}}` — URL Google Maps
5. `{{5}}` — total de hojas
6. `{{6}}` — adeudo en MXN
7. `{{7}}` — link a la app

---

## Configuración del Webhook en Supabase

Panel: **Database → Webhooks → Create new webhook**

| Campo | Valor |
|---|---|
| Nombre | `on_lead_driver_assigned` |
| Tabla | `public.leads` |
| Eventos | `INSERT`, `UPDATE` |
| URL | `https://tu-n8n.com/webhook/melaminas-agent-02-driver-notify` |
| Header | `x-webhook-secret: {{N8N_WEBHOOK_SECRET}}` |
| Columnas a observar | `driver_id`, `delivery_status` (reduce disparos innecesarios) |

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
  "workflow_id": "melaminas-agent-02-driver-notify",
  "event_type": "driver_notify",
  "status": "success",
  "lead_id": "lead-uuid-001",
  "driver_id": "driver-uuid-007",
  "payload_summary": {
    "client_name": "Juan Pérez García",
    "total_hojas": 13,
    "adeudo": 8750.00,
    "whatsapp_sent": true
  },
  "duration_ms": 680,
  "attempt": 1
}
```

---

## Checklist de activación

- [ ] Workflow `melaminas-agent-02-driver-notify` creado y activo en n8n
- [ ] Webhook `on_lead_driver_assigned` creado en Supabase (INSERT + UPDATE en `leads`)
- [ ] Template `melaminas_entrega_asignada` aprobado en Meta Business Suite
- [ ] Variables de entorno configuradas en n8n
- [ ] Test: asignar `driver_id` a un lead existente desde Supabase Studio
- [ ] Verificar que el chofer recibe notificación in-app en `/driver`
- [ ] Verificar WhatsApp recibido en el teléfono del chofer de prueba
- [ ] Verificar que un lead sin `driver_id` NO dispara la notificación (NoOp)
- [ ] Verificar registro en `agent_logs` con `status: success`
