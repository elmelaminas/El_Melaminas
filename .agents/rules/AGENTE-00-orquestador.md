# AGENTE-00 — Orquestador Central
**EL MELAMINAS · Sistema de Agentes n8n · v1.0**

---

## Metadata

| Propiedad | Valor |
|---|---|
| ID del workflow | `melaminas-agent-00-orchestrator` |
| Trigger principal | Webhook interno (llamado por el Error Handler de cada agente) |
| Trigger secundario | Schedule — Cron cada 60 minutos (health check) |
| Función | Reintentos con backoff · Escalado de alertas · Health check · Log centralizado |
| Destinatarios de alerta | Todos los usuarios con rol `admin` activos |

---

## Responsabilidad

El Orquestador NO escucha eventos de Supabase. Es el sistema nervioso del stack de agentes: gestiona los reintentos cuando cualquiera de los tres agentes falla, escala la alerta a todos los administradores cuando un agente supera el máximo de intentos, y corre un health check periódico para verificar que los workflows estén activos en n8n. Es el único agente que no puede fallar en silencio.

---

## Flujo principal — Gestión de reintentos

```
Agente 01/02/03 falla en cualquier nodo
        │
        ▼
[ERR] Error Handler del agente fallido
        │ Escribe log status: error
        │
        ▼
POST webhook interno al Orquestador
        │ { workflow_id, attempt, error_message, original_payload }
        │
        ▼
[1] Webhook Interno recibe payload
        │
        ▼
[2] Switch por número de attempt
        ├── attempt = 1 → Wait 30s → Re-ejecutar agente
        ├── attempt = 2 → Wait 2min → Re-ejecutar agente
        ├── attempt = 3 → Wait 5min → Re-ejecutar agente
        └── attempt > 3 → ESCALAR A TODOS LOS ADMINS
                │
                ▼
        [4] Notificación in-app a todos los admins
        [4] WhatsApp a todos los admins
        [5] Log: status: escalated
```

---

## Flujo secundario — Health Check (cada 60 min)

```
Cron: cada 60 minutos
        │
        ▼
[HC-1] GET n8n API → lista de workflows activos
        │
        ▼
[HC-2] Verificar que los 3 IDs estén activos
        │ Todos activos → Log: health_check OK
        │ Alguno inactivo
        ▼
[HC-3] Notificación in-app + WhatsApp a todos los admins
        │ "ALERTA: El agente [nombre] está inactivo en n8n"
        │
        ▼
[HC-4] Log: status: warning
```

---

## Nodos del workflow n8n

### Workflow principal (reintentos)

| # | Nodo | Tipo n8n | Configuración |
|---|---|---|---|
| 1 | Webhook Interno | Webhook POST | URL: `melaminas-agent-00-orchestrator`. Valida `INTERNAL_WEBHOOK_SECRET`. |
| 2 | Switch attempt | Switch | 4 ramas: attempt 1, 2, 3, y > 3. |
| 3a | Wait 30s | Wait | Pausa 30 segundos. |
| 3b | Wait 2min | Wait | Pausa 120 segundos. |
| 3c | Wait 5min | Wait | Pausa 300 segundos. |
| 3d | Reintento | HTTP Request | POST al webhook del agente fallido · Body: `original_payload` + `attempt + 1`. |
| 4 | Escalado: consultar admins | HTTP Request | `GET profiles?role=eq.admin&is_active=eq.true&select=id,full_name,phone` |
| 5 | Escalado: notificaciones | HTTP Request | POST a `notifications` · una por cada admin activo. |
| 6 | Escalado: WhatsApp | HTTP Request (loop) | POST Meta Cloud API a cada admin con `phone`. |
| 7 | Log centralizado | HTTP Request | POST a `agent_logs` con `status: retry` o `escalated`. |

### Workflow secundario (health check)

| # | Nodo | Tipo n8n | Configuración |
|---|---|---|---|
| HC-0 | Schedule | Schedule Trigger | Cron: `0 * * * *` (cada hora en punto). |
| HC-1 | n8n API: workflows | HTTP Request | `GET {{N8N_API_URL}}/workflows?active=true` · Header: `X-N8N-API-KEY`. |
| HC-2 | Verificar IDs | Code (JS) | Comprueba que los 3 IDs de agentes estén en la lista de activos. |
| HC-3 | IF todos activos | IF | Si todos OK → log `health_check` y termina. Si alguno falta → continúa. |
| HC-4 | Alertar admins | HTTP Request (x2) | Notificación in-app + WhatsApp a todos los admins. |
| HC-5 | Log warning | HTTP Request | POST a `agent_logs` con `event_type: health_check, status: warning`. |

---

## Configuración del nodo Code JS — Health Check (HC-2)

```javascript
// HC-2: Verificar que los 3 agentes estén activos
const workflows = $('n8n API: workflows').first().json.data;

const AGENT_IDS = [
  'melaminas-agent-01-stock-alert',
  'melaminas-agent-02-driver-notify',
  'melaminas-agent-03-delivery-confirmed',
];

const activeNames = workflows.map(w => w.name);

const missing = AGENT_IDS.filter(id => !activeNames.includes(id));
const allActive = missing.length === 0;

return [{
  json: {
    allActive,
    missing,
    checked_at: new Date().toISOString(),
  }
}];
```

---

## Configuración del nodo Code JS — Construcción de alerta de fallo crítico

```javascript
// Paso 5 (escalado): construir notificaciones para todos los admins
const admins   = $('Escalado: consultar admins').all();
const payload  = $('Webhook Interno').first().json;

const agentNames = {
  'melaminas-agent-01-stock-alert':        'AGENTE-01 Stock Alert',
  'melaminas-agent-02-driver-notify':      'AGENTE-02 Driver Notify',
  'melaminas-agent-03-delivery-confirmed': 'AGENTE-03 Delivery Confirmed',
};

const agentName  = agentNames[payload.workflow_id] ?? payload.workflow_id;
const errorShort = payload.error_message?.substring(0, 200) ?? 'Error desconocido';

const notifications = admins.map(a => ({
  recipient_id: a.json.id,
  type:         'agent_failure',
  message:      `🚨 FALLA CRÍTICA: El ${agentName} ha fallado ${payload.attempt} veces consecutivas.\n\n` +
                `Error: ${errorShort}\n\n` +
                `Revisa n8n y agent_logs para más detalles.`,
  is_read: false,
}));

return notifications.map(n => ({ json: n }));
```

---

## Payload de entrada desde los agentes (webhook interno)

```json
{
  "workflow_id": "melaminas-agent-02-driver-notify",
  "attempt": 2,
  "error_message": "Request to Supabase REST API failed: 503 Service Unavailable",
  "original_payload": {
    "type": "UPDATE",
    "table": "leads",
    "record": {
      "id": "lead-uuid-001",
      "driver_id": "driver-uuid-007",
      "delivery_status": "pendiente"
    },
    "old_record": {
      "driver_id": null
    }
  },
  "failed_at": "2026-05-05T14:35:00Z"
}
```

---

## Llamada al Orquestador desde el Error Handler de un agente

En el nodo **Error Handler** de cada agente (AGENTE-01, 02, 03), agregar este nodo HTTP Request:

```
Nodo: Llamar al Orquestador
Tipo: HTTP Request
Método: POST
URL: {{N8N_BASE_URL}}/webhook/melaminas-agent-00-orchestrator
Headers:
  x-internal-secret: {{INTERNAL_WEBHOOK_SECRET}}
  Content-Type: application/json
Body (JSON):
{
  "workflow_id": "{{ $workflow.name }}",
  "attempt": "{{ $json.attempt ?? 1 }}",
  "error_message": "{{ $execution.lastError.message }}",
  "original_payload": {{ JSON.stringify($('Webhook Supabase').first().json) }},
  "failed_at": "{{ $now.toISO() }}"
}
```

---

## Tabla de backoff por agente

| Agente | attempt 1 | attempt 2 | attempt 3 | attempt > 3 |
|---|---|---|---|---|
| AGENTE-01 Stock | 30s | 2 min | 5 min | Escalar |
| AGENTE-02 Chofer | 30s | 2 min | 5 min | Escalar |
| AGENTE-03 Entrega | 15s | 1 min | 3 min | 10 min → 30 min → Escalar |

> AGENTE-03 tiene 5 intentos (no 3) por ser el agente de mayor impacto operativo. Si los 5 fallan → escalado.

---

## Mensaje WhatsApp — Alerta de fallo crítico

```
🚨 EL MELAMINAS — Falla Crítica de Agente

Hola [Nombre Admin], hay una falla que requiere atención inmediata:

⚙️ Agente: AGENTE-02 Driver Notify
❌ Intentos fallidos: 4
💬 Error: Request to Supabase REST API failed: 503

📋 Acción requerida:
1. Revisar estado de n8n
2. Verificar conectividad con Supabase
3. Consultar tabla agent_logs para detalle completo

🔗 n8n Dashboard: https://tu-n8n.com
```

---

## Configuración del Webhook del Orquestador en n8n

Este webhook es **interno** (no viene de Supabase), por lo que no requiere crear un webhook en el panel de Supabase. Solo se configura dentro de n8n:

| Campo | Valor |
|---|---|
| Tipo | Webhook (dentro de n8n) |
| Método | POST |
| Path | `melaminas-agent-00-orchestrator` |
| Secret header | `x-internal-secret: {{INTERNAL_WEBHOOK_SECRET}}` |
| Respuesta | Inmediata (async) |

---

## Variables de entorno requeridas

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJh...
INTERNAL_WEBHOOK_SECRET=otro-secret-min-32-caracteres
N8N_BASE_URL=https://tu-n8n.com
N8N_API_URL=https://tu-n8n.com/api/v1
N8N_API_KEY=tu-api-key-de-n8n
WHATSAPP_API_URL=https://graph.facebook.com/v19.0
WHATSAPP_TOKEN=EAAxxxxx
WHATSAPP_PHONE_ID=1234567890
```

> Para obtener `N8N_API_KEY`: en n8n → Settings → API → Create API Key.

---

## Registro en `agent_logs` — ejemplos

**Reintento exitoso:**
```json
{
  "workflow_id": "melaminas-agent-00-orchestrator",
  "event_type": "retry",
  "status": "retry",
  "payload_summary": {
    "target_workflow": "melaminas-agent-02-driver-notify",
    "attempt": 2,
    "wait_seconds": 120
  },
  "duration_ms": 122000,
  "attempt": 2
}
```

**Escalado por fallo crítico:**
```json
{
  "workflow_id": "melaminas-agent-00-orchestrator",
  "event_type": "escalated",
  "status": "escalated",
  "error_message": "melaminas-agent-03-delivery-confirmed falló 5 veces consecutivas.",
  "payload_summary": {
    "target_workflow": "melaminas-agent-03-delivery-confirmed",
    "admins_notified": 3,
    "whatsapp_sent": 3
  },
  "attempt": 5
}
```

**Health check OK:**
```json
{
  "workflow_id": "melaminas-agent-00-orchestrator",
  "event_type": "health_check",
  "status": "success",
  "payload_summary": {
    "agents_checked": 3,
    "all_active": true
  }
}
```

**Health check con agente inactivo:**
```json
{
  "workflow_id": "melaminas-agent-00-orchestrator",
  "event_type": "health_check",
  "status": "warning",
  "error_message": "Agente inactivo detectado: melaminas-agent-01-stock-alert",
  "payload_summary": {
    "agents_checked": 3,
    "all_active": false,
    "missing": ["melaminas-agent-01-stock-alert"]
  }
}
```

---

## Checklist de activación

- [ ] Workflow `melaminas-agent-00-orchestrator` creado y activo en n8n
- [ ] `INTERNAL_WEBHOOK_SECRET` configurado (distinto al `N8N_WEBHOOK_SECRET` de Supabase)
- [ ] `N8N_API_KEY` generado en n8n Settings → API y agregado a variables de entorno
- [ ] Nodo `Llamar al Orquestador` agregado al Error Handler de los 3 agentes
- [ ] Schedule de health check configurado: cron `0 * * * *`
- [ ] Test de reintento: forzar error en AGENTE-01 → verificar que el Orquestador hace el reintento en 30s
- [ ] Test de escalado: simular 4 fallos consecutivos → verificar WhatsApp a todos los admins
- [ ] Test de health check: desactivar AGENTE-02 en n8n → verificar que el Orquestador alerta en < 60min
- [ ] Verificar todos los casos en `agent_logs` con los `event_type` correctos
