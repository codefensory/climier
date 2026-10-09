import logoDark from '@/assets/climier-logo-dark.png';
import logoLight from '@/assets/climier-logo.png';

/**
 * The Climier wordmark, theme aware.
 *
 * The PNG pair is the same asset the UI shell ships. The theme switch happens
 * through the `.climier-logo-*` CSS rules in `styles/app.css` (class-based dark
 * mode from next-themes), not through Tailwind's `dark:` variant, so the mark
 * also resolves correctly before hydration.
 */
export function ClimierLogo({ className }: { className?: string }) {
  return (
    <>
      <img src={logoLight} alt="" className={`climier-logo-light ${className ?? ''}`} />
      <img src={logoDark} alt="" aria-hidden="true" className={`climier-logo-dark ${className ?? ''}`} />
      <span className="sr-only">Climier</span>
    </>
  );
}
