# Deployment to tools.datadesk.eco

**Albedo** - Northern Sea Route vessel activity map

Deployed to: **https://tools.datadesk.eco/albedo**

## Quick Deployment

```bash
gcloud builds submit --config=cloudbuild.yaml
```

This builds the Docker image, pushes to Artifact Registry, and deploys to Cloud Run.

## Multi-Tool Load Balancer Architecture

This service is deployed behind a shared load balancer (`tools-lb`) that routes multiple tools under different paths with automatic path prefix stripping.

**How it works:**
```
User requests: https://tools.datadesk.eco/albedo/tiles/0/0/0.png
                                        ↓
                       Load Balancer (tools-lb)
                                        ↓
                    Strip /albedo prefix via routeAction.urlRewrite
                                        ↓
            Flask app receives: /tiles/0/0/0.png
```

**Current routing:**
- `/nsr-map/*` → arctida Cloud Run service
- `/albedo/*` → albedo Cloud Run service

**Benefits:**
- Flask apps don't need path prefix handling
- Simple route definitions (`@app.route('/')`)
- Easy to add new tools - just update the URL map

## Cloud Run Configuration

- **Service:** `albedo`
- **Region:** `europe-west1`
- **Image:** `europe-west1-docker.pkg.dev/data-desk-web/cloud-run-source-deploy/albedo`
- **Port:** 8080
- **Memory:** 512Mi
- **CPU:** 1 vCPU
- **Auto-scaling:** 0-10 instances
- **Access:** Public (unauthenticated)

## Adding a New Tool to tools.datadesk.eco

To add a new tool at `/your-tool`:

### 1. Deploy Cloud Run service
```bash
gcloud run deploy your-tool \
  --image=your-image \
  --region=europe-west1 \
  --platform=managed \
  --port=8080 \
  --allow-unauthenticated
```

### 2. Create Network Endpoint Group
```bash
gcloud compute network-endpoint-groups create your-tool-neg \
  --region=europe-west1 \
  --network-endpoint-type=SERVERLESS \
  --cloud-run-service=your-tool
```

### 3. Create Backend Service
```bash
gcloud compute backend-services create your-tool-backend \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED

gcloud compute backend-services add-backend your-tool-backend \
  --global \
  --network-endpoint-group=your-tool-neg \
  --network-endpoint-group-region=europe-west1
```

### 4. Update URL Map

Export current configuration:
```bash
gcloud compute url-maps export tools-lb --destination=/tmp/tools-lb.yaml
```

Edit `/tmp/tools-lb.yaml` and add your tool to `routeRules` (adjust priority):
```yaml
routeRules:
  # ... existing rules ...
  - priority: 3
    matchRules:
    - prefixMatch: /your-tool
    service: https://www.googleapis.com/compute/v1/projects/data-desk-web/global/backendServices/your-tool-backend
    routeAction:
      urlRewrite:
        pathPrefixRewrite: /
```

Import the updated configuration:
```bash
gcloud compute url-maps import tools-lb --source=/tmp/tools-lb.yaml --global
```

### 5. Flask App Requirements

**Critical:** Your Flask app must define routes from `/` (not `/your-tool/`):

```python
app = Flask(__name__)

@app.route('/')
def index():
    return "Hello from your tool!"

@app.route('/api/data')
def api():
    return {"status": "ok"}
```

The load balancer strips the `/your-tool` prefix before forwarding requests.

**Important for relative URLs in HTML/JS:**
Use paths **without leading `./`** for resources:
- ✅ `tiles/{z}/{x}/{y}.png` - relative to current path
- ❌ `./tiles/{z}/{x}/{y}.png` - resolves incorrectly when served under a prefix

When your page is at `/albedo/`, a relative URL `tiles/...` resolves to `/albedo/tiles/...` (correct), but `./tiles/...` resolves to `/tiles/...` (missing the prefix).

## Verification

```bash
# Check service is running
gcloud run services describe albedo --region=europe-west1

# Verify URL map configuration
gcloud compute url-maps describe tools-lb

# Test the endpoint
curl https://tools.datadesk.eco/albedo/
curl https://tools.datadesk.eco/albedo/tiles/0/0/0.png
```

## Troubleshooting

**404 errors:**
- Ensure Flask routes don't include the path prefix
- Verify URL map has `pathPrefixRewrite: /` in `routeAction`
- Check backend service points to correct NEG

**Changes not taking effect:**
- Load balancer updates can take 1-2 minutes to propagate
- Verify fingerprint changed: `gcloud compute url-maps describe tools-lb`
