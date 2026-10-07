import { createSignal, Show } from "solid-js";
import { useSession } from "../modules/core";

export function LoginPage() {
  const session = useSession();
  const [password, setPassword] = createSignal("");

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    await session.login(password());
  };

  return (
    <main data-testid="login-page" class="flex min-h-screen items-center justify-center bg-canvas px-6 py-12 text-ink">
      <section class="w-full max-w-[380px] rounded-[14px] bg-surface p-7 shadow-[var(--elevation-panel)]">
        <div class="mb-7"><h1 class="text-[22px] font-semibold tracking-[-0.03em]">Sign in to Climier</h1><p class="mt-2 text-[13px] leading-5 text-muted">Use your server password to continue.</p></div>
        <form class="space-y-4" onSubmit={submit}>
          <label class="block"><span class="mb-1.5 block text-[13px] font-medium">Password</span><input data-testid="login-password" type="password" value={password()} onInput={(event) => setPassword(event.currentTarget.value)} autocomplete="current-password" required class="h-10 w-full rounded-[9px] bg-subtle px-3 text-[14px] outline-none transition-colors focus-visible:outline-2 focus-visible:outline-ink" /></label>
          <Show when={session.error()}>{(message) => <p role="alert" class="text-[13px] text-tone-red-ink">{message()}</p>}</Show>
          <button data-testid="login-submit" type="submit" disabled={session.busy()} class="h-10 w-full rounded-[9px] bg-ink px-4 text-[14px] font-medium text-on-strong transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60">{session.busy() ? "Signing in…" : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}
