import { useState } from "react";
import { motion } from "motion/react";
import { Music2, Mail, Lock, User as UserIcon, ArrowLeft } from "lucide-react";

import { authErrorMessage, sendPasswordReset, signIn, signUp } from "../../auth";
import { Btn, Field, Notice, Screen, Spinner } from "../components/Shell";

type Mode = "signin" | "signup" | "reset";

const COPY: Record<Mode, { title: string; sub: string; action: string }> = {
  signin: { title: "Welcome back",    sub: "Sign in to reach your transcriptions.",             action: "Sign In" },
  signup: { title: "Create account",  sub: "Start turning recordings into notation.",           action: "Create Account" },
  reset:  { title: "Reset password",  sub: "We'll email you a link to set a new password.",     action: "Send Reset Link" },
};

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setPassword("");
    setConfirm("");
  }

  /** Catch the obvious problems here so Firebase round-trips are only spent
      on real failures, and the messages stay specific. */
  function localValidationError(): string | null {
    if (!email.trim()) return "Please enter your email address.";
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return "That doesn't look like a valid email address.";
    if (mode === "reset") return null;
    if (!password) return "Please enter a password.";
    if (mode === "signup") {
      if (password.length < 6) return "Passwords need to be at least 6 characters.";
      if (password !== confirm) return "Those passwords don't match.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);

    const problem = localValidationError();
    if (problem) { setError(problem); return; }

    setBusy(true);
    try {
      if (mode === "signup") {
        await signUp(email, password, name);
        // onAuthStateChanged in App.tsx takes over from here.
      } else if (mode === "signin") {
        await signIn(email, password);
      } else {
        await sendPasswordReset(email);
        setNotice(`If an account exists for ${email.trim()}, a reset link is on its way.`);
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[mode];

  return (
    <Screen>
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-14">
        {/* Brand */}
        <div className="flex items-center gap-2.5 mb-9">
          <div className="w-9 h-9 rounded-xl bg-[#3b82f6] flex items-center justify-center shadow-[0_0_16px_rgba(59,130,246,0.55)]">
            <Music2 size={18} className="text-white" />
          </div>
          <span style={{ fontFamily: "Fraunces,serif" }} className="text-[#f0ece4] font-medium tracking-wide text-2xl">
            Tabify
          </span>
        </div>

        <motion.div
          key={mode}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.24, ease: [0.4, 0, 0.2, 1] }}
          className="w-full max-w-sm rounded-3xl bg-[#0e0e14] border border-white/6 p-7 shadow-[0_24px_72px_rgba(0,0,0,0.6)]"
        >
          {mode === "reset" && (
            <button onClick={() => switchMode("signin")}
              className="flex items-center gap-1.5 text-[#9490a0] hover:text-[#f0ece4] transition-colors text-sm mb-5">
              <ArrowLeft size={14} /><span>Back to sign in</span>
            </button>
          )}

          <h1 style={{ fontFamily: "Fraunces,serif" }} className="text-2xl text-[#f0ece4] mb-1.5">
            {copy.title}
          </h1>
          <p className="text-[#9490a0] text-sm mb-6 leading-relaxed">{copy.sub}</p>

          {/* noValidate: our own checks own the messaging, so the browser's native
              validation bubble never preempts the styled inline error. */}
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
            {mode === "signup" && (
              <div className="relative">
                <Field
                  label="Name (optional)"
                  type="text"
                  autoComplete="name"
                  placeholder="Your name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="pl-10"
                />
                <UserIcon size={14} className="absolute left-3.5 bottom-3.5 text-[#5e5a70] pointer-events-none" />
              </div>
            )}

            <div className="relative">
              <Field
                label="Email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="pl-10"
              />
              <Mail size={14} className="absolute left-3.5 bottom-3.5 text-[#5e5a70] pointer-events-none" />
            </div>

            {mode !== "reset" && (
              <div className="relative">
                <Field
                  label="Password"
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  placeholder={mode === "signup" ? "At least 6 characters" : "Your password"}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="pl-10"
                />
                <Lock size={14} className="absolute left-3.5 bottom-3.5 text-[#5e5a70] pointer-events-none" />
              </div>
            )}

            {mode === "signup" && (
              <div className="relative">
                <Field
                  label="Confirm password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat your password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  className="pl-10"
                />
                <Lock size={14} className="absolute left-3.5 bottom-3.5 text-[#5e5a70] pointer-events-none" />
              </div>
            )}

            {error && <Notice kind="error">{error}</Notice>}
            {notice && <Notice kind="success">{notice}</Notice>}

            <Btn type="submit" variant="primary" disabled={busy} className="w-full justify-center mt-1 py-3">
              {busy ? <><Spinner />Working…</> : copy.action}
            </Btn>
          </form>

          {mode === "signin" && (
            <button onClick={() => switchMode("reset")}
              className="mt-4 w-full text-center text-[#9490a0] hover:text-[#f0ece4] transition-colors text-xs">
              Forgot your password?
            </button>
          )}
        </motion.div>

        {mode !== "reset" && (
          <p className="text-[#5e5a70] text-sm mt-6">
            {mode === "signin" ? "New to Tabify?" : "Already have an account?"}{" "}
            <button
              onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}
              className="text-[#f0c040] hover:text-[#f8cc50] transition-colors font-medium"
            >
              {mode === "signin" ? "Create an account" : "Sign in"}
            </button>
          </p>
        )}
      </div>
    </Screen>
  );
}
