# lm-render

Free-tier render runner. This is a public repo *only* so that GitHub-hosted
Actions minutes are unlimited (the 2,000 min/mo cap applies to private repos
only).

**No application code lives here.** Each workflow clones the relevant private
repo at runtime using the `GH_PAT` secret, runs the generator/worker there, and
enqueues or uploads the output. Remotion templates, scripts and business logic
stay private.

### Why this is safe to be public
- Workflows trigger only on `schedule` + `workflow_dispatch` — neither is
  fork-triggerable, and `workflow_dispatch` needs write access. Strangers
  cannot run these jobs or push into the backlog.
- Pull requests from forks run with **no secrets** by default, so the tokens
  here can't be exfiltrated.

### Required secrets
| Secret | What it is |
| --- | --- |
| `GH_PAT` | fine-grained PAT, Contents:read on the private generator repos. Reaction Lab additionally needs read access to `infermator/21media-mam`. |
| `BUFFER_PUSH_SECRET` | enqueue/worker bearer token |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob upload |
| `SUPABASE_URL` | MAM Supabase project URL |
| `MAM_SUPABASE_SERVICE_ROLE_KEY` | MAM Supabase service-role JWT |

### Workflows
- `daily-fresh-clips.yml` — 04:00 UTC, generates N video clips
- `daily-fresh-photo.yml` — 03:00 UTC, generates 1 photo slideshow
- `render-clips.yml` — manual parallel backlog renderer
- `reaction-render.yml` — every 5 min claims one queued Reaction Lab job from MAM; manual dispatch can target an exact job UUID
