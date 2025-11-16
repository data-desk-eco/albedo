# Deployment Setup

This project auto-deploys to Cloud Run on every push to `main` via GitHub Actions.

## GitHub Actions Workflow

The `.github/workflows/deploy.yml` workflow automatically:
1. Builds the Docker image from source
2. Deploys to Cloud Run service `arctic-shipping`
3. Runs in project `data-desk-web` (europe-west1 region)

## Required GitHub Secrets

You need to configure these secrets in your GitHub repository:

### Option 1: Workload Identity Federation (Recommended)

More secure - no long-lived credentials.

**Setup:**

1. Create a Workload Identity Pool:
```bash
gcloud iam workload-identity-pools create "github-pool" \
  --project="data-desk-web" \
  --location="global" \
  --display-name="GitHub Actions Pool"
```

2. Create a Workload Identity Provider:
```bash
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="data-desk-web" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub Provider" \
  --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == 'data-desk-eco'" \
  --issuer-uri="https://token.actions.githubusercontent.com"
```

3. Create a Service Account:
```bash
gcloud iam service-accounts create github-actions-deployer \
  --project="data-desk-web" \
  --display-name="GitHub Actions Deployer"
```

4. Grant permissions:
```bash
# Cloud Run Admin
gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-actions-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/run.admin"

# Service Account User (to deploy as the default compute SA)
gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-actions-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# Storage Admin (for source builds)
gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-actions-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

# Cloud Build Editor
gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-actions-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.editor"
```

5. Allow GitHub to impersonate the service account:
```bash
gcloud iam service-accounts add-iam-policy-binding \
  github-actions-deployer@data-desk-web.iam.gserviceaccount.com \
  --project="data-desk-web" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/data-desk-eco/nsr-map"
```
(Replace `PROJECT_NUMBER` with your GCP project number)

6. Get the Workload Identity Provider name:
```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
  --project="data-desk-web" \
  --location="global" \
  --workload-identity-pool="github-pool" \
  --format="value(name)"
```

7. Add GitHub Secrets (Settings → Secrets and variables → Actions):
   - `WIF_PROVIDER`: The full provider name from step 6 (e.g., `projects/123456789/locations/global/workloadIdentityPools/github-pool/providers/github-provider`)
   - `WIF_SERVICE_ACCOUNT`: `github-actions-deployer@data-desk-web.iam.gserviceaccount.com`

### Option 2: Service Account Key (Alternative)

**⚠️ Less secure - only use if WIF setup is not feasible**

1. Create a service account and grant permissions (same as WIF steps 3-4 above)

2. Create a JSON key:
```bash
gcloud iam service-accounts keys create key.json \
  --iam-account=github-actions-deployer@data-desk-web.iam.gserviceaccount.com \
  --project=data-desk-web
```

3. Add to GitHub Secrets:
   - `GCP_SA_KEY`: The entire contents of `key.json`

4. Update `.github/workflows/deploy.yml` to use the key instead:
```yaml
- name: Authenticate to Google Cloud
  uses: google-github-actions/auth@v2
  with:
    credentials_json: ${{ secrets.GCP_SA_KEY }}
```

## Manual Deployment

You can also trigger deployment manually:
1. Go to Actions tab in GitHub
2. Select "Deploy to Cloud Run" workflow
3. Click "Run workflow"

## Local Deployment

For local testing before pushing:
```bash
bash deploy.sh
```
(Requires `gcloud` CLI configured with proper credentials)

## Verifying Deployment

After deployment completes, the service URL is displayed in the GitHub Actions logs:
```
🌐 Deployed to: https://arctic-shipping-XXXXX-ew.a.run.app
```

## Troubleshooting

**Authentication errors:**
- Verify WIF_PROVIDER and WIF_SERVICE_ACCOUNT secrets are set correctly
- Check service account has required roles
- Ensure repository owner condition matches in WIF provider

**Build errors:**
- Check that all required files are in the repository (Dockerfile, requirements.txt, data files)
- Verify data files are not gitignored (vessel_heatmap.tif, protected_areas.pmtiles, land.pmtiles)

**Permission errors:**
- Ensure service account has all four required roles (run.admin, iam.serviceAccountUser, storage.admin, cloudbuild.builds.editor)
