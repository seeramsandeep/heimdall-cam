# 🛡️ Heimdall AI Security System

An intelligent, AI-powered security and crowd management system that provides real-time monitoring, threat detection, emergency dispatch, and predictive analytics for large venues and events.

## 🎯 Features

### Core Security Features
- **🔍 Predictive Bottleneck Analysis** - Analyze crowd density and predict chokepoints 15-20 minutes in advance
- **⚠️ Real-Time Anomaly Detection** - Detect unusual movements, panic, and suspicious behavior
- **🚨 AI-Powered Threat Recognition** - Identify weapons, fire, smoke, and other security threats
- **🚀 Automated Emergency Dispatch** - Intelligent responder assignment with optimal routing
- **📊 Sentiment & Crowd Analysis** - Monitor stress levels and crowd emotions

### Advanced Intelligence
- **🤖 Multimodal AI Processing** - Video, audio, and text analysis using Google AI
- **📱 Real-Time Dashboard** - Command center with live alerts and monitoring
- **👮 Responder Management** - GPS tracking and automated task assignment
- **🗣️ Natural Language Queries** - Ask questions about incidents and get AI responses
- **📡 Live Communication** - WebSocket-based real-time updates

### Mobile Applications
- **📱 Attendee Safety App** - Panic button, incident reporting, safe routes
- **👨‍💼 First Responder App** - Assignment notifications, navigation, real-time updates

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Mobile Apps   │    │  Command Center │    │  AI Processing  │
│                 │    │   Dashboard     │    │                 │
│ • Attendee App  │◄──►│                 │◄──►│ • Crowd Analysis│
│ • Responder App │    │ • Real-time     │    │ • Threat Detect │
│                 │    │ • WebSocket     │    │ • Anomaly Detect│
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Heimdall Backend API                         │
│                                                                 │
│ • Emergency Dispatch    • Real-time Analytics                  │
│ • Responder Management  • Natural Language Processing          │
│ • Video Intelligence   • Automated Workflows                  │
└─────────────────────────────────────────────────────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Firebase      │    │  Google Cloud   │    │   External      │
│                 │    │                 │    │   Services      │
│ • Realtime DB   │    │ • Vision AI     │    │ • Twilio SMS    │
│ • Authentication│    │ • Video Intel   │    │ • Email Alerts  │
│ • Cloud Functions│    │ • Vertex AI     │    │ • Google Maps   │
│ • Hosting       │    │ • Cloud Storage │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ and npm
- React Native development environment
- Google Cloud Platform account
- Firebase account
- Optional: Twilio account for SMS alerts

### 1. Clone and Install
```bash
git clone <repository-url>
cd VideoRecordingApp

# Install backend dependencies
cd backend
npm install

# Install mobile app dependencies
cd ..
npm install
```

### 2. Configure Backend
Create a `.env` file in the `backend` directory:

```env
# Basic Configuration
PORT=3001
NODE_ENV=development

# Google Cloud Platform
GCLOUD_PROJECT_ID=your-gcp-project-id
GCLOUD_KEYFILE=path/to/service-account-key.json
GCS_BUCKET_NAME=your-heimdall-bucket
GOOGLE_CLOUD_API_KEY=your-api-key
GOOGLE_MAPS_API_KEY=your-maps-api-key

# Firebase
FIREBASE_PROJECT_ID=your-firebase-project
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-...@project.iam.gserviceaccount.com
FIREBASE_DATABASE_URL=https://project-default-rtdb.firebaseio.com/

# Emergency Services (Optional)
TWILIO_ACCOUNT_SID=your-twilio-sid
TWILIO_AUTH_TOKEN=your-twilio-token
TWILIO_PHONE_NUMBER=+1234567890
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

### 3. Set Up Google Cloud Services
```bash
# Enable required APIs
gcloud services enable vision.googleapis.com
gcloud services enable videointelligence.googleapis.com
gcloud services enable aiplatform.googleapis.com
gcloud services enable storage.googleapis.com

# Create service account
gcloud iam service-accounts create heimdall-service-account

# Create storage bucket
gsutil mb gs://your-heimdall-bucket
```

### 4. Set Up Firebase
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project
3. Enable Realtime Database, Authentication, Cloud Functions, and Hosting
4. Download service account key and add to `.env`

### 5. Start the System
```bash
# Start backend server
cd backend
npm start

# In another terminal, start mobile app
cd ..
npx react-native start
npx react-native run-android  # or run-ios
```

### 6. Access Command Center
Open your browser and go to: `http://localhost:3001/dashboard`

## 📡 API Endpoints

### AI Analysis
```bash
# Crowd density analysis
POST /api/ai/analyze-crowd
Content-Type: multipart/form-data
Body: image file + metadata

# Bottleneck prediction
POST /api/ai/predict-bottlenecks
Body: { currentConditions, historicalData }

# Anomaly detection
POST /api/ai/detect-anomalies
Content-Type: multipart/form-data
Body: video file + metadata

# Threat recognition
POST /api/ai/recognize-threats
Content-Type: multipart/form-data
Body: media file + metadata

# Sentiment analysis
POST /api/ai/analyze-sentiment
Content-Type: multipart/form-data
Body: image file + metadata

# Natural language queries
POST /api/ai/query
Body: { query: "What happened near Gate B?", context: {} }
```

### Emergency Dispatch
```bash
# Dispatch emergency response
POST /api/emergency/dispatch
Body: {
  "type": "MEDICAL",
  "location": {
    "lat": 40.7128,
    "lng": -74.0060,
    "description": "Gate B, Section 3"
  },
  "description": "Person collapsed",
  "reportedBy": "Security Officer"
}

# Get emergency types
GET /api/emergency/types

# List incidents
GET /api/emergency/incidents

# Get specific incident
GET /api/emergency/incidents/:incidentId
```

### Responder Management
```bash
# List responders
GET /api/responders

# Add responder
POST /api/responders
Body: {
  "name": "Security Team Alpha",
  "skills": ["security", "crowd_control"],
  "location": { "lat": 40.7128, "lng": -74.0060 },
  "phone": "+1234567890",
  "email": "security@venue.com"
}

# Update responder status
PUT /api/responders/:responderId/status
Body: { "status": "available", "location": {...} }
```

### Dashboard & Analytics
```bash
# Dashboard overview
GET /api/dashboard/overview

# Health check
GET /health

# System status
GET /debug/status
```

## 🔄 Real-Time Features

### WebSocket Events
Connect to the server and join appropriate channels:

```javascript
const socket = io('http://localhost:3001');

// Command center feed
socket.emit('join_command_center');
socket.on('crowd_analysis', (data) => { /* Handle crowd data */ });
socket.on('bottleneck_warning', (data) => { /* Handle alert */ });
socket.on('anomaly_alert', (data) => { /* Handle anomaly */ });
socket.on('threat_alert', (data) => { /* Critical threat */ });
socket.on('emergency_dispatch', (data) => { /* Emergency */ });

// Responder feed
socket.emit('join_responder', 'responder_id');
socket.on('assignment', (data) => { /* New assignment */ });
```

## 🚨 Emergency Types

The system supports these emergency types with automatic prioritization:

1. **MEDICAL** (Priority 1) - 5 minute response time
2. **FIRE** (Priority 1) - 3 minute response time
3. **SECURITY_THREAT** (Priority 1) - 2 minute response time
4. **CROWD_CONTROL** (Priority 2) - 7 minute response time
5. **LOST_PERSON** (Priority 3) - 10 minute response time
6. **TECHNICAL** (Priority 3) - 15 minute response time

## 🤖 AI Capabilities

### Crowd Analysis
- **People Counting**: Accurate crowd density measurement
- **Zone Analysis**: Hot-spot identification and distribution mapping
- **Flow Patterns**: Movement direction and speed analysis
- **Bottleneck Prediction**: 15-20 minute advance warning system

### Threat Detection
- **Weapon Recognition**: Guns, knives, suspicious objects
- **Fire/Smoke Detection**: Early fire warning system
- **Text Analysis**: Threatening messages or signs
- **Behavioral Analysis**: Aggressive or suspicious behavior

### Anomaly Detection
- **Movement Patterns**: Panic, erratic behavior, stampede detection
- **Object Tracking**: Abandoned objects, unusual items
- **Crowd Dynamics**: Sudden density changes, flow disruptions

### Sentiment Analysis
- **Facial Emotions**: Joy, anger, fear, stress detection
- **Crowd Mood**: Overall sentiment and stress levels
- **Panic Indicators**: Early warning for crowd unrest

## 🎖️ Firebase Integration

Heimdall extensively uses Firebase services, making it eligible for Firebase special prizes:

- **Realtime Database**: Live incident tracking, responder status, real-time alerts
- **Cloud Functions**: Automated triggers, data processing, alert workflows
- **Authentication**: Secure access for responders and administrators
- **Hosting**: Command center dashboard deployment
- **Cloud Messaging**: Push notifications to responders and mobile apps

## 📱 Mobile Applications

### Attendee Safety App
- **Panic Button**: One-touch emergency alert
- **Incident Reporting**: Photo/video incident submission
- **Safe Routes**: Real-time evacuation path guidance
- **Notifications**: Emergency alerts and safety updates

### First Responder App
- **Assignment Notifications**: Real-time emergency assignments
- **GPS Navigation**: Optimal routing to incident locations
- **Status Updates**: Check-in and progress reporting
- **Communication**: Direct line to command center

## 🛠️ Development & Testing

### Mock Services
For development and testing, enable mock services:

```env
USE_MOCK_RESPONDERS=true
USE_MOCK_EMERGENCY_SERVICES=true
ENABLE_TEST_ENDPOINTS=true
```

### Demo Mode
The command center dashboard includes simulation features:
- **Simulate Emergency**: Test the complete dispatch workflow
- **Add Mock Responders**: Create test responder profiles
- **Generate Alerts**: Trigger various alert types for testing

### Debug Mode
Enable detailed logging:

```env
DEBUG_AI_ANALYSIS=true
DEBUG_EMERGENCY_DISPATCH=true
VERBOSE_LOGGING=true
LOG_LEVEL=debug
```

## 📈 Scalability & Performance

### Performance Optimizations
- **Horizontal Scaling**: Load balancer support
- **Real-time Processing**: WebSocket-based live updates
- **Caching**: Redis integration for performance
- **CDN**: Static asset delivery optimization

### Multi-venue Support
- **Tenant Isolation**: Venue-specific configurations
- **Centralized Monitoring**: Cross-venue dashboard
- **Resource Sharing**: Shared responder pools
- **Analytics**: Venue comparison and benchmarking

## 🔐 Security & Compliance

### Data Protection
- **Encryption**: All data encrypted in transit and at rest
- **GDPR Compliance**: Privacy-focused data handling
- **Access Control**: Role-based authentication
- **Audit Logs**: Complete action tracking

### API Security
- **Rate Limiting**: 100 requests/minute per IP
- **Authentication**: JWT-based secure access
- **CORS Protection**: Cross-origin request security
- **Input Validation**: Comprehensive data sanitization

## 📞 Support & Documentation

### Complete Documentation
- **[Setup Guide](backend/HEIMDALL_SETUP.md)**: Detailed configuration instructions
- **[API Documentation](backend/VIDEO_INTELLIGENCE_API.md)**: Complete API reference
- **[Architecture Overview](backend/SETUP.md)**: System architecture details

### Health Monitoring
```bash
# Check system health
curl http://localhost:3001/health

# Debug system status
curl http://localhost:3001/debug/status

# Dashboard overview
curl http://localhost:3001/api/dashboard/overview
```

### Troubleshooting
Common issues and solutions are documented in the setup guide. Key checkpoints:

1. **Firebase Connection**: Verify credentials and database URL
2. **Google Cloud APIs**: Ensure all required APIs are enabled
3. **Emergency Services**: Test Twilio and email configurations
4. **Real-time Features**: Check WebSocket connections

## 🎯 Use Cases

### Large Events
- **Concerts & Festivals**: Crowd management and safety
- **Sports Events**: Stadium security and emergency response
- **Conferences**: Attendee safety and incident management

### Venues
- **Shopping Malls**: Security monitoring and emergency coordination
- **Airports**: Passenger safety and threat detection
- **Universities**: Campus security and emergency response

### Smart Cities
- **Public Spaces**: Crowd monitoring and safety
- **Transportation Hubs**: Security and incident management
- **Emergency Services**: Coordinated response systems

## 🏆 Awards & Recognition

This project is designed to compete for multiple categories:
- **Firebase Special Prize**: Deep Firebase integration across all services
- **Google Cloud AI**: Advanced AI and ML implementations
- **Real-time Applications**: WebSocket-based live monitoring
- **Security Innovation**: Comprehensive threat detection system

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 👥 Contributing

We welcome contributions! Please read our contributing guidelines and submit pull requests for any improvements.

---

**Heimdall AI Security System** - Protecting people through intelligent technology 🛡️
