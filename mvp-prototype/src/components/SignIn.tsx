import { useState } from "react";
import type { FormEvent } from "react";
import veraLogo from "../assets/vera-logo.png";
import { signInWithPassword } from "../api/client";

// TEMPORARY demo sign-in, shown when the review API runs with
// REVIEW_AUTH_MODE=password. See packages/review-api/src/demo-sign-in.ts.

export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await signInWithPassword(email.trim(), password);
      location.reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-in failed. Try again.");
      setBusy(false);
    }
  }

  return (
    <main id="main" className="sign-in-page">
      <div className="sign-in-card">
        <h1 className="sign-in-brand">
          <img src={veraLogo} alt="Vera" />
        </h1>
        <form className="sign-in-form" onSubmit={(e) => void submit(e)} noValidate>
          <h2>Sign in</h2>
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
          <div className="field">
            <label htmlFor="sign-in-email">Email</label>
            <input
              id="sign-in-email"
              type="email"
              autoComplete="username"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="sign-in-password">Password</label>
            <input
              id="sign-in-password"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="btn sign-in-submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
