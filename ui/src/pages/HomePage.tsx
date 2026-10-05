/**
 * Home: tres tarjetas de resumen y "Up next". Los números están escritos a mano porque todavía no hay
 * backend; cuando lo haya esto pasa a `createResource` (Fase 8).
 */
import { PageFrame } from "./PageFrame";

export function HomePage() {
  return (
    <PageFrame>
      <div>
        <p class="mb-5 text-[14px] text-muted">A clear view of what’s moving across your workspace.</p>
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <section class="rounded-[12px] border border-line p-5"><p class="text-[13px] text-muted">Open tasks</p><p class="mt-3 text-[28px] font-semibold tracking-[-0.04em]">12</p><p class="mt-1 text-[12px] text-faint">Across your projects</p></section>
          <section class="rounded-[12px] border border-line p-5"><p class="text-[13px] text-muted">Active projects</p><p class="mt-3 text-[28px] font-semibold tracking-[-0.04em]">4</p><p class="mt-1 text-[12px] text-faint">Moving forward this week</p></section>
          <section class="rounded-[12px] border border-line p-5"><p class="text-[13px] text-muted">Completed</p><p class="mt-3 text-[28px] font-semibold tracking-[-0.04em]">8</p><p class="mt-1 text-[12px] text-faint">Tasks finished this month</p></section>
        </div>
        <section class="mt-5 rounded-[12px] border border-line p-5"><h2 class="text-[14px] font-medium">Up next</h2><p class="mt-2 text-[13px] text-muted">Your workspace overview will keep what matters close at hand.</p></section>
      </div>
    </PageFrame>
  );
}
