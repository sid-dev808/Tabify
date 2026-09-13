import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import type { User } from "firebase/auth";
import { db } from "./firebase";

/* Every Firebase Auth user gets a matching Firestore document at users/{uid}.
   That doc is what links the auth database to Firestore: it is the parent of
   the user's transcriptions subcollection and the anchor for the security
   rules, which only ever allow request.auth.uid == userId. */

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAtMs: number;
}

export function userDocRef(uid: string) {
  return doc(db, "users", uid);
}

/** Create the profile doc on first sign-in, refresh it on later ones. */
export async function ensureUserProfile(user: User) {
  const ref = userDocRef(user.uid);
  const snapshot = await getDoc(ref);

  if (!snapshot.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      email: user.email ?? "",
      displayName: user.displayName ?? "",
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      lastSeenAt: serverTimestamp(),
    });
    return;
  }

  await setDoc(
    ref,
    {
      email: user.email ?? "",
      displayName: user.displayName ?? snapshot.data().displayName ?? "",
      lastSeenAt: serverTimestamp(),
    },
    { merge: true }
  );
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snapshot = await getDoc(userDocRef(uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  return {
    uid,
    email: data.email ?? "",
    displayName: data.displayName ?? "",
    createdAtMs: data.createdAtMs ?? 0,
  };
}

export async function updateUserProfile(uid: string, fields: { displayName?: string }) {
  await setDoc(userDocRef(uid), { ...fields, updatedAt: serverTimestamp() }, { merge: true });
}
