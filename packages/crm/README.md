# CRM

Modulo del AI Call Center responsable de la gestion de clientes, llamadas y leads.

## Que hace

- **Contactos** — guarda la ficha de cada persona que llama: nombre, telefono, email, empresa, notas.
- **Llamadas** — registra cada llamada: direccion (inbound/outbound), fecha, duracion, estado, transcripcion, URL de grabacion.
- **Leads** — lleva el ciclo de vida de cada oportunidad: nuevo, contactado, calificado, propuesta, ganado, perdido.
- **API** — expone metodos para que el agente IA consulte y actualice el CRM durante la llamada, y para que el dashboard liste y filtre.

## Estado

Estructura inicial. Sin logica implementada todavia.

Lo que falta:

- [ ] Decidir el backend de almacenamiento (SQLite, Postgres, MySQL, etc.).
- [ ] Implementar el esquema de base de datos.
- [ ] Implementar `CRMService` (contactos, llamadas, leads).
- [ ] Persistir transcripciones y grabaciones.
- [ ] API HTTP para el dashboard.

## Decisiones pendientes

| Tema | Opciones | Recomendacion actual |
|------|---------|----------------------|
| Almacenamiento | SQLite / Postgres / MySQL | SQLite para empezar (sin infra extra); Postgres si se necesita concurrencia o tamaños grandes |
| ORM | Drizzle / Prisma / Knex / SQL crudo | Drizzle (TS-first, ligero) |
| Migraciones | Drizzle Kit / manual | Drizzle Kit |
| API | REST / GraphQL / tRPC | REST (estandar para CRMs) |

(Todas estas decisiones se confirman en pasos siguientes.)

## Estructura

```
crm/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── README.md
```

## Como se usa (planeado)

```ts
import { createCRMService } from "@ai-callcenter/crm";

const crm = createCRMService({
  storage: "sqlite",
  databaseUrl: "./data/crm.db",
});

// El agente IA actualiza el CRM durante la llamada
await crm.upsertContact({
  name: "Juan Perez",
  phone: "+50688881234",
  email: "juan@example.com",
});

await crm.recordCall({
  contactId: "...",
  direction: "inbound",
  startedAt: new Date(),
  status: "completed",
  durationSec: 142,
});

await crm.updateCallTranscript(callId, "...transcripcion...");
```

(Solo ilustrativo. La implementacion real llega en pasos siguientes.)
