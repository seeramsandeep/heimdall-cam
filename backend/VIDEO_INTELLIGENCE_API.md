# Video Intelligence API

This module provides unified endpoints for Google Cloud Video Intelligence API operations.

## Endpoints

### 1. Complete Video Analysis (Recommended)

`POST /api/video-intelligence/analyze-video-complete`

This is the main endpoint you requested - it takes a gcsUri and handles the entire workflow:
1. Starts video annotation with person detection
2. Polls for completion automatically
3. Returns complete results

**Request Body:**
```json
{
  "gcsUri": "gs://videouploader-heimdall/devices/62da32e3-9f7c-449a-b772-8d12744e2d6c/sessions/unknown/chunks/chunk_1753521263860_2025-07-26T09-14-23.mp4",
  "maxWaitTime": 300000
}
```

**Response (Success):**
```json
{
  "success": true,
  "gcsUri": "gs://videouploader-heimdall/...",
  "operationName": "projects/766778819228/locations/asia-east1/operations/7728678473366773114",
  "analysisResults": {
    "@type": "type.googleapis.com/google.cloud.videointelligence.v1.AnnotateVideoResponse",
    "annotationResults": [
      {
        "inputUri": "/videouploader-heimdall/...",
        "segment": {
          "startTimeOffset": "0s",
          "endTimeOffset": "9.553073s"
        },
        "personDetectionAnnotations": [
          {
            "tracks": [
              {
                "segment": {
                  "startTimeOffset": "0.033519s",
                  "endTimeOffset": "2.648044s"
                },
                "timestampedObjects": [
                  {
                    "normalizedBoundingBox": {
                      "left": 0.7583333,
                      "top": 0.35625,
                      "right": 0.94166666,
                      "bottom": 0.571875
                    },
                    "timeOffset": "0.033519s"
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  },
  "processingTime": 8432,
  "completedAt": "2025-07-26T10:09:41.436Z",
  "summary": {
    "videoSegments": 1,
    "personDetections": 1,
    "totalTracks": 1
  }
}
```

### 2. Start Video Annotation (Async)

`POST /api/video-intelligence/start-video-annotation`

Starts annotation and returns immediately with operation name.

**Request Body:**
```json
{
  "gcsUri": "gs://videouploader-heimdall/path/to/video.mp4"
}
```

**Response:**
```json
{
  "success": true,
  "gcsUri": "gs://videouploader-heimdall/...",
  "operationName": "projects/766778819228/locations/asia-east1/operations/7728678473366773114",
  "message": "Video annotation started. Use the operation name to check status.",
  "startedAt": "2025-07-26T10:05:33.158Z",
  "checkStatusUrl": "/api/video-intelligence/check-operation-status",
  "estimatedCompletion": "2025-07-26T10:10:33.158Z"
}
```

### 3. Check Operation Status

`POST /api/video-intelligence/check-operation-status`

Check the status of a running operation.

**Request Body:**
```json
{
  "operationName": "projects/766778819228/locations/asia-east1/operations/7728678473366773114"
}
```

### 4. Get Operation Results

`POST /api/video-intelligence/get-operation-results`

Get results from a completed operation (with optional polling).

**Request Body:**
```json
{
  "operationName": "projects/766778819228/locations/asia-east1/operations/7728678473366773114",
  "poll": true,
  "maxWaitTime": 300000
}
```

### 5. Health Check

`GET /api/video-intelligence/health`

Check the status of the Video Intelligence API module.

## Usage Examples

### Example 1: Complete Analysis (Single Call)

This is exactly what you asked for - one endpoint that does everything:

```bash
curl --location 'http://localhost:3001/api/video-intelligence/analyze-video-complete' \
--header 'Content-Type: application/json' \
--data '{
    "gcsUri": "gs://videouploader-heimdall/devices/62da32e3-9f7c-449a-b772-8d12744e2d6c/sessions/unknown/chunks/chunk_1753521263860_2025-07-26T09-14-23.mp4"
}'
```

### Example 2: Async Workflow

If you prefer to handle polling yourself:

```bash
# Step 1: Start annotation
curl --location 'http://localhost:3001/api/video-intelligence/start-video-annotation' \
--header 'Content-Type: application/json' \
--data '{
    "gcsUri": "gs://videouploader-heimdall/devices/62da32e3-9f7c-449a-b772-8d12744e2d6c/sessions/unknown/chunks/chunk_1753521263860_2025-07-26T09-14-23.mp4"
}'

# Step 2: Check status (repeat until done)
curl --location 'http://localhost:3001/api/video-intelligence/check-operation-status' \
--header 'Content-Type: application/json' \
--data '{
    "operationName": "projects/766778819228/locations/asia-east1/operations/7728678473366773114"
}'

# Step 3: Get results when done
curl --location 'http://localhost:3001/api/video-intelligence/get-operation-results' \
--header 'Content-Type: application/json' \
--data '{
    "operationName": "projects/766778819228/locations/asia-east1/operations/7728678473366773114"
}'
```

## Configuration

The module uses the following environment variables:
- `GCLOUD_PROJECT_ID`: Your Google Cloud Project ID (defaults to '766778819228')
- `LOCATION_ID`: Processing location (defaults to 'asia-east1')
- `GCLOUD_KEYFILE`: Path to service account key file

## Features

- **Person Detection**: Detects people in videos with bounding boxes and attributes
- **Automatic Polling**: The main endpoint polls automatically until completion
- **Error Handling**: Comprehensive error handling with detailed messages
- **Timeout Control**: Configurable maximum wait times
- **Authentication**: Automatic Google Cloud authentication using service account
- **Async Support**: Both synchronous and asynchronous operation modes

## Notes

- The default timeout is 5 minutes (300,000 ms)
- Polling interval is 5 seconds
- Uses the same authentication as your existing GCP setup
- Processes videos in the 'asia-east1' location for optimal performance
- Returns the same detailed person detection data as the direct Google API calls 