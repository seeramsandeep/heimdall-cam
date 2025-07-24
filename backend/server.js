require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { Storage } = require('@google-cloud/storage');
const videoIntelligence = require('@google-cloud/video-intelligence').v1;
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  maxHttpBufferSize: 1e8 // 100MB for video streams
});

// Configuration
const PORT = process.env.PORT || 3001;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'videouploader-heimdall';
const GCLOUD_KEYFILE = path.join(__dirname, process.env.GCLOUD_KEYFILE || 'heimdall-cam.json');

// Ensure uploads directory exists
fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(console.error);

// Initialize Google Cloud services
const storage = new Storage({
  keyFilename: GCLOUD_KEYFILE,
  projectId: process.env.GCLOUD_PROJECT_ID,
});

const videoClient = new videoIntelligence.VideoIntelligenceServiceClient({
  keyFilename: GCLOUD_KEYFILE,
});

// Enhanced CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    // Allow all origins for development
    if (process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }
    
    // Add your specific origins here for production
    const allowedOrigins = ['http://localhost:3000', 'https://51b3a9002a7b.ngrok-free.app', 'https://67a845f00deb.ngrok-free.app', 'htt://localhost:3001', 'react-native-app'];
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    return callback(null, true); // Allow all for now
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'Origin', 'Accept'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Additional middleware for ngrok compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
  res.header('Access-Control-Max-Age', '86400');
  
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});


app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Multer configuration for file uploads
const upload = multer({
  dest: UPLOADS_DIR,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  },
});

// Active streaming sessions with enhanced data
const activeStreams = new Map();
const deviceSessions = new Map();
const streamRooms = new Map(); // For video streaming rooms

// Enhanced Socket.IO connection handling with video streaming
// Enhanced Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`📱 Client connected: ${socket.id}`);

  socket.on('register-device', (data) => {
    const { deviceId, sessionId } = data;
    
    socket.deviceId = deviceId;
    socket.sessionId = sessionId;
    socket.join(`device-${deviceId}`);
    
    deviceSessions.set(deviceId, {
      socketId: socket.id,
      sessionId,
      startTime: new Date(),
      chunkCount: 0,
      isStreaming: false,
      lastFrameTime: null,
    });

    console.log(`Device registered: ${deviceId}`);
    socket.emit('device-registered', { deviceId, sessionId });
  });

  // Enhanced dashboard registration
  socket.on('register-dashboard', () => {
    socket.join('dashboard');
    console.log(`Dashboard client registered: ${socket.id}`);
    
    // Send current active streams
    const streams = Array.from(activeStreams.entries()).map(([deviceId, stream]) => ({
      deviceId,
      sessionId: stream.sessionId,
      startTime: stream.startTime,
      isActive: stream.isActive,
      lastFrame: stream.lastFrame || null,
      frameCount: stream.frameCount || 0,
    }));
    
    socket.emit('current-streams', { streams });
  });

  socket.on('start-stream', (data) => {
    const { deviceId, sessionId } = data;
    
    activeStreams.set(deviceId, {
      socketId: socket.id,
      sessionId,
      isActive: true,
      startTime: new Date(),
      lastFrame: null,
      frameCount: 0,
      lastFrameTime: null,
    });

    console.log(`Stream started for device: ${deviceId}`);
    
    // Broadcast to dashboard
    io.to('dashboard').emit('stream-started', { 
      deviceId, 
      sessionId,
      startTime: new Date(),
    });
  });

  // Enhanced video frame handling
  socket.on('video-frame', (data) => {
    const { deviceId, frame, timestamp, frameNumber } = data;
    
    if (activeStreams.has(deviceId)) {
      const stream = activeStreams.get(deviceId);
      stream.lastFrame = frame;
      stream.frameCount = frameNumber;
      stream.lastFrameTime = new Date();
      activeStreams.set(deviceId, stream);
      
      console.log(`Frame ${frameNumber} received from device ${deviceId}`);
      
      // Broadcast frame to all dashboard clients
      io.to('dashboard').emit('video-frame', {
        deviceId,
        frame,
        timestamp,
        frameNumber,
        receivedAt: new Date().toISOString(),
      });
      
      console.log(`📡 Frame ${frameNumber} broadcasted to dashboard`);
    }
  });

  // Enhanced chunk upload handling with immediate analysis
  socket.on('chunk-uploaded', async (data) => {
    const { chunkId, sessionId, deviceId } = data;
    
    if (deviceSessions.has(deviceId)) {
      const session = deviceSessions.get(deviceId);
      session.chunkCount++;
      deviceSessions.set(deviceId, session);
    }

    console.log(`Processing chunk: ${chunkId}`);
    
    // Send immediate acknowledgment
    socket.emit('chunk-processing', { chunkId, status: 'processing' });
    io.to('dashboard').emit('chunk-processing', { deviceId, chunkId, status: 'processing' });
    
    // Start analysis
    try {
      await processVideoChunk(chunkId, sessionId, deviceId, socket);
    } catch (error) {
      console.error(`Analysis failed for ${chunkId}:`, error);
      socket.emit('analysis-error', { chunkId, error: error.message });
      io.to('dashboard').emit('analysis-error', { deviceId, chunkId, error: error.message });
    }
  });

  socket.on('stop-stream', (data) => {
    const { deviceId } = data;
    
    if (activeStreams.has(deviceId)) {
      activeStreams.delete(deviceId);
    }
    
    console.log(`Stream stopped for device: ${deviceId}`);
    io.to('dashboard').emit('stream-stopped', { deviceId });
  });

  socket.on('disconnect', () => {
    console.log(`📱 Client disconnected: ${socket.id}`);
    
    for (const [deviceId, session] of deviceSessions.entries()) {
      if (session.socketId === socket.id) {
        deviceSessions.delete(deviceId);
        activeStreams.delete(deviceId);
        io.to('dashboard').emit('stream-stopped', { deviceId });
        break;
      }
    }
  });
});

// Enhanced video analysis processing
async function processVideoChunk(chunkId, sessionId, deviceId, socket) {
  try {
    const gcsUri = `gs://${BUCKET_NAME}/streams/${deviceId}/${sessionId}/${chunkId}.mp4`;
    
    console.log(`Starting AI analysis for: ${gcsUri}`);

    // Send processing status update
    const processingStatus = {
      chunkId,
      sessionId,
      deviceId,
      status: 'analyzing',
      timestamp: new Date(),
    };
    
    socket.emit('analysis-status', processingStatus);
    io.to('dashboard').emit('analysis-status', processingStatus);

    const request = {
      inputUri: gcsUri,
      features: [
        'LABEL_DETECTION',
        'PERSON_DETECTION',
        'OBJECT_TRACKING',
        'TEXT_DETECTION',
      ],
      videoContext: {
        personDetectionConfig: {
          includeBoundingBoxes: true,
          includeAttributes: true,
        },
        labelDetectionConfig: {
          model: 'builtin/latest',
        },
      },
    };

    const [operation] = await videoClient.annotateVideo(request);
    console.log(`Analysis operation started for ${chunkId}`);
    
    const [result] = await operation.promise();
    console.log(`Analysis completed for ${chunkId}`);
    
    const analysis = result.annotationResults[0];
    const processedAnalysis = processAnalysisResults(analysis);
    
    // Save analysis results
    const analysisPath = path.join(UPLOADS_DIR, deviceId, sessionId, `${chunkId}-analysis.json`);
    await fs.writeFile(analysisPath, JSON.stringify(processedAnalysis, null, 2));

    // Send results to mobile app and dashboard
    const analysisData = {
      chunkId,
      sessionId,
      deviceId,
      timestamp: new Date(),
      status: 'completed',
      ...processedAnalysis,
    };

    socket.emit('analysis-result', analysisData);
    io.to('dashboard').emit('analysis-result', analysisData);
    
    console.log(`Analysis results sent for ${chunkId}`);

    // Handle security alerts
    if (processedAnalysis.alerts && processedAnalysis.alerts.length > 0) {
      const alertData = {
        deviceId,
        sessionId,
        chunkId,
        alerts: processedAnalysis.alerts,
        timestamp: new Date(),
      };
      
      io.emit('security-alert', alertData);
      console.log(`🚨 Security alert sent for ${chunkId}`);
    }

  } catch (error) {
    console.error(`Analysis error for chunk ${chunkId}:`, error);
    
    const errorData = {
      chunkId,
      sessionId,
      deviceId,
      status: 'error',
      error: error.message,
      timestamp: new Date(),
    };
    
    socket.emit('analysis-error', errorData);
    io.to('dashboard').emit('analysis-error', errorData);
  }
}

// Enhanced analysis results processing
function processAnalysisResults(analysis) {
  const processed = {
    labels: [],
    personDetection: {
      detectedPersons: [],
      totalCount: 0,
    },
    objectTracking: [],
    crowdAnalysis: {
      density: 'low',
      riskLevel: 'normal',
    },
    alerts: [],
    summary: '',
  };

  // Process labels
  if (analysis.labelAnnotations && analysis.labelAnnotations.length > 0) {
    processed.labels = analysis.labelAnnotations
      .filter(label => label.entity.description && label.frames.length > 0)
      .map(label => ({
        description: label.entity.description,
        confidence: label.frames[0].confidence || 0,
        category: label.categoryEntities?.[0]?.description || 'general',
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
  }

  // Process person detection
  if (analysis.personDetectionAnnotations && analysis.personDetectionAnnotations.length > 0) {
    const personAnnotations = analysis.personDetectionAnnotations;
    processed.personDetection.detectedPersons = personAnnotations.map(person => ({
      trackId: person.trackId,
      confidence: person.confidence,
      attributes: person.attributes || [],
    }));
    processed.personDetection.totalCount = personAnnotations.length;

    // Crowd analysis
    const personCount = personAnnotations.length;
    if (personCount > 20) {
      processed.crowdAnalysis.density = 'high';
      processed.crowdAnalysis.riskLevel = 'elevated';
      processed.alerts.push({
        type: 'crowd_density',
        message: `High crowd density detected: ${personCount} people`,
        severity: 'warning',
      });
    } else if (personCount > 10) {
      processed.crowdAnalysis.density = 'medium';
    }
  }

  // Process object tracking
  if (analysis.objectAnnotations && analysis.objectAnnotations.length > 0) {
    processed.objectTracking = analysis.objectAnnotations
      .filter(obj => obj.entity.description)
      .map(obj => ({
        description: obj.entity.description,
        confidence: obj.confidence,
        trackId: obj.trackId,
      }));
  }

  // Process text detection
  if (analysis.textAnnotations && analysis.textAnnotations.length > 0) {
    processed.textDetections = analysis.textAnnotations
      .map(text => ({
        text: text.text,
        confidence: text.confidence,
      }))
      .slice(0, 5);
  }

  // Generate summary
  const summaryParts = [];
  if (processed.labels.length > 0) {
    summaryParts.push(`Objects: ${processed.labels.slice(0, 3).map(l => l.description).join(', ')}`);
  }
  if (processed.personDetection.totalCount > 0) {
    summaryParts.push(`People: ${processed.personDetection.totalCount}`);
  }
  if (processed.textDetections.length > 0) {
    summaryParts.push(`Text detected: ${processed.textDetections.length} items`);
  }
  
  processed.summary = summaryParts.join(' | ') || 'No significant content detected';

  // Safety alerts
  const dangerousObjects = ['weapon', 'knife', 'gun', 'fire', 'smoke'];
  const detectedDangerous = processed.labels.filter(label => 
    dangerousObjects.some(dangerous => 
      label.description.toLowerCase().includes(dangerous)
    )
  );

  if (detectedDangerous.length > 0) {
    processed.alerts.push({
      type: 'dangerous_object',
      message: `Potential dangerous objects: ${detectedDangerous.map(d => d.description).join(', ')}`,
      severity: 'critical',
    });
  }

  return processed;
}

app.post('/upload-chunk', upload.single('video'), async (req, res) => {
  const startTime = new Date();
  console.log(`📥 Upload request received at ${startTime.toISOString()}`);
  console.log('📋 Request details:', {
    method: req.method,
    url: req.url,
    headers: {
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length'],
      'user-agent': req.headers['user-agent'],
      'origin': req.headers['origin'],
    },
    body: req.body,
    fileInfo: req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      encoding: req.file.encoding,
      mimetype: req.file.mimetype,
      size: req.file.size,
      destination: req.file.destination,
      filename: req.file.filename,
    } : 'No file received'
  });

  try {
    const { sessionId, deviceId, chunkId } = req.body;
    const videoFile = req.file;

    // Validate required fields
    if (!sessionId || !deviceId || !chunkId) {
      console.error('Missing required fields:', { sessionId, deviceId, chunkId });
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['sessionId', 'deviceId', 'chunkId'],
        received: { sessionId, deviceId, chunkId }
      });
    }

    if (!videoFile) {
      console.error('No video file in request');
      return res.status(400).json({ 
        error: 'No video file provided',
        receivedFields: Object.keys(req.body),
        contentType: req.headers['content-type']
      });
    }

    console.log(`Valid upload request for chunk: ${chunkId}`);

    // Create organized file structure
    const sessionDir = path.join(UPLOADS_DIR, deviceId, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    // Move and rename file
    const fileName = `${chunkId}.mp4`;
    const finalPath = path.join(sessionDir, fileName);
    
    await fs.rename(videoFile.path, finalPath);
    console.log(`File saved to: ${finalPath}`);

    // Verify file
    const stats = await fs.stat(finalPath);
    console.log(`File verified: ${stats.size} bytes`);

    // Upload to GCS (optional)
    let gcsPath = null;
    try {
      gcsPath = `streams/${deviceId}/${sessionId}/${fileName}`;
      await uploadToGCS(finalPath, gcsPath);
      console.log(`Uploaded to GCS: ${gcsPath}`);
    } catch (gcsError) {
      console.error('GCS upload failed:', gcsError.message);
      // Continue without GCS
    }

    const duration = new Date() - startTime;
    console.log(`Upload completed in ${duration}ms`);
    
    res.json({
      success: true,
      chunkId,
      gcsPath,
      localPath: finalPath,
      fileSize: stats.size,
      processingTime: duration,
      timestamp: new Date(),
    });

  } catch (error) {
    const duration = new Date() - startTime;
    console.error(`Upload failed after ${duration}ms:`, error);
    res.status(500).json({ 
      error: 'Upload processing failed',
      details: error.message,
      processingTime: duration,
    });
  }
});



// Add to your server.js
app.get('/api/device-info/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const session = deviceSessions.get(deviceId);
  
  if (!session) {
    return res.status(404).json({ error: 'Device not found' });
  }
  
  // You can expand this with more device-specific information
  const deviceInfo = {
    deviceId,
    sessionId: session.sessionId,
    startTime: session.startTime,
    chunkCount: session.chunkCount,
    isStreaming: session.isStreaming,
    lastActivity: session.lastActivity || session.startTime,
    // Add camera info if available
    cameraInfo: session.cameraInfo || null,
  };
  
  res.json(deviceInfo);
});



// Process video chunk with AI analysis
async function processVideoChunk(chunkId, sessionId, deviceId, socket) {
  try {
    const gcsUri = `gs://${BUCKET_NAME}/streams/${deviceId}/${sessionId}/${chunkId}.mp4`;
    
    console.log(`Starting analysis for: ${gcsUri}`);

    const request = {
      inputUri: gcsUri,
      features: [
        'LABEL_DETECTION',
        'PERSON_DETECTION',
        'OBJECT_TRACKING',
        'TEXT_DETECTION',
        'SHOT_CHANGE_DETECTION',
      ],
      videoContext: {
        personDetectionConfig: {
          includeBoundingBoxes: true,
          includeAttributes: true,
          includePoseLandmarks: false,
        },
        objectTrackingConfig: {
          model: 'builtin/latest',
        },
      },
    };

    const [operation] = await videoClient.annotateVideo(request);
    const [result] = await operation.promise();
    const analysis = result.annotationResults[0];

    // Process and enhance analysis results
    const processedAnalysis = processAnalysisResults(analysis);
    
    // Save analysis results
    const analysisPath = path.join(UPLOADS_DIR, deviceId, sessionId, `${chunkId}-analysis.json`);
    await fs.writeFile(analysisPath, JSON.stringify(processedAnalysis, null, 2));

    // Send real-time analysis to connected clients
    const analysisData = {
      chunkId,
      sessionId,
      deviceId,
      timestamp: new Date(),
      ...processedAnalysis,
    };

    socket.emit('analysis-result', analysisData);
    io.to('dashboard').emit('analysis-result', analysisData);

    // Broadcast to dashboard if critical alerts detected
    if (processedAnalysis.alerts && processedAnalysis.alerts.length > 0) {
      const alertData = {
        deviceId,
        sessionId,
        chunkId,
        alerts: processedAnalysis.alerts,
        timestamp: new Date(),
      };
      
      io.emit('security-alert', alertData);
    }

    console.log(`Analysis completed for chunk: ${chunkId}`);

  } catch (error) {
    console.error(`Analysis error for chunk ${chunkId}:`, error);
    socket.emit('analysis-error', {
      chunkId,
      error: error.message,
    });
  }
}

// Process and enhance analysis results
function processAnalysisResults(analysis) {
  const processed = {
    labels: [],
    personDetection: {
      detectedPersons: [],
      totalCount: 0,
    },
    objectTracking: [],
    crowdAnalysis: {
      density: 'low',
      riskLevel: 'normal',
    },
    alerts: [],
  };

  // Process labels
  if (analysis.labelAnnotations) {
    processed.labels = analysis.labelAnnotations
      .filter(label => label.entity.description && label.frames.length > 0)
      .map(label => ({
        description: label.entity.description,
        confidence: label.frames[0].confidence || 0,
        category: label.categoryEntities?.[0]?.description || 'general',
      }))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
  }

  // Process person detection
  if (analysis.personDetectionAnnotations) {
    const personAnnotations = analysis.personDetectionAnnotations;
    processed.personDetection.detectedPersons = personAnnotations.map(person => ({
      trackId: person.trackId,
      confidence: person.confidence,
      attributes: person.attributes || [],
    }));
    processed.personDetection.totalCount = personAnnotations.length;

    // Crowd analysis
    const personCount = personAnnotations.length;
    if (personCount > 50) {
      processed.crowdAnalysis.density = 'high';
      processed.crowdAnalysis.riskLevel = 'elevated';
      processed.alerts.push({
        type: 'crowd_density',
        message: `High crowd density detected: ${personCount} people`,
        severity: 'warning',
      });
    } else if (personCount > 20) {
      processed.crowdAnalysis.density = 'medium';
    }
  }

  // Process object tracking
  if (analysis.objectAnnotations) {
    processed.objectTracking = analysis.objectAnnotations
      .filter(obj => obj.entity.description)
      .map(obj => ({
        description: obj.entity.description,
        confidence: obj.confidence,
        trackId: obj.trackId,
      }));
  }

  // Safety alerts based on detected objects and scenarios
  const dangerousObjects = ['weapon', 'knife', 'gun', 'fire', 'smoke'];
  const detectedDangerous = processed.labels.filter(label => 
    dangerousObjects.some(dangerous => 
      label.description.toLowerCase().includes(dangerous)
    )
  );

  if (detectedDangerous.length > 0) {
    processed.alerts.push({
      type: 'dangerous_object',
      message: `Potential dangerous objects detected: ${detectedDangerous.map(d => d.description).join(', ')}`,
      severity: 'critical',
    });
  }

  return processed;
}

// Upload file to Google Cloud Storage
async function uploadToGCS(localPath, gcsPath) {
  try {
    await storage.bucket(BUCKET_NAME).upload(localPath, {
      destination: gcsPath,
      metadata: {
        cacheControl: 'public, max-age=31536000',
      },
    });
    console.log(`Uploaded to GCS: ${gcsPath}`);
  } catch (error) {
    console.error(`GCS upload error for ${gcsPath}:`, error);
    throw error;
  }
}

// Dashboard route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Get active streams endpoint
app.get('/api/streams', (req, res) => {
  const streams = Array.from(activeStreams.entries()).map(([deviceId, stream]) => ({
    deviceId,
    sessionId: stream.sessionId,
    startTime: stream.startTime,
    isActive: stream.isActive,
    frameCount: stream.frameCount || 0,
    lastUpdate: stream.lastUpdate || stream.startTime,
  }));
  
  res.json({ streams });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date(),
    activeStreams: activeStreams.size,
    activeSessions: deviceSessions.size,
    server: 'Heimdall Backend v2.0'
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Heimdall Server v2.0 running on port ${PORT}`);
  console.log(`WebSocket server ready for video streaming`);
  console.log(`Video Intelligence API initialized`);
  console.log(`Google Cloud Storage configured`);
  console.log(`Dashboard available at: /`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});