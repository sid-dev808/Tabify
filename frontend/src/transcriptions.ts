import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "./firebase";

export interface TranscriptionRecord {
  uid: string;
  jobId: string;
  instrument: string;
  duration: number;
}

export async function saveTranscription(record: TranscriptionRecord) {
  return addDoc(collection(db, "transcriptions"), {
    ...record,
    createdAt: serverTimestamp(),
  });
}

export async function getUserTranscriptions(uid: string) {
  const q = query(
    collection(db, "transcriptions"),
    where("uid", "==", uid),
    orderBy("createdAt", "desc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
