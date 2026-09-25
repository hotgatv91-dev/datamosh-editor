import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    // Some embedders resize the viewport without the media query list emitting
    // a change event, which used to leave the shell stuck on the layout of the
    // previous size. Re-reading on resize costs nothing and always converges.
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    return () => {
      list.removeEventListener('change', onChange);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
    };
  }, [query]);

  return matches;
}

/**
 * The mobile layout is chosen by input capability as well as width: a small
 * laptop window should keep the desktop layout, a phone or tablet must not.
 */
export function useIsMobile(): boolean {
  const narrow = useMediaQuery('(max-width: 860px)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const smallViewport = useMediaQuery('(max-width: 1024px) and (max-height: 900px)');
  return narrow || (coarse && smallViewport);
}
