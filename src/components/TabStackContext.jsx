import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const TAB_ROOTS = ['/', '/logs', '/trip', '/inspection', '/more'];

// Fallback ownership for a sub-page when the app is deep-linked directly.
// During normal in-app navigation the active tab is tracked dynamically.
const SUBPAGE_OWNER = {
  '/vehicle-inspection': '/more',
  '/documents': '/more',
  '/engine-tests': '/more',
  '/ifta': '/more',
  '/compliance': '/',
  '/assistant': '/',
  '/log-assistant': '/',
};

const TabStackContext = createContext(null);

function initialTabFor(path) {
  if (TAB_ROOTS.includes(path)) return path;
  return SUBPAGE_OWNER[path] || '/';
}

export function TabStackProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState(() => initialTabFor(location.pathname));
  const [stacks, setStacks] = useState(() => {
    const init = {};
    TAB_ROOTS.forEach((t) => { init[t] = t; });
    init[initialTabFor(location.pathname)] = location.pathname;
    return init;
  });

  // Save the current path under the active tab so the tab can be restored later.
  useEffect(() => {
    const path = location.pathname;
    if (TAB_ROOTS.includes(path)) {
      setActiveTab(path);
      setStacks((s) => ({ ...s, [path]: path }));
    } else {
      setStacks((s) => ({ ...s, [activeTab]: path }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const navigateTab = useCallback((tabRoot) => {
    setActiveTab((current) => {
      if (current === tabRoot) {
        // Tapping the already-active tab resets it to its default root page.
        navigate(tabRoot);
        return tabRoot;
      }
      const saved = stacks[tabRoot];
      const target = saved && saved !== tabRoot ? saved : tabRoot;
      navigate(target);
      return tabRoot;
    });
  }, [stacks, navigate]);

  return (
    <TabStackContext.Provider value={{ activeTab, stacks, navigateTab }}>
      {children}
    </TabStackContext.Provider>
  );
}

export function useTabStack() {
  return useContext(TabStackContext);
}