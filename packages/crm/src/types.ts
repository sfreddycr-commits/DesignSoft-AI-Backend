/**
 * Tipos e interfaces del modulo CRM.
 */

export interface Contact {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  company?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus = 'in_progress' | 'completed' | 'missed' | 'failed' | 'transferred';

export interface CallRecord {
  id: string;
  contactId?: string;
  direction: CallDirection;
  startedAt: Date;
  endedAt?: Date;
  durationSec?: number;
  status: CallStatus;
  recordingUrl?: string;
  transcriptText?: string;
  notes?: string;
  transferredTo?: string;
}

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'proposal'
  | 'won'
  | 'lost';

export interface Lead {
  id: string;
  contactId: string;
  status: LeadStatus;
  source?: string;
  assignedTo?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CRMService {
  // Contactos
  getContact(id: string): Promise<Contact | null>;
  searchContacts(query: string): Promise<Contact[]>;
  upsertContact(
    contact: Omit<Contact, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  ): Promise<Contact>;

  // Llamadas
  recordCall(record: Omit<CallRecord, 'id'>): Promise<CallRecord>;
  getCall(id: string): Promise<CallRecord | null>;
  listCallsByContact(contactId: string, limit?: number): Promise<CallRecord[]>;
  updateCall(callId: string, update: Partial<CallRecord>): Promise<CallRecord>;
  updateCallTranscript(callId: string, transcript: string): Promise<void>;
  updateCallNotes(callId: string, notes: string): Promise<void>;

  // Leads
  createLead(lead: Omit<Lead, 'id' | 'createdAt' | 'updatedAt'>): Promise<Lead>;
  updateLeadStatus(leadId: string, status: LeadStatus): Promise<Lead>;
  listLeads(filter?: { status?: LeadStatus }): Promise<Lead[]>;
}

export interface CRMConfig {
  storage?: 'sqlite' | 'postgres' | 'mysql' | 'memory';
  databaseUrl?: string;
}
