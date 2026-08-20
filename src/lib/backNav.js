// Deterministic tab-aware back navigation helper.
// The Header back button never uses raw history (navigate(-1)), which can jump
// across bottom-tab history. Instead it resolves a single logical parent route.

// All in-app routes registered in src/App.jsx. Used to validate explicit returnTo
// targets so a stale/invalid value can never navigate off-app.
export const VALID_ROUTES = [
  '/', '/logs', '/trip', '/inspection', '/more',
  '/compliance', '/assistant', '/documents', '/engine-tests',
  '/vehicle-inspection', '/log-assistant',
  '/onboarding', '/login', '/register', '/forgot-password', '/reset-password',
];

// Bottom-tab root routes.
export const TAB_ROOTS = ['/', '/logs', '/trip', '/inspection', '/more'];

// Logical parent (owning bottom tab) for each child route.
const PARENT_MAP = {
  '/compliance': '/',
  '/assistant': '/',
  '/log-assistant': '/',
  '/documents': '/more',
  '/vehicle-inspection': '/more',
  '/engine-tests': '/more',
};

export function isValidRoute(route) {
  return typeof route === 'string' && VALID_ROUTES.includes(route);
}

// Resolve the back target for a screen.
// 1. Honor an explicit returnTo (router state or ?returnTo= query) only when it
//    points to a valid in-app route.
// 2. Otherwise use the deterministic parent mapping for the current path.
// 3. Fall back to the Today tab root.
export function getBackTarget(pathname, returnTo) {
  if (isValidRoute(returnTo)) return returnTo;
  return PARENT_MAP[pathname] || '/';
}