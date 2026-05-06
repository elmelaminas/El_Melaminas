# AGENTE-01 — Alerta de Bajo Stock
**EL MELAMINAS · Sistema de Agentes n8n · v1.0**

---

## Metadata

| Propiedad | Valor |
|---|---|
| ID del workflow | `melaminas-agent-01-stock-alert` |
| Trigger | Supabase DB Webhook → tabla `inventory` → evento `UPDATE` |
| Condición de disparo | `stock_available <= stock_minimum` |
| Destinatarios | Usuarios con rol `warehouse` + todos los `admin` activos |
| Canal | Notificación in-app (`notifications`) + WhatsApp al admin |
| Reintentos | 3 intentos · backoff: 30s → 2min → 5min |

---

## Responsabilidad

Detectar en tiempo real cuando el stock disponible de cualquier material cae por debajo del mínimo configurado y notificar automáticamente al personal de almacén y a los administradores para que puedan gestionar el reabastecimiento antes de que el inventario se agote.

---

## Flujo paso a paso

```
Supabase UPDATE en inventory
        │
        ▼
[1] Webhook n8n recibe payload
        │
        ▼
[2] Filter: stock_available <= stock_minimum?
        │ NO → NoOp (termina)
        │ SÍ
        ▼
[3] Consultar recipients (warehouse + admin activos)
        │
        ▼
[4] Construir array de notificaciones (Code JS)
        │
        ▼
[5] INSERT en tabla notifications (Supabase REST)
        │
        ▼
[6] WhatsApp al admin (Meta Cloud API)
        │
        ▼
[7] Log en agent_logs → status: success
```

En caso de error en cualquier nodo → `[ERR] Error Handler` → escribe log con `status: error` → llama al Orquestador para reintento.

---

## Nodos del workflow n8n

| # | Nodo | Tipo n8n | Configuración |
|---|---|---|---|
| 1 | Webhook Supabase | Webhook POST | Valida header `x-webhook-secret` contra `N8N_WEBHOOK_SECRET`. Si no coincide → 401 y detiene. |
| 2 | Validar bajo stock | IF / Filter | `{{ $json.record.stock_available }} <= {{ $json.record.stock_minimum }}`. Si FALSE → NoOp. |
| 3 | Consultar recipientes | HTTP Request | `GET {{SUPABASE_URL}}/rest/v1/profiles?role=in.(warehouse,admin)&is_active=eq.true` |
| 4 | Preparar mensajes | Code (JS) | Construye array de notificaciones: una por recipiente con `recipient_id`, `type`, `message`. |
| 5 | Insertar notifications | HTTP Request | `POST {{SUPABASE_URL}}/rest/v1/notifications` · Header: `Prefer: return=minimal` |
| 6 | WhatsApp admin | HTTP Request | POST Meta Cloud API · Template: `melaminas_stock_bajo` · Solo si el admin tiene `phone`. |
| 7 | Log ejecución | HTTP Request | `POST {{SUPABASE_URL}}/rest/v1/agent_logs` con `status: success`. |
| ERR | Error Handler | Error Trigger | Escribe log `status: error` + llama webhook del Orquestador. |

---

## Configuración del nodo Code JS — Paso 4

```javascript
// Paso 4: Construir array de notificaciones
const recipients = $input.all(); // resultado del paso 3
const record = $('Webhook Supabase').first().json.record;

// Necesitamos el nombre del color — hacer JOIN previo o usar color_id
const materialName = record.color_name ?? record.color_id;
const stockActual  = record.stock_available;
const stockMinimo  = record.stock_minimum;

const notifications = recipients.map(r => ({
  recipient_id: r.json.id,
  type: 'low_stock',
  message: `⚠️ STOCK BAJO: El material "${materialName}" tiene solo ` +
           `${stockActual} hojas disponibles. Mínimo configurado: ${stockMinimo}. ` +
           `Por favor registra una entrada de material.`,
  is_read: false,
}));

return notifications.map(n => ({ json: n }));
```

> **Nota:** Para obtener `color_name` en el payload del webhook, agrega un JOIN en el webhook de Supabase o realiza un GET adicional a `colors?id=eq.{{color_id}}` antes del nodo Code.

---

## Payload de entrada (Supabase Webhook)

```json
{
  "type": "UPDATE",
  "table": "inventory",
  "schema": "public",
  "record": {
    "id": "uuid-del-registro",
    "color_id": "uuid-del-color",
    "color_name": "Gris",
    "stock_total": 15,
    "stock_committed": 12,
    "stock_available": 3,
    "stock_minimum": 10,
    "updated_at": "2026-05-05T10:30:00Z"
  },
  "old_record": {
    "stock_available": 11
  }
}
```

---

## Registro generado en `notifications`

```json
{
  "recipient_id": "uuid-del-almacenista",
  "type": "low_stock",
  "message": "⚠️ STOCK BAJO: El material \"Gris\" tiene solo 3 hojas disponibles. Mínimo configurado: 10. Por favor registra una entrada de material.",
  "is_read": false
}
```

---

## Mensaje WhatsApp — Template `melaminas_stock_bajo`

```
⚠️ EL MELAMINAS — Stock Bajo

Hola [Nombre Admin], se detectó bajo inventario:

📦 Material: Gris
📉 Stock disponible: 3 hojas
🔴 Mínimo configurado: 10 hojas

Por favor gestiona una entrada de material lo antes posible.

https://elmelaminas.com/warehouse
```

**Variables del template (en orden):**
1. `{{1}}` — nombre del material
2. `{{2}}` — stock_available actual
3. `{{3}}` — stock_minimum configurado

---

## Configuración del Webhook en Supabase

Panel: **Database → Webhooks → Create new webhook**

| Campo | Valor |
|---|---|
| Nombre | `on_inventory_update_stock_alert` |
| Tabla | `public.inventory` |
| Eventos | `UPDATE` |
| URL | `https://tu-n8n.com/webhook/melaminas-agent-01-stock-alert` |
| Header | `x-webhook-secret: {{N8N_WEBHOOK_SECRET}}` |
| Observación | Activar solo cuando cambie `stock_available` para minimizar disparos |

---

## Variables de entorno requeridas

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJh...   # service_role key, NO la anon
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
  "workflow_id": "melaminas-agent-01-stock-alert",
  "event_type": "stock_alert",
  "status": "success",
  "payload_summary": {
    "color_id": "uuid-del-color",
    "stock_available": 3,
    "stock_minimum": 10,
    "recipients_notified": 3
  },
  "duration_ms": 420,
  "attempt": 1
}
```

---

## Checklist de activación

- [ ] Tabla `agent_logs` creada en Supabase con RLS aplicada
- [ ] Variables de entorno configuradas en n8n
- [ ] Template `melaminas_stock_bajo` aprobado en Meta Business Suite
- [ ] Webhook `on_inventory_update_stock_alert` creado en Supabase
- [ ] Workflow importado y activo en n8n
- [ ] Test manual: UPDATE en `inventory` con `stock_available = 2` y `stock_minimum = 10`
- [ ] Verificar notificación in-app y WhatsApp recibidos
- [ ] Verificar registro en `agent_logs` con `status: success`
