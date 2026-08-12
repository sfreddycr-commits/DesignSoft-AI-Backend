// ============================================================
// Hermes Agent — Memory (SQLite persistente)
// ============================================================
// Tablas:
//   - conversations: historial por cliente
//   - knowledge:     hechos / preferencias aprendidas
//   - audit:         log de cada paso del agent loop
// ============================================================

import Database from 'better-sqlite3'
import 'dotenv/config'
import path from 'path'
import fs from 'fs'

const DB_PATH = process.env.HERMES_DB_URL?.replace('sqlite://', '') ?? '/data/memory/hermes.db'

// Asegurar que el directorio existe
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_conv_phone
    ON conversations(customer_phone, created_at DESC);

  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_phone
    ON knowledge(customer_phone);

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT,
    step TEXT NOT NULL,
    detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`)

export interface MemoryEntry {
  id: number
  customer_phone: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  metadata?: Record<string, unknown>
  created_at: string
}

export interface KnowledgeEntry {
  id: number
  customer_phone: string
  key: string
  value: string
  source?: string
  created_at: string
}

// --- Mensajes (historial por cliente) ---
export function saveMessage(
  customerPhone: string,
  role: MemoryEntry['role'],
  content: string,
  metadata?: Record<string, unknown>,
): void {
  db.prepare(
    'INSERT INTO conversations (customer_phone, role, content, metadata) VALUES (?, ?, ?, ?)',
  ).run(customerPhone, role, content, metadata ? JSON.stringify(metadata) : null)
}

export function getRecentMessages(customerPhone: string, limit = 20): MemoryEntry[] {
  const rows = db.prepare(
    `SELECT id, customer_phone, role, content, metadata, created_at
     FROM conversations WHERE customer_phone = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(customerPhone, limit) as Array<{
    id: number; customer_phone: string; role: string; content: string; metadata: string | null; created_at: string
  }>
  return rows.reverse().map(r => ({
    ...r,
    role: r.role as MemoryEntry['role'],
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }))
}

// --- Conocimiento (preferencias / hechos) ---
export function saveKnowledge(
  customerPhone: string,
  key: string,
  value: string,
  source?: string,
): void {
  // upsert: si ya existe, actualiza
  const existing = db.prepare(
    'SELECT id FROM knowledge WHERE customer_phone = ? AND key = ?',
  ).get(customerPhone, key) as { id: number } | undefined
  if (existing) {
    db.prepare(
      'UPDATE knowledge SET value = ?, source = COALESCE(?, source) WHERE id = ?',
    ).run(value, source, existing.id)
  } else {
    db.prepare(
      'INSERT INTO knowledge (customer_phone, key, value, source) VALUES (?, ?, ?, ?)',
    ).run(customerPhone, key, value, source ?? null)
  }
}

export function getKnowledge(customerPhone: string, key?: string): KnowledgeEntry[] {
  if (key) {
    const row = db.prepare(
      'SELECT * FROM knowledge WHERE customer_phone = ? AND key = ?',
    ).get(customerPhone, key) as KnowledgeEntry | undefined
    return row ? [row] : []
  }
  return db.prepare(
    'SELECT * FROM knowledge WHERE customer_phone = ? ORDER BY created_at DESC',
  ).all(customerPhone) as KnowledgeEntry[]
}

// Busqueda "semantica" simple: LIKE en key + value
export function searchMemory(customerPhone: string, query: string, limit = 10): {
  knowledge: KnowledgeEntry[]
  messages: MemoryEntry[]
} {
  const wildcard = `%${query}%`
  const knowledge = db.prepare(
    `SELECT * FROM knowledge
     WHERE customer_phone = ? AND (key LIKE ? OR value LIKE ?)
     ORDER BY created_at DESC LIMIT ?`,
  ).all(customerPhone, wildcard, wildcard, limit) as KnowledgeEntry[]

  const messages = db.prepare(
    `SELECT * FROM conversations
     WHERE customer_phone = ? AND content LIKE ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(customerPhone, wildcard, limit) as Array<{
    id: number; customer_phone: string; role: string; content: string; metadata: string | null; created_at: string
  }>

  return {
    knowledge,
    messages: messages.map(r => ({
      ...r,
      role: r.role as MemoryEntry['role'],
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    })),
  }
}

// --- Audit (log del agent loop) ---
export function logAudit(
  customerPhone: string | null,
  step: string,
  detail: string,
): void {
  db.prepare(
    'INSERT INTO audit (customer_phone, step, detail) VALUES (?, ?, ?)',
  ).run(customerPhone, step, detail)
}

export function getAuditLog(limit = 50): Array<{
  id: number; customer_phone: string | null; step: string; detail: string | null; created_at: string
}> {
  return db.prepare(
    'SELECT * FROM audit ORDER BY id DESC LIMIT ?',
  ).all(limit) as any
}

export function closeMemory(): void {
  db.close()
}
