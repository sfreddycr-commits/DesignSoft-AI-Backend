/**
 * CRM - AI Call Center
 *
 * Modulo de gestion de clientes, contactos, llamadas y leads.
 *
 * Estado: persistencia con SQLite (better-sqlite3).
 *   - Esquema: contacts, calls, leads.
 *   - DB por defecto: <crm>/data/crm.db (gitignored).
 *   - WAL journal mode para concurrencia.
 *   - Misma interfaz CRMService que en pasos anteriores (no se rompe
 *     la integracion con call-manager).
 *
 * Si en el futuro se quiere Postgres o MySQL, solo hay que implementar
 * la misma interfaz con otro adapter.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type {
  Contact,
  CallRecord,
  Lead,
  LeadStatus,
  CRMService,
  CRMConfig,
} from './types.ts'

export type {
  Contact,
  CallRecord,
  CallDirection,
  CallStatus,
  Lead,
  LeadStatus,
  CRMService,
  CRMConfig,
} from './types.ts'

// ============================================================
// Paths
// ============================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// <crm>/src/index.ts -> <crm>
const CRM_DIR = resolve(__dirname, '..')

// ============================================================
// Schema
// ============================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  company     TEXT,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

CREATE TABLE IF NOT EXISTS calls (
  id               TEXT PRIMARY KEY,
  contact_id       TEXT,
  direction        TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  duration_sec     INTEGER,
  status           TEXT NOT NULL,
  recording_url    TEXT,
  transcript_text  TEXT,
  notes            TEXT,
  transferred_to   TEXT,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
CREATE INDEX IF NOT EXISTS idx_calls_contact_id ON calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at);

CREATE TABLE IF NOT EXISTS leads (
  id           TEXT PRIMARY KEY,
  contact_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  source       TEXT,
  assigned_to  TEXT,
  notes        TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);
CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON leads(contact_id);
`

// ============================================================
// Row <-> Domain mappers
// ============================================================

interface ContactRow {
  id: string
  name: string
  phone: string | null
  email: string | null
  company: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

interface CallRow {
  id: string
  contact_id: string | null
  direction: string
  started_at: number
  ended_at: number | null
  duration_sec: number | null
  status: string
  recording_url: string | null
  transcript_text: string | null
  notes: string | null
  transferred_to: string | null
}

interface LeadRow {
  id: string
  contact_id: string
  status: string
  source: string | null
  assigned_to: string | null
  notes: string | null
  created_at: number
  updated_at: number
}

function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? undefined,
    email: row.email ?? undefined,
    company: row.company ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

function rowToCall(row: CallRow): CallRecord {
  return {
    id: row.id,
    contactId: row.contact_id ?? undefined,
    direction: row.direction as CallRecord['direction'],
    startedAt: new Date(row.started_at),
    endedAt: row.ended_at != null ? new Date(row.ended_at) : undefined,
    durationSec: row.duration_sec ?? undefined,
    status: row.status as CallRecord['status'],
    recordingUrl: row.recording_url ?? undefined,
    transcriptText: row.transcript_text ?? undefined,
    notes: row.notes ?? undefined,
    transferredTo: row.transferred_to ?? undefined,
  }
}

function rowToLead(row: LeadRow): Lead {
  return {
    id: row.id,
    contactId: row.contact_id,
    status: row.status as LeadStatus,
    source: row.source ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  }
}

// ============================================================
// Factory
// ============================================================

export function createCRMService(config: CRMConfig = {}): CRMService {
  const storage = config.storage ?? 'sqlite'

  if (storage !== 'sqlite') {
    throw new Error(`[crm] storage "${storage}" todavia no implementado. Usa 'sqlite' o 'memory'.`)
  }

  const dbPath = config.databaseUrl
    ? resolve(config.databaseUrl)
    : resolve(CRM_DIR, 'data', 'crm.db')

  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // Prepared statements
  const stmts = {
    insertContact: db.prepare(
      `INSERT INTO contacts (id, name, phone, email, company, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateContact: db.prepare(
      `UPDATE contacts
       SET name = ?, phone = ?, email = ?, company = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
    ),
    getContactById: db.prepare(`SELECT * FROM contacts WHERE id = ?`),
    getContactByPhone: db.prepare(`SELECT * FROM contacts WHERE phone = ?`),
    searchContacts: db.prepare(
      `SELECT * FROM contacts
       WHERE LOWER(name) LIKE ?
          OR phone LIKE ?
          OR LOWER(email) LIKE ?
       ORDER BY created_at DESC`,
    ),
    insertCall: db.prepare(
      `INSERT INTO calls (id, contact_id, direction, started_at, ended_at, duration_sec, status, recording_url, transcript_text, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getCallById: db.prepare(`SELECT * FROM calls WHERE id = ?`),
    listCallsByContact: db.prepare(
      `SELECT * FROM calls WHERE contact_id = ? ORDER BY started_at DESC LIMIT ?`,
    ),
    updateCall: db.prepare(
      `UPDATE calls
       SET ended_at = ?, duration_sec = ?, status = ?, recording_url = ?, transcript_text = ?, notes = ?, transferred_to = ?
       WHERE id = ?`,
    ),
    updateCallTranscript: db.prepare(`UPDATE calls SET transcript_text = ? WHERE id = ?`),
    updateCallNotes: db.prepare(`UPDATE calls SET notes = ? WHERE id = ?`),
    insertLead: db.prepare(
      `INSERT INTO leads (id, contact_id, status, source, assigned_to, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateLead: db.prepare(
      `UPDATE leads SET status = ?, updated_at = ? WHERE id = ?`,
    ),
    getLeadById: db.prepare(`SELECT * FROM leads WHERE id = ?`),
    listLeads: db.prepare(
      `SELECT * FROM leads WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC`,
    ),
  }

  const newId = (): string => randomUUID()

  return {
    async getContact(id) {
      const row = stmts.getContactById.get(id) as ContactRow | undefined
      return row ? rowToContact(row) : null
    },

    async searchContacts(query) {
      const q = `%${query.toLowerCase()}%`
      const rows = stmts.searchContacts.all(q, `%${query}%`, q) as ContactRow[]
      return rows.map(rowToContact)
    },

    async upsertContact(input) {
      const now = Date.now()

      // 1) Preferimos match por ID si llega
      if (input.id) {
        const existing = stmts.getContactById.get(input.id) as ContactRow | undefined
        if (existing) {
          stmts.updateContact.run(
            input.name,
            input.phone ?? null,
            input.email ?? null,
            input.company ?? null,
            input.notes ?? null,
            now,
            input.id,
          )
          const updated = stmts.getContactById.get(input.id) as ContactRow
          return rowToContact(updated)
        }
      }

      // 2) Si no llega ID, pero hay telefono, buscamos por telefono
      let existing: ContactRow | undefined
      if (input.phone) {
        existing = stmts.getContactByPhone.get(input.phone) as ContactRow | undefined
      }

      if (existing) {
        stmts.updateContact.run(
          input.name,
          input.phone ?? null,
          input.email ?? null,
          input.company ?? null,
          input.notes ?? null,
          now,
          existing.id,
        )
        const updated = stmts.getContactById.get(existing.id) as ContactRow
        return rowToContact(updated)
      }

      // 3) Crear nuevo
      const id = newId()
      stmts.insertContact.run(
        id,
        input.name,
        input.phone ?? null,
        input.email ?? null,
        input.company ?? null,
        input.notes ?? null,
        now,
        now,
      )
      const created = stmts.getContactById.get(id) as ContactRow
      return rowToContact(created)
    },

    async recordCall(record) {
      const id = newId()
      stmts.insertCall.run(
        id,
        record.contactId ?? null,
        record.direction,
        record.startedAt.getTime(),
        record.endedAt?.getTime() ?? null,
        record.durationSec ?? null,
        record.status,
        record.recordingUrl ?? null,
        record.transcriptText ?? null,
        record.notes ?? null,
      )
      const row = stmts.getCallById.get(id) as CallRow
      return rowToCall(row)
    },

    async getCall(id) {
      const row = stmts.getCallById.get(id) as CallRow | undefined
      return row ? rowToCall(row) : null
    },

    async listCallsByContact(contactId, limit) {
      const cap = limit ?? 1000
      const rows = stmts.listCallsByContact.all(contactId, cap) as CallRow[]
      return rows.map(rowToCall)
    },

    async updateCall(callId, update) {
      const existing = stmts.getCallById.get(callId) as CallRow | undefined
      if (!existing) throw new Error(`Call ${callId} not found`)

      const merged = {
        ended_at: (update.endedAt ?? (existing.ended_at != null ? new Date(existing.ended_at) : undefined))?.getTime() ?? null,
        duration_sec: update.durationSec ?? existing.duration_sec ?? null,
        status: update.status ?? existing.status,
        recording_url: update.recordingUrl ?? existing.recording_url ?? null,
        transcript_text: update.transcriptText ?? existing.transcript_text ?? null,
        notes: update.notes ?? existing.notes ?? null,
        transferred_to: update.transferredTo ?? existing.transferred_to ?? null,
      }
      stmts.updateCall.run(
        merged.ended_at,
        merged.duration_sec,
        merged.status,
        merged.recording_url,
        merged.transcript_text,
        merged.notes,
        merged.transferred_to,
        callId,
      )
      const row = stmts.getCallById.get(callId) as CallRow
      return rowToCall(row)
    },

    async updateCallTranscript(callId, transcript) {
      stmts.updateCallTranscript.run(transcript, callId)
    },

    async updateCallNotes(callId, notes) {
      stmts.updateCallNotes.run(notes, callId)
    },

    async createLead(input) {
      const id = newId()
      const now = Date.now()
      stmts.insertLead.run(
        id,
        input.contactId,
        input.status,
        input.source ?? null,
        input.assignedTo ?? null,
        input.notes ?? null,
        now,
        now,
      )
      const row = stmts.getLeadById.get(id) as LeadRow
      return rowToLead(row)
    },

    async updateLeadStatus(leadId, status) {
      const existing = stmts.getLeadById.get(leadId) as LeadRow | undefined
      if (!existing) throw new Error(`Lead ${leadId} not found`)
      const now = Date.now()
      stmts.updateLead.run(status, now, leadId)
      const row = stmts.getLeadById.get(leadId) as LeadRow
      return rowToLead(row)
    },

    async listLeads(filter) {
      const status = filter?.status ?? null
      const rows = stmts.listLeads.all(status, status) as LeadRow[]
      return rows.map(rowToLead)
    },
  }
}
