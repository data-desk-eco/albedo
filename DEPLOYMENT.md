# Deployment to Google Cloud Run

**Albedo** - Northern Sea Route vessel activity map

Automated deployment via GitHub Actions. Already configured for `data-desk-web` project.

## Quick start

Push to `main` branch - GitHub Actions will automatically deploy.

Or deploy manually:
```bash
make deploy
```

## Manual deployment setup

If deploying to a different GCP project, you'll need a service account key:

1. **Create service account**:
```bash
gcloud iam service-accounts create github-actions \
  --project data-desk-web

gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-actions@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-actions@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.builder"
```

2. **Create key** (for GitHub secret):
```bash
gcloud iam service-accounts keys create key.json \
  --iam-account=github-actions@data-desk-web.iam.gserviceaccount.com
```

3. **Add to GitHub**:
   - Go to repo Settings → Secrets → New secret
   - Name: `GCP_SA_KEY`
   - Value: Contents of `key.json`

## Architecture

- Flask app serves COG tiles + static files
- Gunicorn for production (2 workers, 4 threads)
- COG heatmap (1.3MB) + PMTiles (5.3MB + 21KB) bundled
- Cloud Run auto-scales (0-10 instances)
- 512Mi memory, 1 CPU per instance
- Public access, no authentication

## Commands

```bash
make deploy    # Deploy to Cloud Run
make url       # Get service URL
make logs      # View recent logs
```
