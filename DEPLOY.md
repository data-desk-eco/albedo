# Deployment Setup

Auto-deploys to Cloud Run on every push to `main` or `claude/**` branches.

## Quick Setup (5 minutes)

**1. Create service account and grant permissions:**
```bash
# Create service account
gcloud iam service-accounts create github-deployer \
  --project=data-desk-web \
  --display-name="GitHub Actions"

# Grant permissions
gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/run.admin"

gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

gcloud projects add-iam-policy-binding data-desk-web \
  --member="serviceAccount:github-deployer@data-desk-web.iam.gserviceaccount.com" \
  --role="roles/cloudbuild.builds.editor"
```

**2. Create and download key:**
```bash
gcloud iam service-accounts keys create key.json \
  --iam-account=github-deployer@data-desk-web.iam.gserviceaccount.com \
  --project=data-desk-web
```

**3. Add to GitHub:**
- Go to: https://github.com/data-desk-eco/nsr-map/settings/secrets/actions
- Click "New repository secret"
- Name: `GCP_SA_KEY`
- Value: Paste entire contents of `key.json`

**4. Delete the local key file:**
```bash
rm key.json
```

Done! Every push to `main` or `claude/**` branches now auto-deploys.

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
- Verify `GCP_SA_KEY` secret is set correctly in GitHub
- Check the JSON key is valid and complete

**Build errors:**
- Check that all required files are in the repository (Dockerfile, requirements.txt, data files)
- Verify data files are not gitignored (vessel_heatmap.tif, protected_areas.pmtiles, land.pmtiles)

**Permission errors:**
- Ensure service account has all four required roles (run.admin, iam.serviceAccountUser, storage.admin, cloudbuild.builds.editor)
