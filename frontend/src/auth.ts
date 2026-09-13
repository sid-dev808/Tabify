import {
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  updateProfile,
  type User,
} from "firebase/auth";
import { auth } from "./firebase";

/* ─── SESSION ─── */

export async function signUp(email: string, password: string, displayName?: string) {
  const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
  if (displayName?.trim()) {
    await updateProfile(credential.user, { displayName: displayName.trim() });
  }
  return credential;
}

export function signIn(email: string, password: string) {
  return signInWithEmailAndPassword(auth, email.trim(), password);
}

export function logOut() {
  return signOut(auth);
}

export function watchAuthState(callback: (user: User | null) => void) {
  return onAuthStateChanged(auth, callback);
}

export function currentUser() {
  return auth.currentUser;
}

/* ─── ACCOUNT MANAGEMENT ─── */

export function sendPasswordReset(email: string) {
  return sendPasswordResetEmail(auth, email.trim());
}

export async function setDisplayName(displayName: string) {
  const user = auth.currentUser;
  if (!user) throw new Error("You are not signed in.");
  await updateProfile(user, { displayName: displayName.trim() });
}

/* Firebase requires a recent login before password changes and account
   deletion, so both flows ask for the current password and reauthenticate
   first. That is what turns the generic "requires-recent-login" error into
   something the user can actually act on. */
async function reauthenticate(currentPassword: string) {
  const user = auth.currentUser;
  if (!user?.email) throw new Error("You are not signed in.");
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
  return user;
}

export async function changePassword(currentPassword: string, newPassword: string) {
  const user = await reauthenticate(currentPassword);
  await updatePassword(user, newPassword);
}

/** Reauthenticate, then run any cleanup (e.g. deleting Firestore docs)
    while the user still has permission, then delete the auth account. */
export async function deleteAccount(
  currentPassword: string,
  beforeDelete?: (user: User) => Promise<void>
) {
  const user = await reauthenticate(currentPassword);
  if (beforeDelete) await beforeDelete(user);
  await deleteUser(user);
}

/* ─── ERROR MESSAGES ─── */

const AUTH_ERRORS: Record<string, string> = {
  "auth/email-already-in-use": "That email already has an account. Try signing in instead.",
  "auth/invalid-email": "That doesn't look like a valid email address.",
  "auth/weak-password": "Passwords need to be at least 6 characters.",
  "auth/missing-password": "Please enter a password.",
  "auth/user-not-found": "No account found with that email.",
  "auth/wrong-password": "Incorrect password.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/invalid-login-credentials": "Email or password is incorrect.",
  "auth/too-many-requests": "Too many attempts. Wait a minute and try again.",
  "auth/network-request-failed": "Network error — check your connection and try again.",
  "auth/requires-recent-login": "Please re-enter your password to confirm this change.",
  "auth/user-disabled": "This account has been disabled.",
  "auth/operation-not-allowed":
    "Email/password sign-in isn't enabled yet. Turn it on in Firebase console > Authentication > Sign-in method.",
  "auth/api-key-not-valid": "Your Firebase API key is wrong — check frontend/.env.local.",
  "auth/configuration-not-found":
    "Firebase Authentication isn't set up for this project yet. Enable Email/Password in the Firebase console.",
};

/** Turn a Firebase error into something worth showing a user. */
export function authErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (AUTH_ERRORS[code]) return AUTH_ERRORS[code];
  if (error instanceof Error && error.message) {
    return error.message.replace(/^Firebase:\s*/, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "");
  }
  return "Something went wrong. Please try again.";
}
