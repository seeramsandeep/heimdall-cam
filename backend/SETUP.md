# Heimdall Backend Setup Guide

## Required Environment Variables

Create a `.env` file in the backend directory with the following variables:

```bash
# Server Configuration
PORT=3001
NODE_ENV=development

# Google Cloud Storage Configuration
GCS_BUCKET_NAME=videouploader-heimdall
GCLOUD_PROJECT_ID=your-gcp-project-id
GCLOUD_KEYFILE=heimdall-cam.json
```

## Google Cloud Platform Setup

### 1. Create a GCP Project
- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Create a new project or select an existing one
- Note your Project ID

### 2. Enable Required APIs
Enable the following APIs in your GCP project:
- **Cloud Storage API**
- **Video Intelligence API**

```bash
# Using gcloud CLI
gcloud services enable storage.googleapis.com
gcloud services enable videointelligence.googleapis.com
```

### 3. Create a Service Account
1. Go to IAM & Admin > Service Accounts
2. Click "Create Service Account"
3. Give it a name like "heimdall-service"
4. Assign the following roles:
   - **Storage Admin**
   - **Video Intelligence User**
5. Create and download the JSON key file
6. Rename it to `heimdall-cam.json` and place it in the backend directory

### 4. Create a Cloud Storage Bucket
```bash
# Using gcloud CLI
gsutil mb gs://videouploader-heimdall

# Or create through the Cloud Console
# Storage > Browser > Create Bucket
# Name: videouploader-heimdall
# Region: Choose your preferred region
```

### 5. Set Bucket Permissions
Make sure your service account has access to the bucket:
```bash
gsutil iam ch serviceAccount:your-service-account@your-project.iam.gserviceaccount.com:objectAdmin gs://videouploader-heimdall
```

## Testing the Setup

1. Start the backend server:
```bash
cd backend
npm install
npm start
```

2. Check the logs for:
```
✅ GCS key file found
✅ GCS Storage initialized and bucket accessible
✅ Video Intelligence API initialized
🪣 GCS Upload: ✅ Enabled
🤖 Video AI: ✅ Enabled
```

3. Test the health endpoint:
```bash
curl http://localhost:3001/health
```

## Troubleshooting

### Common Issues

1. **"GCS key file not found"**
   - Make sure `heimdall-cam.json` is in the backend directory
   - Check the `GCLOUD_KEYFILE` environment variable

2. **"Bucket not found"**
   - Verify the bucket name in `GCS_BUCKET_NAME`
   - Make sure the bucket exists in your project
   - Check bucket permissions

3. **"Video Intelligence initialization failed"**
   - Ensure the Video Intelligence API is enabled
   - Verify service account has Video Intelligence User role

4. **"Authentication failed"**
   - Check if the service account key is valid
   - Verify the project ID matches your GCP project

### Minimal Setup (Local Development)
If you want to test without GCP:
- The server will still work with GCS and Video AI disabled
- Video chunks will be stored locally only
- AI analysis will be skipped
- Live streaming will still work

## File Structure
```
backend/
├── server.js
├── heimdall-cam.json     # Your GCP service account key
├── .env                  # Environment variables
├── package.json
├── uploads/              # Local video storage
└── public/
    └── dashboard.html
``` 