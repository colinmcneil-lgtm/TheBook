import { createContext, useContext, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './lib.js';

export const AppContext = createContext({ version: 0 });
export const useApp = () => useContext(AppContext);

/**
 * Fetch `path` and refetch whenever it changes or anything in the workspace is saved (ctx.bump()).
 * Keeps showing the previous result while a new filter loads, but never shows data from a different endpoint.
 */
export function useApi(path) {
  const { version } = useApp();
  const [state, setState] = useState({ key: null, data: null, error: null });
  const key = path ? path.split('?')[0] : null;
  useEffect(() => {
    if (!path) return undefined;
    let live = true;
    api.get(path)
      .then((data) => live && setState({ key, data, error: null }))
      .catch((err) => live && setState({ key, data: null, error: err.message }));
    return () => { live = false; };
  }, [path, version]);
  const fresh = state.key === key;
  return { data: fresh ? state.data : null, error: fresh ? state.error : null, loading: !fresh };
}

/** Open (or close, with null) the candidate drawer from anywhere; it lives in the URL as ?c=<application id>. */
export function useOpenCandidate() {
  const [params, setParams] = useSearchParams();
  return (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('c', id);
    else next.delete('c');
    setParams(next);
  };
}
