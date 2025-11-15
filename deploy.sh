#!/bin/bash
set -e

# Deploy the Arctic shipping map to Cloud Run
# Using same settings as Arctida project

PROJECT_NAME="arctic-shipping"
GCP_PROJECT="data-desk-web"
REGION="europe-west1"

echo "🚀 Deploying $PROJECT_NAME to Cloud Run..."
echo "   Project: $GCP_PROJECT"
echo "   Region: $REGION"
echo ""

# Deploy to Cloud Run
gcloud run deploy "$PROJECT_NAME" \
  --source . \
  --region "$REGION" \
  --project "$GCP_PROJECT" \
  --allow-unauthenticated \
  --port 8080 \
  --max-instances 10 \
  --min-instances 0 \
  --memory 1Gi \
  --cpu 1 \
  --quiet

# Get URL
SERVICE_URL=$(gcloud run services describe "$PROJECT_NAME" \
  --region "$REGION" \
  --project "$GCP_PROJECT" \
  --format "value(status.url)")

echo ""
echo "✅ Deployment complete!"
echo "🌐 Live at: $SERVICE_URL"
echo "🔓 App is publicly accessible"
echo ""
echo "To map custom domain arctic-shipping.tools.datadesk.eco:"
echo "  gcloud run domain-mappings create \\"
echo "    --service $PROJECT_NAME \\"
echo "    --domain arctic-shipping.tools.datadesk.eco \\"
echo "    --region $REGION \\"
echo "    --project $GCP_PROJECT"
