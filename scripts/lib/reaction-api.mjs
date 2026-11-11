// Every worker used to send Reaction Lab traffic straight to the standalone
// Vercel deployment. That deployment is retired: it answers every request with
// HTTP 402 `DEPLOYMENT_DISABLED`, and because the URL is baked into a workflow
// env the failure looks like an empty queue rather than a dead host.
//
// The live control plane is the CX33 Reaction Lab container, reached through
// the MAM gateway. MAM rewrites /api/reaction/* and /api/clipper/* to it and
// Reaction Lab's middleware validates the worker bearer.
//
// A stale MAM_BASE in a local shell or a copied .env.local must not resurrect
// the dead host, so the resolver treats the retired origins as unset.
export const LIVE_REACTION_API = 'https://www.21media.online';

const RETIRED_ORIGINS = [
  'https://reaction-lab-coral.vercel.app',
  'https://reaction-lab-nojus-projects-be622096.vercel.app',
];

export function resolveReactionApi(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return LIVE_REACTION_API;
  return RETIRED_ORIGINS.includes(value.toLowerCase()) ? LIVE_REACTION_API : value;
}
