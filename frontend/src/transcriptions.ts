import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  updateDoc,
  orderBy,
  query,
  serverTimestamp,
  addDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";

/* Transcriptions live at users/{uid}/transcriptions/{id}.

   Nesting them under the user (rather than one flat collection filtered by a
   uid field) means: the security rules are a one-liner, listing a user's work
   needs no composite index, and deleting an account is a single subtree walk. */

/** The transcribed notes, stored compactly (s=start, e=end, m=midi) so a saved
    project can be re-rendered later. Optional extras: c=confidence, a=amplitude,
    t=technique letters (N harmonic, H hammer-on, P pull-off, V vibrato, T tremolo),
    hf=harmonic fret. Projects saved before these existed still load. */
export interface StoredNote {
  s: number;
  e: number;
  m: number;
  c?: number;
  a?: number;
  t?: string;
  hf?: number;
}

/** A crescendo (<) or decrescendo (>) between two times in seconds. */
export interface StoredHairpin {
  k: "<" | ">";
  s: number;
  e: number;
}

export interface TranscriptionInput {
  name: string;
  instrument: string;
  instrumentName: string;
  format: string;
  formatName: string;
  durationSeconds: number;
  color: string;
  notes: StoredNote[];
  /** Detected tempo, so a reopened project shows the same bar lines. */
  bpm: number;
  hairpins?: StoredHairpin[];
}

export interface TranscriptionRecord extends TranscriptionInput {
  id: string;
  noteCount: number;
  createdAtMs: number;
}

// Firestore documents cap out at 1 MB; this keeps even a long take far under.
const MAX_STORED_NOTES = 2000;

function transcriptionsRef(uid: string) {
  return collection(db, "users", uid, "transcriptions");
}

export async function saveTranscription(uid: string, input: TranscriptionInput) {
  // Firestore rejects undefined values, so optional keys are only written when set.
  const notes = input.notes.slice(0, MAX_STORED_NOTES).map(n => {
    const out: StoredNote = { s: Number(n.s.toFixed(3)), e: Number(n.e.toFixed(3)), m: Math.round(n.m) };
    if (typeof n.c === "number") out.c = Number(n.c.toFixed(2));
    if (typeof n.a === "number") out.a = Number(n.a.toFixed(2));
    if (n.t) out.t = n.t;
    if (n.hf) out.hf = n.hf;
    return out;
  });

  return addDoc(transcriptionsRef(uid), {
    ...input,
    notes,
    hairpins: (input.hairpins ?? []).map(h => ({ k: h.k, s: Number(h.s.toFixed(3)), e: Number(h.e.toFixed(3)) })),
    noteCount: input.notes.length,
    createdAtMs: Date.now(),
    createdAt: serverTimestamp(),
  });
}

function toRecord(id: string, data: Record<string, unknown>): TranscriptionRecord {
  return {
    id,
    name: (data.name as string) ?? "Untitled",
    instrument: (data.instrument as string) ?? "",
    instrumentName: (data.instrumentName as string) ?? "Unknown",
    format: (data.format as string) ?? "",
    formatName: (data.formatName as string) ?? "",
    durationSeconds: (data.durationSeconds as number) ?? 0,
    color: (data.color as string) ?? "#4a6fa5",
    notes: (data.notes as StoredNote[]) ?? [],
    noteCount: (data.noteCount as number) ?? ((data.notes as StoredNote[]) ?? []).length,
    createdAtMs: (data.createdAtMs as number) ?? 0,
    bpm: (data.bpm as number) ?? 120,
    hairpins: (data.hairpins as StoredHairpin[]) ?? [],
  };
}

export async function renameTranscription(uid: string, id: string, name: string) {
  await updateDoc(doc(db, "users", uid, "transcriptions", id), { name: name.trim() || "Untitled" });
}

/** Live list of the user's saved transcriptions; returns an unsubscribe fn. */
export function subscribeToTranscriptions(
  uid: string,
  onChange: (records: TranscriptionRecord[]) => void,
  onError?: (error: Error) => void
) {
  const q = query(transcriptionsRef(uid), orderBy("createdAtMs", "desc"));
  return onSnapshot(
    q,
    snapshot => onChange(snapshot.docs.map(d => toRecord(d.id, d.data()))),
    error => onError?.(error)
  );
}

export async function getUserTranscriptions(uid: string): Promise<TranscriptionRecord[]> {
  const snapshot = await getDocs(query(transcriptionsRef(uid), orderBy("createdAtMs", "desc")));
  return snapshot.docs.map(d => toRecord(d.id, d.data()));
}

export async function deleteTranscription(uid: string, id: string) {
  await deleteDoc(doc(db, "users", uid, "transcriptions", id));
}

/** Wipe every transcription plus the profile doc — used when deleting an
    account, and run while the user is still authenticated so rules allow it. */
export async function deleteAllUserData(uid: string) {
  const snapshot = await getDocs(transcriptionsRef(uid));
  const docs = snapshot.docs;

  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await deleteDoc(doc(db, "users", uid));
}
