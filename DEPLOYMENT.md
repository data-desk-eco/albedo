# Deployment to Google Cloud Run

## Deployment Complete! ✅

**Service deployed successfully and accessible via path-based routing**

### URLs

- **Live URL**: https://tools.datadesk.eco/arctic-shipping/
- **Direct Cloud Run URL**: https://arctic-shipping-352064324632.europe-west1.run.app

### Deployment Settings

Matching the Arctida project configuration:

- **Project**: data-desk-web
- **Region**: europe-west1 (Belgium)
- **Service**: arctic-shipping
- **Memory**: 1 GB
- **CPU**: 1 vCPU
- **Min instances**: 0 (scales to zero when idle)
- **Max instances**: 10
- **Access**: Public (unauthenticated)
- **Port**: 8080
- **Path**: /arctic-shipping (served via load balancer)

### Load Balancer Configuration

The app is served through the existing `tools-lb` load balancer:
- **Load balancer**: tools-lb
- **IP**: 34.8.205.251
- **Domain**: tools.datadesk.eco
- **Path mapping**: /arctic-shipping → arctic-shipping-backend
- **Backend NEG**: arctic-shipping-neg (europe-west1)

### Bundle Size & Performance

**Container assets:**
- `vessel_heatmap.tif`: 8.4 MB (COG)
- `protected_areas.pmtiles`: 5.3 MB
- `index.html`: 5.3 KB
- **Total**: ~13.7 MB

**Performance:**
- First load: 6-8 MB (HTML + initial visible tiles)
- Pan/zoom: 50-200 KB per interaction
- Tiles cached for 24 hours
- Cold start: ~2-3 seconds
- Warm requests: <100ms
- Load balancer adds ~10-50ms latency

### Cost Estimate

Cloud Run pricing (europe-west1):
- Scales to zero when idle = $0/hour when not in use
- Only charged when serving requests
- **Estimated**: $0.50-$2.00/month for typical traffic
- Load balancer: Already paid for by existing Arctida project

### Quick Commands

**Update the app:**
```bash
gcloud run deploy arctic-shipping \
  --source . \
  --region europe-west1 \
  --project data-desk-web \
  --set-env-vars=PATH_PREFIX=/arctic-shipping \
  --quiet
```

**View logs:**
```bash
gcloud run logs read \
  --service arctic-shipping \
  --region europe-west1 \
  --project data-desk-web \
  --limit 50
```

**Test the service:**
```bash
# Test via load balancer
curl https://tools.datadesk.eco/arctic-shipping/

# Test tile endpoint
curl https://tools.datadesk.eco/arctic-shipping/tiles/2/1/1.png?colormap=yellow
```

### Architecture

The deployment uses Flask's `DispatcherMiddleware` to handle the `/arctic-shipping` path prefix:

1. **Load Balancer** (tools-lb) receives request at `/arctic-shipping/*`
2. **Backend NEG** (arctic-shipping-neg) routes to Cloud Run service
3. **Cloud Run** service receives full path `/arctic-shipping/*`
4. **Flask app** uses `DispatcherMiddleware` to strip prefix and serve content
5. **Static files** and **tiles** are served relative to the app root

Key environment variable:
```
PATH_PREFIX=/arctic-shipping
```

### Files Created

- `Dockerfile` - Container with Python + GDAL + Flask
- `cloudbuild.yaml` - Build configuration
- `Makefile.deploy` - Deployment commands
- `.dockerignore` - Excludes source data
- `.gcloudignore` - Excludes build artifacts
- `deploy.sh` - Deployment script
- `scripts/tile_server.py` - Modified to support path prefix

### Monitoring

View in Cloud Console:
- Service: https://console.cloud.google.com/run/detail/europe-west1/arctic-shipping
- Logs: https://console.cloud.google.com/logs/query;query=resource.type%3D%22cloud_run_revision%22%0Aresource.labels.service_name%3D%22arctic-shipping%22
- Metrics: https://console.cloud.google.com/run/detail/europe-west1/arctic-shipping/metrics
- Load Balancer: https://console.cloud.google.com/net-services/loadbalancing/list/loadBalancers

### Infrastructure Created

**Cloud Run:**
- Service: `arctic-shipping`
- Revision: `arctic-shipping-00002-jj5`

**Compute Engine (serverless):**
- Network Endpoint Group: `arctic-shipping-neg` (europe-west1)
- Backend Service: `arctic-shipping-backend` (global)
- URL Map: `tools-lb` (updated with new path rule)

### Path Rules in Load Balancer

Current configuration:
```yaml
pathRules:
- paths:
  - /nsr-map
  - /nsr-map/*
  service: arctida-backend
- paths:
  - /arctic-shipping
  - /arctic-shipping/*
  service: arctic-shipping-backend
```

---

**Deployment Date**: 2025-11-15
**Service Status**: Live at https://tools.datadesk.eco/arctic-shipping/
**Deployment Method**: Path-based routing via existing load balancer
