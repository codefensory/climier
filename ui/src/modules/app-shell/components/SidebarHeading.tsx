import type { JSX } from "solid-js";

export type SidebarHeadingProps = {
  children: JSX.Element;
};

/** Rótulo de grupo del sidebar ("Workspace", "Store setup", …). */
export function SidebarHeading(props: SidebarHeadingProps) {
  return <h2 class="mb-1 px-2 text-[12px] font-medium leading-5 text-faint">{props.children}</h2>;
}
