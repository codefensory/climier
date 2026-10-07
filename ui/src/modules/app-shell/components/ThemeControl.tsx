import MonitorDotIcon from "@hugeicons/core-free-icons/MonitorDotIcon";
import Moon02Icon from "@hugeicons/core-free-icons/Moon02Icon";
import Sun01Icon from "@hugeicons/core-free-icons/Sun01Icon";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { HugeIcon, useTheme } from "../../core";
import type { HugeIconAsset, ThemePreference } from "../../core";
import { Button, MenuOption, PopoverSurface } from "../../ui";

const MENU_WIDTH = 180;
const MENU_HEIGHT = 120;

const THEME_OPTIONS: ReadonlyArray<{ preference: ThemePreference; label: string; icon: HugeIconAsset }> = [
  { preference: "system", label: "System", icon: MonitorDotIcon },
  { preference: "light", label: "Light", icon: Sun01Icon },
  { preference: "dark", label: "Dark", icon: Moon02Icon },
];

function menuCoordinates(trigger: HTMLButtonElement) {
  const rect = trigger.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 12));
  const below = rect.bottom + 6;
  const top = below + MENU_HEIGHT <= window.innerHeight - 12 ? below : Math.max(12, rect.top - MENU_HEIGHT - 6);
  return { left, top };
}

export function ThemeControl() {
  const theme = useTheme();
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal({ left: 0, top: 0 });
  let trigger: HTMLButtonElement | undefined;

  const place = () => {
    if (trigger) setPosition(menuCoordinates(trigger));
  };

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger?.focus();
  };

  const toggle = (event: MouseEvent) => {
    trigger = event.currentTarget as HTMLButtonElement;
    if (open()) {
      close();
      return;
    }
    setOpen(true);
    place();
  };

  const select = (preference: ThemePreference) => {
    theme.setPreference(preference);
    close();
  };

  onMount(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (!open()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[data-testid="theme-menu"]') && !target.closest("[data-theme-trigger]")) close();
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open()) close(true);
    };
    const reposition = () => {
      if (open()) place();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    window.addEventListener("resize", reposition);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
      window.removeEventListener("resize", reposition);
    });
  });

  return (
    <>
      <Button variant="icon" data-theme-trigger="" aria-label="Theme" aria-haspopup="menu" aria-expanded={open()} aria-controls="theme-menu" onClick={toggle}>
        <HugeIcon icon={THEME_OPTIONS.find((option) => option.preference === theme.preference())?.icon ?? MonitorDotIcon} class="h-4 w-4" strokeWidth="1.8" />
      </Button>
      <PopoverSurface variant="menuNarrow" open={open()} left={position().left} top={position().top} role="menu" label="Theme" id="theme-menu" testId="theme-menu">
        <For each={THEME_OPTIONS}>{(option) => (
          <MenuOption
            role="menuitemradio"
            selected={theme.preference() === option.preference}
            onSelect={() => select(option.preference)}
            leading={<span class="flex h-5 w-5 shrink-0 items-center justify-center"><HugeIcon icon={option.icon} class="h-3.5 w-3.5" strokeWidth="1.8" /></span>}
            label={<span>{option.label}</span>}
          />
        )}</For>
      </PopoverSurface>
    </>
  );
}
