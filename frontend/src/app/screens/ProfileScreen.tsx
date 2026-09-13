import { useState } from "react";
import type { User } from "firebase/auth";
import { motion } from "motion/react";
import { KeyRound, LogOut, Trash2, UserCog, Check } from "lucide-react";

import { authErrorMessage, changePassword, deleteAccount, logOut, setDisplayName } from "../../auth";
import { deleteAllUserData } from "../../transcriptions";
import { updateUserProfile } from "../../users";
import { Btn, Field, NavBar, Notice, Screen, Spinner } from "../components/Shell";
import { fmtDate } from "../lib/score";

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-[#0e0e14] border border-white/6 p-6">
      <div className="flex items-center gap-2.5 mb-5">
        <span className="text-[#f0c040]">{icon}</span>
        <h2 style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0ece4] text-[17px] font-medium">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

export default function ProfileScreen({ user, projectCount, onBack, onProfileChange }: {
  user: User; projectCount: number; onBack: () => void; onProfileChange?: () => void;
}) {
  /* ─── display name ─── */
  const [name, setName] = useState(user.displayName ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);

  /* ─── password ─── */
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  /* ─── deletion ─── */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePw, setDeletePw] = useState("");
  const [deleteWord, setDeleteWord] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  async function saveName() {
    setNameErr(null); setNameMsg(null); setNameBusy(true);
    try {
      await setDisplayName(name);
      await updateUserProfile(user.uid, { displayName: name.trim() });
      setNameMsg("Name updated.");
      onProfileChange?.();
    } catch (err) {
      setNameErr(authErrorMessage(err));
    } finally {
      setNameBusy(false);
    }
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwErr(null); setPwMsg(null);

    if (!currentPw) { setPwErr("Enter your current password."); return; }
    if (newPw.length < 6) { setPwErr("New passwords need to be at least 6 characters."); return; }
    if (newPw !== confirmPw) { setPwErr("Those passwords don't match."); return; }
    if (newPw === currentPw) { setPwErr("That's already your password."); return; }

    setPwBusy(true);
    try {
      await changePassword(currentPw, newPw);
      setPwMsg("Password changed.");
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    } catch (err) {
      setPwErr(authErrorMessage(err));
    } finally {
      setPwBusy(false);
    }
  }

  /* Firestore documents go first, while the user is still authenticated and
     the security rules still allow the writes. Deleting the auth account
     first would strand the data with no way to reach it. */
  async function submitDelete(e: React.FormEvent) {
    e.preventDefault();
    setDeleteErr(null);

    if (deleteWord.trim().toUpperCase() !== "DELETE") {
      setDeleteErr('Type DELETE to confirm.');
      return;
    }
    if (!deletePw) { setDeleteErr("Enter your password to confirm."); return; }

    setDeleteBusy(true);
    try {
      await deleteAccount(deletePw, async signedIn => {
        await deleteAllUserData(signedIn.uid);
      });
      // The auth listener in App.tsx drops back to the sign-in screen.
    } catch (err) {
      setDeleteErr(authErrorMessage(err));
      setDeleteBusy(false);
    }
  }

  const joined = user.metadata?.creationTime ? fmtDate(Date.parse(user.metadata.creationTime)) : "";

  return (
    <Screen>
      <NavBar onBack={onBack} title="Profile" />
      <div className="flex-1 overflow-y-auto px-6 py-8" style={{ scrollbarWidth: "none" }}>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24 }}
          className="max-w-lg mx-auto flex flex-col gap-4"
        >
          {/* Identity */}
          <div className="flex items-center gap-4 mb-2">
            <div className="w-14 h-14 rounded-2xl bg-[#f0c040]/15 border border-[#f0c040]/25 flex items-center justify-center text-2xl text-[#f0c040]"
              style={{ fontFamily: "Fraunces,serif" }}>
              {(user.displayName || user.email || "?").trim().charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0ece4] text-xl truncate">
                {user.displayName || "Your account"}
              </p>
              <p className="text-[#9490a0] text-sm truncate">{user.email}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-2">
            <div className="rounded-2xl bg-[#0e0e14] border border-white/6 p-4">
              <p className="text-[#f0c040] text-2xl" style={{ fontFamily: "Fraunces,serif" }}>{projectCount}</p>
              <p className="text-[#5e5a70] text-[11px] uppercase tracking-widest mt-1">Transcriptions</p>
            </div>
            <div className="rounded-2xl bg-[#0e0e14] border border-white/6 p-4">
              <p className="text-[#f0ece4] text-sm mt-1.5">{joined || "—"}</p>
              <p className="text-[#5e5a70] text-[11px] uppercase tracking-widest mt-1.5">Member since</p>
            </div>
          </div>

          {/* Display name */}
          <Card title="Display name" icon={<UserCog size={16} />}>
            <div className="flex flex-col gap-3">
              <Field
                label="Name"
                type="text"
                placeholder="Your name"
                value={name}
                onChange={e => { setName(e.target.value); setNameMsg(null); }}
              />
              {nameErr && <Notice kind="error">{nameErr}</Notice>}
              {nameMsg && <Notice kind="success">{nameMsg}</Notice>}
              <Btn variant="secondary" onClick={saveName}
                disabled={nameBusy || name.trim() === (user.displayName ?? "").trim()}
                className="self-start">
                {nameBusy ? <><Spinner />Saving…</> : <><Check size={14} />Save name</>}
              </Btn>
            </div>
          </Card>

          {/* Password */}
          <Card title="Change password" icon={<KeyRound size={16} />}>
            <form onSubmit={submitPassword} className="flex flex-col gap-3">
              <Field label="Current password" type="password" autoComplete="current-password"
                placeholder="••••••••" value={currentPw} onChange={e => setCurrentPw(e.target.value)} />
              <Field label="New password" type="password" autoComplete="new-password"
                placeholder="At least 6 characters" value={newPw} onChange={e => setNewPw(e.target.value)} />
              <Field label="Confirm new password" type="password" autoComplete="new-password"
                placeholder="Repeat new password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} />
              {pwErr && <Notice kind="error">{pwErr}</Notice>}
              {pwMsg && <Notice kind="success">{pwMsg}</Notice>}
              <Btn type="submit" variant="secondary" disabled={pwBusy} className="self-start">
                {pwBusy ? <><Spinner />Updating…</> : "Update password"}
              </Btn>
            </form>
          </Card>

          {/* Sign out */}
          <Card title="Session" icon={<LogOut size={16} />}>
            <p className="text-[#9490a0] text-sm mb-4 leading-relaxed">
              Signing out keeps everything saved — your transcriptions are waiting when you return.
            </p>
            <Btn variant="secondary" onClick={() => { void logOut(); }} icon={<LogOut size={14} />}>
              Sign out
            </Btn>
          </Card>

          {/* Danger zone */}
          <Card title="Delete account" icon={<Trash2 size={16} />}>
            {!confirmingDelete ? (
              <>
                <p className="text-[#9490a0] text-sm mb-4 leading-relaxed">
                  Permanently deletes your account and all {projectCount} saved
                  {projectCount === 1 ? " transcription" : " transcriptions"}. This can't be undone.
                </p>
                <Btn variant="danger" onClick={() => setConfirmingDelete(true)} icon={<Trash2 size={13} />}>
                  Delete my account
                </Btn>
              </>
            ) : (
              <form onSubmit={submitDelete} className="flex flex-col gap-3">
                <p className="text-[#e8917c] text-sm leading-relaxed">
                  This erases your account and every saved transcription. Confirm with your password.
                </p>
                <Field label="Password" type="password" autoComplete="current-password"
                  placeholder="Your password" value={deletePw} onChange={e => setDeletePw(e.target.value)} />
                <Field label='Type DELETE to confirm' type="text" placeholder="DELETE"
                  value={deleteWord} onChange={e => setDeleteWord(e.target.value)} />
                {deleteErr && <Notice kind="error">{deleteErr}</Notice>}
                <div className="flex gap-3">
                  <Btn type="submit" variant="danger" disabled={deleteBusy}>
                    {deleteBusy ? <><Spinner />Deleting…</> : "Permanently delete"}
                  </Btn>
                  <Btn variant="ghost" onClick={() => {
                    setConfirmingDelete(false); setDeletePw(""); setDeleteWord(""); setDeleteErr(null);
                  }}>
                    Cancel
                  </Btn>
                </div>
              </form>
            )}
          </Card>
        </motion.div>
      </div>
    </Screen>
  );
}
