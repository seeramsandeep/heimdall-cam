# 🛡️ Heimdall AI Security System - Setup Guide

## Overview
Heimdall is a comprehensive AI-powered security and crowd management system that provides:
- Real-time crowd analysis and bottleneck prediction
- Anomaly and threat detection
- Automated emergency dispatch
- Sentiment analysis and stress monitoring
- Command center dashboard with real-time alerts

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment Variables
Create a `.env` file in the backend directory with the following configuration:

```env
# ===============================================
# BASIC SERVER CONFIGURATION
# ===============================================
PORT=3001
NODE_ENV=development

# ===============================================
# GOOGLE CLOUD PLATFORM CONFIGURATION
# ===============================================
# Core GCP Settings
GCLOUD_PROJECT_ID=your-gcp-project-id
LOCATION_ID=us-central1
GCLOUD_KEYFILE=path/to/your/service-account-key.json

# Google Cloud Storage
GCS_BUCKET_NAME=your-heimdall-bucket

# Google Cloud Video Intelligence API
GOOGLE_CLOUD_API_KEY=your-google-cloud-api-key

# Google Maps Platform (for emergency routing)
GOOGLE_MAPS_API_KEY=your-google-maps-api-key

# ===============================================
# FIREBASE CONFIGURATION
# ===============================================
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_PRIVATE_KEY_ID=your-private-key-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_HERE\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
FIREBASE_CLIENT_ID=your-client-id
FIREBASE_CLIENT_CERT_URL=https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-xxxxx%40your-project.iam.gserviceaccount.com
FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com/
FIREBASE_STORAGE_BUCKET=your-project.appspot.com

# ===============================================
# EMERGENCY DISPATCH CONFIGURATION
# ===============================================
# Twilio SMS/Voice Service
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+1234567890

# Email Notifications
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
COMMAND_CENTER_EMAIL=command@your-venue.com

# ===============================================
# AI SERVICES CONFIGURATION
# ===============================================
# Vertex AI Settings (uses same GCP credentials above)
VERTEX_AI_ENDPOINT_ID=optional-custom-endpoint-id
VERTEX_AI_MODEL_NAME=optional-custom-model

# Gemini API (for natural language queries)
GEMINI_API_KEY=your-gemini-api-key
```

### 3. Set Up Google Cloud Services

#### Enable Required APIs
```bash
gcloud services enable vision.googleapis.com
gcloud services enable videointelligence.googleapis.com
gcloud services enable aiplatform.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable maps-backend.googleapis.com
```

#### Create Service Account
```bash
gcloud iam service-accounts create heimdall-service-account \
    --description="Heimdall AI Security System" \
    --display-name="Heimdall Service Account"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:heimdall-service-account@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.admin"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
    --member="serviceAccount:heimdall-service-account@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/aiplatform.user"

gcloud iam service-accounts keys create heimdall-service-key.json \
    --iam-account=heimdall-service-account@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

#### Create Storage Bucket
```bash
gsutil mb gs://your-heimdall-bucket
gsutil iam ch serviceAccount:heimdall-service-account@YOUR_PROJECT_ID.iam.gserviceaccount.com:objectAdmin gs://your-heimdall-bucket
```

### 4. Set Up Firebase

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or use existing
3. Enable these services:
   - Realtime Database
   - Authentication
   - Cloud Functions
   - Hosting
4. Generate service account key:
   - Project Settings → Service Accounts → Generate New Private Key
5. Copy the credentials to your `.env` file

### 5. Set Up Emergency Services

#### Twilio (SMS/Voice Alerts)
1. Create account at [Twilio](https://www.twilio.com/)
2. Get Account SID, Auth Token, and Phone Number
3. Add to `.env` file

#### Email Service
1. For Gmail: Enable 2FA and create App Password
2. Add credentials to `.env` file

### 6. Start the System
```bash
npm start
```

## 📡 API Endpoints

### Core AI Analysis
- `POST /api/ai/analyze-crowd` - Crowd density analysis
- `POST /api/ai/predict-bottlenecks` - Bottleneck prediction
- `POST /api/ai/detect-anomalies` - Anomaly detection
- `POST /api/ai/recognize-threats` - Threat recognition
- `POST /api/ai/analyze-sentiment` - Sentiment analysis
- `POST /api/ai/query` - Natural language queries

### Emergency Dispatch
- `POST /api/emergency/dispatch` - Dispatch emergency response
- `GET /api/emergency/types` - Get emergency types
- `GET /api/emergency/incidents` - List all incidents
- `GET /api/emergency/incidents/:id` - Get specific incident

### Responder Management
- `GET /api/responders` - List all responders
- `POST /api/responders` - Create new responder
- `PUT /api/responders/:id/status` - Update responder status

### Real-time Dashboard
- `GET /api/dashboard/overview` - Dashboard overview
- WebSocket: Connect to receive real-time updates

## 🔧 Service Configuration

### Emergency Types
The system supports these emergency types with automatic prioritization:

1. **MEDICAL** (Priority 1) - 5 min response
2. **FIRE** (Priority 1) - 3 min response  
3. **SECURITY_THREAT** (Priority 1) - 2 min response
4. **CROWD_CONTROL** (Priority 2) - 7 min response
5. **LOST_PERSON** (Priority 3) - 10 min response
6. **TECHNICAL** (Priority 3) - 15 min response

### AI Analysis Features

#### Crowd Analysis
- People counting and density mapping
- Zone-based distribution analysis
- Flow pattern recognition
- Bottleneck prediction (15-20 min advance warning)

#### Threat Recognition
- Weapon detection
- Fire/smoke detection
- Suspicious object identification
- Threatening text recognition

#### Anomaly Detection
- Rapid movement patterns (panic detection)
- Erratic behavior identification
- Unusual object tracking
- Person tracking anomalies

#### Sentiment Analysis
- Facial emotion detection
- Crowd stress level monitoring
- Panic/distress indicators
- Mood trend analysis

## 🔄 Real-time Communication

### WebSocket Events

#### Command Center Events
```javascript
// Join command center feed
socket.emit('join_command_center');

// Receive alerts
socket.on('crowd_analysis', (data) => { /* handle crowd data */ });
socket.on('bottleneck_warning', (data) => { /* handle bottleneck alert */ });
socket.on('anomaly_alert', (data) => { /* handle anomaly */ });
socket.on('threat_alert', (data) => { /* critical threat detected */ });
socket.on('emergency_dispatch', (data) => { /* emergency dispatched */ });
```

#### Responder Events
```javascript
// Join responder feed
socket.emit('join_responder', 'responder_id');

// Receive assignments
socket.on('assignment', (data) => { /* new emergency assignment */ });
```

## 🎯 Usage Examples

### Manual Emergency Dispatch
```bash
curl -X POST http://localhost:3001/api/emergency/dispatch \
  -H "Content-Type: application/json" \
  -d '{
    "type": "MEDICAL",
    "location": {
      "lat": 40.7128,
      "lng": -74.0060,
      "description": "Gate B, Section 3"
    },
    "description": "Person collapsed, requires immediate medical attention",
    "reportedBy": "Security Officer Johnson"
  }'
```

### Crowd Analysis
```bash
curl -X POST http://localhost:3001/api/ai/analyze-crowd \
  -F "image=@crowd_photo.jpg" \
  -F 'metadata={"location": {"lat": 40.7128, "lng": -74.0060}, "camera_id": "cam_001"}'
```

### Natural Language Query
```bash
curl -X POST http://localhost:3001/api/ai/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What incidents happened in the last hour?",
    "context": {"timeframe": "1h"}
  }'
```

## 🚨 Automatic Features

### Auto-Dispatch Triggers
The system automatically dispatches emergency responses when:
- **Critical threats detected** (weapons, fire/smoke)
- **High-risk bottlenecks predicted** (crowd surge risk)
- **Severe anomalies detected** (panic, violent behavior)

### Real-time Monitoring
- Continuous video feed analysis
- Instant alert notifications
- Responder location tracking
- Incident progress monitoring

## 🔐 Security & Authentication

### API Rate Limiting
- 100 requests per minute per IP
- Configurable rate limits per endpoint

### Data Protection
- All video data encrypted in transit and at rest
- GDPR-compliant data handling
- Automatic data retention policies

## 📊 Analytics & Reporting

### Available Metrics
- Incident response times
- Crowd density trends
- Threat detection accuracy
- Responder performance
- System usage statistics

### Dashboard Features
- Real-time incident map
- Response time analytics
- Crowd flow visualization
- Alert history timeline

## 🛠️ Development & Testing

### Mock Services
Enable mock services for development:
```env
USE_MOCK_RESPONDERS=true
USE_MOCK_EMERGENCY_SERVICES=true
ENABLE_TEST_ENDPOINTS=true
```

### Debug Mode
Enable detailed logging:
```env
DEBUG_AI_ANALYSIS=true
DEBUG_EMERGENCY_DISPATCH=true
VERBOSE_LOGGING=true
LOG_LEVEL=debug
```

## 📞 Support & Troubleshooting

### Common Issues

1. **Firebase Connection Failed**
   - Check Firebase credentials in `.env`
   - Verify Firebase project settings
   - Ensure Realtime Database is enabled

2. **Google Cloud API Errors**
   - Verify APIs are enabled
   - Check service account permissions
   - Validate API key scopes

3. **Emergency Dispatch Not Working**
   - Check Twilio credentials
   - Verify email configuration
   - Test Google Maps API key

### Health Check
```bash
curl http://localhost:3001/health
```

### Debug Status
```bash
curl http://localhost:3001/debug/status
```

## 🎖️ Firebase Special Prize Integration

Heimdall extensively uses Firebase services:

- **Realtime Database**: Live incident tracking, responder status, alerts
- **Cloud Functions**: Automated triggers, data processing, notifications  
- **Authentication**: Secure responder and admin access
- **Hosting**: Command center dashboard deployment
- **Cloud Messaging**: Push notifications to responders

This makes Heimdall eligible for the Firebase special prize with deep integration across multiple Firebase services.

## 📈 Scalability

### Performance Optimization
- Horizontal scaling with load balancers
- Redis caching for frequently accessed data
- CDN for static assets
- Database connection pooling

### Multi-venue Support
- Tenant isolation
- Venue-specific configuration
- Centralized monitoring dashboard
- Cross-venue resource sharing

---

For technical support or feature requests, please refer to the project documentation or contact the development team. 