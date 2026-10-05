import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import BookOpen01Icon from "@hugeicons/core-free-icons/BookOpen01Icon";
import CashierIcon from "@hugeicons/core-free-icons/CashierIcon";
import CreditCardIcon from "@hugeicons/core-free-icons/CreditCardIcon";
import DeliveryTruck01Icon from "@hugeicons/core-free-icons/DeliveryTruck01Icon";
import Globe02Icon from "@hugeicons/core-free-icons/Globe02Icon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import Invoice01Icon from "@hugeicons/core-free-icons/Invoice01Icon";
import Location01Icon from "@hugeicons/core-free-icons/Location01Icon";
import Payment01Icon from "@hugeicons/core-free-icons/Payment01Icon";
import Rocket01Icon from "@hugeicons/core-free-icons/Rocket01Icon";
import SecurityCheckIcon from "@hugeicons/core-free-icons/SecurityCheckIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import Share01Icon from "@hugeicons/core-free-icons/Share01Icon";
import ShoppingCart01Icon from "@hugeicons/core-free-icons/ShoppingCart01Icon";
import Store01Icon from "@hugeicons/core-free-icons/Store01Icon";
import Store02Icon from "@hugeicons/core-free-icons/Store02Icon";
import Task01Icon from "@hugeicons/core-free-icons/Task01Icon";
import TaxesIcon from "@hugeicons/core-free-icons/TaxesIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import type { NavIconAssets, NavItem, NavSection } from "../types";

/** Navegación principal del sidebar. El primer item es "Home"; el resto va después del rótulo. */
export const appNavigation: NavItem[] = [
  { label: "Home", icon: "home" },
  { label: "Tasks", icon: "tasks" },
  { label: "Knowledges", icon: "knowledges" },
  { label: "Gates", icon: "gates" },
  { label: "Initiatives", icon: "iniciativas" },
  { label: "Settings", icon: "settings" },
  { label: "Account", icon: "account" },
];

/** Panel de settings, agrupado por secciones. */
export const sections: NavSection[] = [
  { title: "Store", items: [{ label: "Store details", icon: "store" }] },
  {
    title: "Plan & Billing",
    items: [
      { label: "Plan", icon: "plan" },
      { label: "Billing", icon: "billing" },
      { label: "Users and permissions", icon: "users" },
    ],
  },
  {
    title: "Store setup",
    items: [
      { label: "Payments", icon: "payments" },
      { label: "Checkout", icon: "checkout" },
      { label: "Shipping and delivery", icon: "shipping" },
      { label: "Taxes and duties", icon: "taxes" },
      { label: "Locations", icon: "locations" },
      { label: "Markets", icon: "markets" },
    ],
  },
  {
    title: "Sales Channels",
    items: [
      { label: "Online store", icon: "online" },
      { label: "Point of sale", icon: "pos" },
      { label: "Social and integrations", icon: "social" },
    ],
  },
];

/** Vocabulario de la navegación: nombre semántico → asset de Hugeicons. */
export const navIconAssets: NavIconAssets = {
  back: ArrowLeft01Icon,
  home: Home01Icon,
  tasks: Task01Icon,
  knowledges: BookOpen01Icon,
  gates: SecurityCheckIcon,
  iniciativas: Rocket01Icon,
  settings: Settings01Icon,
  account: UserIcon,
  store: Store01Icon,
  plan: CreditCardIcon,
  billing: Invoice01Icon,
  users: UserGroupIcon,
  payments: Payment01Icon,
  checkout: ShoppingCart01Icon,
  shipping: DeliveryTruck01Icon,
  taxes: TaxesIcon,
  locations: Location01Icon,
  markets: Globe02Icon,
  online: Store02Icon,
  pos: CashierIcon,
  social: Share01Icon,
};

/**
 * Ruta de cada vista del workspace.
 *
 * Esta tabla es la **única** fuente de verdad de las rutas: `App.tsx` arma las `<Route>` a partir de ella
 * y el sidebar pregunta por `pathForView()` para saber a dónde ir. Con los paths escritos en dos lugares
 * (una vez en las rutas, otra en los clicks del sidebar) se desincronizan sin que nada avise.
 *
 * `Settings` **no está acá** a propósito: no es una vista, es un panel sobre la vista actual. Si fuera una
 * ruta, abrirlo desde Tasks cambiaría la vista de atrás y el botón de volver llevaría a Home en vez de a
 * Tasks. Va como search param (`panel=settings`), que es lo único que conserva las dos cosas: la vista de
 * atrás y una URL que se puede recargar sin perder nada.
 *
 * `Projects` no está en `appNavigation` (hoy nada lo hace clickeable) pero sí tiene ruta: es lo que
 * convierte una página muerta en una página alcanzable, y de paso deja de ser un caso especial.
 */
export const navPaths: Record<string, string> = {
  Home: "/",
  Tasks: "/tasks",
  Knowledges: "/knowledges",
  Gates: "/gates",
  Initiatives: "/initiatives",
  Account: "/account",
  Projects: "/projects",
};

/** Clave del search param que abre el panel de settings. */
export const SETTINGS_PANEL_PARAM = "panel";

/**
 * Path de detalle de una tarea: `/tasks/<id>`.
 *
 * Existe como función y no como parte de `navPaths` porque no es una vista con nombre propio: es
 * "Tasks" con un id en el path. La tabla `navPaths` mapea vista→path, y acá hay dos paths para la
 * misma vista, así que el detalle se reconoce por forma.
 */
export function isTaskDetailPath(pathname: string): boolean {
  return /^\/tasks\/[^/]+$/.test(pathname.replace(/\/+$/, ""));
}

/** Path of a gate detail page: `/gates/<id>`. */
export function isGateDetailPath(pathname: string): boolean {
  return /^\/gates\/[^/]+$/.test(pathname.replace(/\/+$/, ""));
}

/** Ruta de una vista. Una vista desconocida cae en Home, igual que hoy cae en el placeholder. */
export const pathForView = (view: string): string => navPaths[view] ?? "/";

/**
 * Vista a la que corresponde un pathname, o `undefined` si no es ninguna.
 *
 * Normaliza la barra final porque `/tasks/` y `/tasks` son la misma vista.
 */
export function viewForPath(pathname: string): string | undefined {
  const clean = pathname.replace(/\/+$/, "") || "/";
  // El detalle mantiene activa la vista Tasks: el sidebar sigue marcando Tasks y el breadcrumb no
  // pierde el contexto al abrir una tarea.
  if (isTaskDetailPath(clean)) return "Tasks";
  if (isGateDetailPath(clean)) return "Gates";
  return Object.keys(navPaths).find((view) => navPaths[view] === clean);
}
