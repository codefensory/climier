// Migration seed: tasks, decisions, gotchas for the vegsport migration.
import { emptyState } from "../state.mjs";

export const migrationSeed = (() => {
  const s = emptyState();
  s.initiatives.migration = { desc: "Migración de Supabase Edge Functions + Contentful a Elysia + Directus + Supabase Postgres" };

  // Decisions
  s.decisions.D1 = { id: "D1", title: "Directus vs Postgres crudo para CMS", applies_to: ["F3"] };
  s.decisions.D2 = { id: "D2", title: "Assets: Cloudflare R2 vs Supabase Storage", applies_to: ["F5"] };
  s.decisions.D3 = { id: "D3", title: "Cuándo mover Centeria (Turso/Mastra) al backend", applies_to: ["F6"] };
  s.decisions.D4 = { id: "D4", title: "Auth: Supabase (A) vs Elysia+Directus (B)", applies_to: ["F2"] };

  // F0 — preparation
  s.tasks["F0.T1"] = { id: "F0.T1", initiative: "migration", phase: "F0", title: "Crear repo monorepo skeleton (bun workspaces, turbo, docker-compose)", skills: ["node"], effort: "s", domain: "monorepo" };
  s.tasks["F0.T2"] = { id: "F0.T2", initiative: "migration", phase: "F0", title: "Scaffold apps/api con Elysia + Bun + endpoint /health", depends_on: ["F0.T1"], skills: ["bun", "elysia"], effort: "s", domain: "api" };
  s.tasks["F0.T3"] = { id: "F0.T3", initiative: "migration", phase: "F0", title: "Auth plugin en Elysia que valida JWT Supabase actual", depends_on: ["F0.T2"], skills: ["ts", "elysia", "jwt"], effort: "m", domain: "auth" };
  s.tasks["F0.T4"] = { id: "F0.T4", initiative: "migration", phase: "F0", title: "packages/shared con Zod schemas de progreso (WatchedVideo, WatchMark)", depends_on: ["F0.T1"], skills: ["ts", "zod"], effort: "m", domain: "shared" };

  // F1 — first edge function migrated (pilot)
  s.tasks["F1.T1"] = { id: "F1.T1", initiative: "migration", phase: "F1", title: "Migrar mark-video-watched a Elysia (mantener edge function como fallback, doble-escritura 1-2 semanas)", depends_on: ["F0.T3", "F0.T4"], skills: ["ts", "elysia"], effort: "m", domain: "api", acceptance: "Endpoint Elysia + edge function ambas responden idéntico; logs comparados en staging por 1 semana." };
  s.tasks["F1.T2"] = { id: "F1.T2", initiative: "migration", phase: "F1", title: "Smoke test E2E: ver video → marcar visto (en staging)", depends_on: ["F1.T1"], skills: ["ts", "e2e"], effort: "s", domain: "qa" };

  // F2 stub (depends on D4 + F1 done) — decompose when ready
  s.tasks["F2.OPEN"] = { id: "F2.OPEN", initiative: "migration", phase: "F2", title: "Descomponer F2: Auth + cursos + progreso (resolver D4 primero)", depends_on: ["F1.T2", "D4"] };

  // F3 stub
  s.tasks["F3.OPEN"] = { id: "F3.OPEN", initiative: "migration", phase: "F3", title: "Descomponer F3: Directus + migración CMS (resolver D1 primero)", depends_on: ["F2.OPEN", "D1"] };

  // F4 stub
  s.tasks["F4.OPEN"] = { id: "F4.OPEN", initiative: "migration", phase: "F4", title: "Descomponer F4: edge functions de negocio (migración dominio por dominio)", depends_on: ["F2.OPEN", "F3.OPEN"] };

  // F5 stub
  s.tasks["F5.OPEN"] = { id: "F5.OPEN", initiative: "migration", phase: "F5", title: "Descomponer F5: Submissions + R2 + Exámenes (resolver D2 primero)", depends_on: ["F4.OPEN", "D2"] };

  // F6 stub
  s.tasks["F6.OPEN"] = { id: "F6.OPEN", initiative: "migration", phase: "F6", title: "Descomponer F6: Centeria dentro del backend (resolver D3 primero)", depends_on: ["F2.OPEN", "D3"] };

  // F7 stub
  s.tasks["F7.OPEN"] = { id: "F7.OPEN", initiative: "migration", phase: "F7", title: "Descomponer F7: Webhooks + misiones + ranking + postgrado", depends_on: ["F4.OPEN"] };

  // F8 stub
  s.tasks["F8.OPEN"] = { id: "F8.OPEN", initiative: "migration", phase: "F8", title: "Descomponer F8: Frontend cutover (apps/web apunta a Elysia)", depends_on: ["F4.OPEN", "F5.OPEN", "F6.OPEN", "F7.OPEN"] };

  // F9 stub
  s.tasks["F9.OPEN"] = { id: "F9.OPEN", initiative: "migration", phase: "F9", title: "Descomponer F9: Hardening + deploy + cleanup de edge functions legacy", depends_on: ["F8.OPEN"] };

  // Gotchas
  s.gotchas.G1 = { id: "G1", initiative: "migration", title: "RLS no protege con Service Role", applies_to: ["domain:db"], mitigation: "Filtrar por user_id del JWT en repository.ts, no delegar en RLS." };
  s.gotchas.G2 = { id: "G2", initiative: "migration", title: "Triggers PL/pgSQL de coins/ranking se disparan al insertar desde Elysia igual que desde Edge Functions", applies_to: ["domain:coins"], mitigation: "Smoke test coins-reward-course antes del cutover; validar balance y ranking post-insert." };
  s.gotchas.G3 = { id: "G3", initiative: "migration", title: "useAuthGuard redirige a /login cuando no hay sesión", applies_to: ["domain:auth"], mitigation: "Cubrir con test E2E antes del cutover; no romper el redirect." };
  s.gotchas.G4 = { id: "G4", initiative: "migration", title: "Directus + Supabase comparten schema public; las tablas directus_* conviven con las de negocio", applies_to: ["domain:directus"], mitigation: "Documentar y prefijar para no confundir." };
  s.gotchas.G5 = { id: "G5", initiative: "migration", title: "Centeria usa Turso + Mastra; rate limiting funciona — no mover hasta que el backend esté estable", applies_to: ["domain:ai"], mitigation: "Mantener Centeria intacto hasta F6." };

  return s;
})();
