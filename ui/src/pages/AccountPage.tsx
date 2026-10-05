/**
 * Account: los datos del perfil, en filas separadas por línea.
 */
import { PageFrame } from "./PageFrame";

export function AccountPage() {
  return (
    <PageFrame>
      <section aria-label="Profile fields" class="max-w-[620px] divide-y divide-line rounded-[12px] border border-line px-5">
                        <div class="py-4"><p class="text-[12px] text-muted">Name</p><p class="mt-1 text-[14px]">Alex Morgan</p></div><div class="py-4"><p class="text-[12px] text-muted">Email</p><p class="mt-1 text-[14px]">alex@climier.com</p></div><div class="py-4"><p class="text-[12px] text-muted">Role</p><p class="mt-1 text-[14px]">Workspace administrator</p></div>
      </section>
    </PageFrame>
  );
}
