// Shared state across views: latest catalog received from server and derived data.
import { api } from './api.js';

export const store = {
  state: null,
  byId: new Map(),
  error: null,
  selected: null,
  listeners: new Set(),
};

export const subscribe = (fn) => {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
};
const emit = () => store.listeners.forEach((fn) => fn(store));

export async function refresh() {
  try {
    const st = await api.state();
    store.state = st;
    store.byId = new Map([...st.skills, ...st.agents].map((e) => [e.id, e]));
    store.error = null;
    if (store.selected && !store.byId.has(store.selected)) store.selected = null;
  } catch (e) {
    store.error = e.message;
  }
  emit();
}

export function select(id) {
  store.selected = id && store.byId.has(id) ? id : null;
  emit();
}

export const all = () => (store.state ? [...store.state.skills, ...store.state.agents] : []);
export const catsOf = (e) => (e.categories.length ? e.categories : e.inferredCategories);
export const catLabel = (id) => store.state?.categories?.[id]?.label ?? id;

/** Agent→skill edges (declared or assigned) involving an entity. */
export function links(id) {
  const edges = store.state?.edges ?? [];
  return {
    uses: edges.filter((e) => e.type !== 'depends' && e.from === id),
    usedBy: edges.filter((e) => e.type !== 'depends' && e.to === id),
    dependsOn: edges.filter((e) => e.type === 'depends' && e.from === id),
    neededBy: edges.filter((e) => e.type === 'depends' && e.to === id),
  };
}

export const shortName = (id) => id.replace(/^(skill|agent):/, '');
