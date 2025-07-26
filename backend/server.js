require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { Storage } = require('@google-cloud/storage');
const videoIntelligence = require('@google-cloud/video-intelligence').v1;
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const socketIo = require('socket.io');

// Import the new video intelligence API router
const videoIntelligenceRouter = require('./video-intelligence-api');

// Import new Heimdall services
const firebase = require('./config/firebase');
const { 
  CrowdAnalyzer, 
  AnomalyDetector, 
  ThreatRecognizer, 
  SentimentAnalyzer 
} = require('./services/ai-analysis');
const { 
  EmergencyDispatchSystem, 
  EMERGENCY_TYPES 
} = require('./services/emergency-dispatch');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configuration
const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(__dirname, 'temp');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'heimdall-cam';
const GCLOUD_KEYFILE = path.join(__dirname, process.env.GCLOUD_KEYFILE || 'heimdall-cam.json');
const GCLOUD_PROJECT_ID = process.env.GCLOUD_PROJECT_ID;

// Service status flags
let GCS_ENABLED = false;
let VIDEO_AI_ENABLED = false;

console.log('🔧 Heimdall Backend v3.0 Configuration:');
console.log(`📁 Temp Directory: ${TEMP_DIR}`);
console.log(`📁 Uploads Directory: ${UPLOADS_DIR}`);
console.log(`🪣 GCS Bucket: ${BUCKET_NAME}`);
console.log(`🔑 GCS Key File: ${GCLOUD_KEYFILE}`);
console.log(`🏢 GCP Project ID: ${GCLOUD_PROJECT_ID}`);

// Ensure directories exist
Promise.all([
  fs.mkdir(TEMP_DIR, { recursive: true }),
  fs.mkdir(UPLOADS_DIR, { recursive: true })
]).catch(console.error);

// Initialize Google Cloud services
let storage, videoClient;

async function initializeGoogleCloudServices() {
  try {
    // Check if key file exists
    try {
      await fs.access(GCLOUD_KEYFILE);
      console.log('✅ GCS key file found');
    } catch (error) {
      console.log('❌ GCS key file not found at:', GCLOUD_KEYFILE);
      console.log('⚠️  GCS upload will be disabled');
      return;
    }

    if (!GCLOUD_PROJECT_ID) {
      console.log('❌ GCLOUD_PROJECT_ID environment variable not set');
      console.log('⚠️  GCS upload will be disabled');
      return;
    }

    // Initialize Storage
    storage = new Storage({
      keyFilename: GCLOUD_KEYFILE,
      projectId: GCLOUD_PROJECT_ID,
    });

    // Test bucket access
    try {
      const bucket = storage.bucket(BUCKET_NAME);
      await bucket.getMetadata();
      console.log('✅ GCS Storage initialized and bucket accessible');
      GCS_ENABLED = true;
    } catch (bucketError) {
      console.log('❌ GCS bucket access failed:', bucketError.message);
      return;
    }

    // Initialize Video Intelligence
    try {
      videoClient = new videoIntelligence.VideoIntelligenceServiceClient({
        keyFilename: GCLOUD_KEYFILE,
      });
      console.log('✅ Video Intelligence API initialized');
      VIDEO_AI_ENABLED = true;
    } catch (videoError) {
      console.log('❌ Video Intelligence initialization failed:', videoError.message);
    }

  } catch (error) {
    console.error('❌ Google Cloud services initialization failed:', error.message);
  }
}

// CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'Origin', 'Accept'],
  credentials: true,
  maxAge: 86400
}));

// Additional middleware for ngrok compatibility
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, ngrok-skip-browser-warning');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mount the video intelligence API router
app.use('/api/video-intelligence', videoIntelligenceRouter);

// Serve command center dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'command-center.html'));
});

// Multer configuration for temporary file storage
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
    files: 2 // video + metadata
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video' && file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else if (file.fieldname === 'metadata' && file.mimetype === 'application/json') {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type for field ${file.fieldname}: ${file.mimetype}`));
    }
  },
});

// Active recording sessions
const activeSessions = new Map();
const uploadQueue = new Map(); // Track upload status
const analysisResults = new Map(); // Store analysis results by gcsUri

// Immediate GCP upload function with presigned URL generation
async function uploadToGCPImmediately(localFilePath, gcsPath, metadata = {}) {
  if (!GCS_ENABLED) {
    console.log('⚠️  GCS disabled, skipping upload for:', gcsPath);
    return { success: false, reason: 'GCS_DISABLED' };
  }

  try {
    console.log(`📤 Starting immediate GCS upload: ${localFilePath} → gs://${BUCKET_NAME}/${gcsPath}`);
    
    const startTime = Date.now();
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(gcsPath);

    // Upload with metadata
    await bucket.upload(localFilePath, {
      destination: gcsPath,
      metadata: {
        contentType: 'video/mp4',
        cacheControl: 'public, max-age=31536000',
        metadata: {
          ...metadata,
          uploadTimestamp: new Date().toISOString(),
          originalPath: localFilePath,
          analysisStatus: 'pending' // Mark for later analysis
        }
      },
    });

    // Generate presigned URL valid for 48 hours
    const [presignedUrl] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 48 * 60 * 60 * 1000, // 48 hours from now
    });

    const duration = Date.now() - startTime;
    console.log(`✅ GCS upload completed in ${duration}ms: gs://${BUCKET_NAME}/${gcsPath}`);
    console.log(`🔗 Presigned URL generated (48h validity): ${presignedUrl.substring(0, 100)}...`);
    
    return { 
      success: true, 
      gcsUri: `gs://${BUCKET_NAME}/${gcsPath}`,
      presignedUrl,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      duration,
      metadata 
    };

  } catch (error) {
    console.error(`❌ GCS upload failed for ${gcsPath}:`, error.message);
    return { 
      success: false, 
      error: error.message,
      gcsPath 
    };
  }
}

// Process video for AI analysis
async function processVideoAnalysis(gcsUri, metadata) {
  if (!VIDEO_AI_ENABLED) {
    console.log('⚠️  Video AI disabled, skipping analysis for:', gcsUri);
    return null;
  }

  try {
    console.log(`🤖 Starting AI analysis for: ${gcsUri}`);
    
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
    const [result] = await operation.promise();
    
    console.log(`✅ AI analysis completed for: ${gcsUri}`);
    return {
      ...result.annotationResults[0],
      processedAt: new Date().toISOString(),
      metadata
    };

  } catch (error) {
    console.error(`❌ AI analysis failed for ${gcsUri}:`, error.message);
    return {
      error: error.message,
      processedAt: new Date().toISOString(),
      metadata
    };
  }
}

// Clean up local temp file after processing
async function cleanupTempFile(filePath) {
  try {
    await fs.unlink(filePath);
    console.log(`🗑️  Cleaned up temp file: ${filePath}`);
  } catch (error) {
    console.warn(`⚠️  Failed to cleanup temp file: ${filePath}`, error.message);
  }
}

// Move file to permanent storage
async function moveToUploads(tempPath, sessionId, chunkIndex, deviceId = 'unknown') {
  try {
    const deviceDir = path.join(UPLOADS_DIR, deviceId);
    const sessionDir = path.join(deviceDir, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });
    
    const timestamp = Math.floor(Date.now() / 1000);
    const fileName = `chunk_${timestamp}.mp4`;
    const permanentPath = path.join(sessionDir, fileName);
    
    await fs.copyFile(tempPath, permanentPath);
    console.log(`📁 Moved to permanent storage: ${permanentPath}`);
    
    return permanentPath;
  } catch (error) {
    console.error('❌ Failed to move file to permanent storage:', error);
    throw error;
  }
}

// Monitor and upload temp files to GCP in parallel
async function uploadTempFilesToGCP() {
  if (!GCS_ENABLED) {
    console.log('⚠️  GCS disabled, skipping temp file uploads');
    return;
  }

  try {
    const tempFiles = await fs.readdir(TEMP_DIR);
    const videoFiles = tempFiles.filter(file => 
      (file.endsWith('.mp4') || file.endsWith('.mov') || file.endsWith('.mkv')) &&
      !file.includes('.metadata.json')
    );

    if (videoFiles.length === 0) {
      return;
    }

    console.log(`📁 Found ${videoFiles.length} video files in temp directory, processing in parallel...`);

    // Process files in parallel like the chunk upload system
    const uploadPromises = videoFiles.map(async (filename) => {
      const videoPath = path.join(TEMP_DIR, filename);
      const metadataPath = videoPath + '.metadata.json';
      
      try {
        // Check if metadata file exists
        let metadata = {};
        let uploadId = 'temp-' + Date.now();
        let sessionId = 'unknown';
        let deviceId = 'unknown';
        let chunkIndex = Date.now();

        try {
          await fs.access(metadataPath);
          const metadataContent = await fs.readFile(metadataPath, 'utf8');
          const parsedMetadata = JSON.parse(metadataContent);
          
          metadata = parsedMetadata;
          uploadId = parsedMetadata.uploadId || uploadId;
          sessionId = parsedMetadata.sessionId || sessionId;
          deviceId = parsedMetadata.deviceId || deviceId;
          chunkIndex = parsedMetadata.chunkIndex || chunkIndex;
          
          console.log(`📋 Processing chunk [${uploadId}] with metadata for ${filename}`);
        } catch (metadataError) {
          console.warn(`⚠️  No metadata found for ${filename}, using defaults`);
          metadata = {
            source: 'temp-directory',
            originalFilename: filename,
            foundAt: new Date().toISOString(),
            deviceId,
            sessionId: 'temp-session'
          };
        }

        // Generate GCS path like the chunk upload system
        const timestamp = Math.floor(Date.now() / 1000);
        const gcsPath = `devices/${deviceId}/${timestamp}.mp4`;
        
        // Upload to GCS with same logic as chunk upload
        const result = await uploadToGCPImmediately(videoPath, gcsPath, metadata);

        if (result.success) {
          // Update session info if session exists
          if (activeSessions.has(sessionId)) {
            const session = activeSessions.get(sessionId);
            const uploadInfo = session.uploads?.find(u => u.uploadId === uploadId);
            if (uploadInfo) {
              uploadInfo.gcsUri = result.gcsUri;
              uploadInfo.presignedUrl = result.presignedUrl;
              uploadInfo.expiresAt = result.expiresAt;
              uploadInfo.status = 'completed';
              uploadInfo.gcsUploadedAt = new Date().toISOString();
              console.log(`✅ Updated session ${sessionId} with GCS info for chunk ${chunkIndex}`);
            }
          }

          // Store analysis results entry
          analysisResults.set(result.gcsUri, {
            uploadId,
            gcsUri: result.gcsUri,
            sessionId,
            deviceId,
            chunkIndex,
            status: 'pending_analysis',
            uploadedAt: new Date().toISOString(),
            metadata
          });

          // Clean up temp files after successful upload
          await cleanupTempFile(videoPath);
          
          // Clean up metadata file
          try {
            await cleanupTempFile(metadataPath);
          } catch (metaCleanError) {
            console.warn(`⚠️  Could not clean metadata file: ${metadataPath}`);
          }
          
          console.log(`✅ Temp file uploaded and cleaned: ${filename} → ${result.gcsUri}`);
          return { 
            filename, 
            uploadId,
            sessionId,
            deviceId,
            chunkIndex,
            success: true, 
            gcsUri: result.gcsUri,
            presignedUrl: result.presignedUrl,
            expiresAt: result.expiresAt,
            duration: result.duration
          };
        } else {
          console.log(`❌ Failed to upload temp file: ${filename}`, result.error);
          return { 
            filename, 
            uploadId,
            sessionId, 
            success: false, 
            error: result.error 
          };
        }
      } catch (error) {
        console.error(`❌ Error processing temp file ${filename}:`, error.message);
        return { 
          filename, 
          uploadId: 'error',
          sessionId: 'unknown',
          success: false, 
          error: error.message 
        };
      }
    });

    const results = await Promise.all(uploadPromises);
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    if (successful.length > 0 || failed.length > 0) {
      console.log(`📊 Temp upload batch completed: ${successful.length} successful, ${failed.length} failed`);
      
      // Log successful uploads with session info
      successful.forEach(result => {
        console.log(`   ✅ ${result.filename} → Session: ${result.sessionId}, Chunk: ${result.chunkIndex}, Duration: ${result.duration}ms`);
      });
      
      // Log failed uploads
      failed.forEach(result => {
        console.log(`   ❌ ${result.filename} → Error: ${result.error}`);
      });
    }

    return results;

  } catch (error) {
    console.error('❌ Error scanning temp directory:', error.message);
  }
}

// Start periodic temp file monitoring
function startTempFileMonitoring() {
  if (GCS_ENABLED) {
    console.log('🔄 Starting temp file monitoring (every 3 seconds)');
    
    // Initial upload
    uploadTempFilesToGCP();
    
    // Set up periodic monitoring with better logging
    setInterval(async () => {
      try {
        const result = await uploadTempFilesToGCP();
        if (result && (result.successful > 0 || result.failed > 0)) {
          console.log(`📊 Temp monitoring: ${result.successful || 0} uploaded, ${result.failed || 0} failed`);
        }
      } catch (error) {
        console.error('❌ Temp file monitoring error:', error.message);
      }
    }, 3000); // Check every 3 seconds
  }
}

// API Routes

// Health check
app.get('/health', (req, res) => {
  const analysisStats = {
    total: analysisResults.size,
    completed: Array.from(analysisResults.values()).filter(a => !a.error && !a.status).length,
    failed: Array.from(analysisResults.values()).filter(a => a.status === 'failed').length
  };

  res.json({
    status: 'healthy',
    timestamp: new Date(),
    server: 'Heimdall Backend v3.0',
    activeSessions: activeSessions.size,
    analysisResults: analysisStats,
    services: {
      gcs: {
        enabled: GCS_ENABLED,
        bucket: BUCKET_NAME,
      },
      videoAI: {
        enabled: VIDEO_AI_ENABLED,
      },
    },
    configuration: {
      tempDir: TEMP_DIR,
      uploadsDir: UPLOADS_DIR,
      port: PORT,
    }
  });
});

// Start recording session
app.post('/start-recording', (req, res) => {
  try {
    const sessionId = uuidv4();
    const session = {
      sessionId,
      startTime: new Date(),
      chunkCount: 0,
      status: 'active',
      uploads: []
    };
    
    activeSessions.set(sessionId, session);
    console.log(`🎬 Recording session started: ${sessionId}`);
    
    res.json({
      success: true,
      sessionId,
      startTime: session.startTime,
      message: 'Recording session started successfully'
    });
    
  } catch (error) {
    console.error('❌ Failed to start recording session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stop recording session
app.post('/stop-recording', (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (sessionId && activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.status = 'stopped';
      session.endTime = new Date();
      
      console.log(`🛑 Recording session stopped: ${sessionId}`);
      
      res.json({
        success: true,
        sessionId,
        summary: {
          duration: session.endTime - session.startTime,
          chunksProcessed: session.chunkCount,
          uploads: session.uploads.length
        }
      });
    } else {
      res.json({
        success: true,
        message: 'No active session to stop'
      });
    }
    
  } catch (error) {
    console.error('❌ Failed to stop recording session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Upload video chunk - main endpoint
app.post('/upload-chunk', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'metadata', maxCount: 1 }
]), async (req, res) => {
  const startTime = Date.now();
  const uploadId = uuidv4();
  
  console.log(`📥 Upload request received [${uploadId}] at ${new Date().toISOString()}`);
  
  try {
    const files = req.files;
    const videoFile = files?.video?.[0];
    const metadataFile = files?.metadata?.[0];
    
    if (!videoFile) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided',
        uploadId
      });
    }

    // Parse metadata if provided
    let metadata = {};
    if (metadataFile) {
      try {
        const metadataContent = await fs.readFile(metadataFile.path, 'utf8');
        metadata = JSON.parse(metadataContent);
        console.log(`📋 Metadata parsed for upload [${uploadId}]`);
      } catch (metadataError) {
        console.warn(`⚠️  Failed to parse metadata for upload [${uploadId}]:`, metadataError.message);
      }
    }

    const chunkIndex = metadata.chunkIndex || Date.now();
    const sessionId = metadata.sessionId || 'unknown';
    const deviceId = metadata.deviceId || 'unknown';
    
    console.log(`📹 Processing video chunk [${uploadId}] - Session: ${sessionId}, Chunk: ${chunkIndex}`);
    
    // Update session info
    if (activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.chunkCount++;
      session.lastChunkTime = new Date();
    }

    // Generate GCS path
    const timestamp = Math.floor(Date.now() / 1000);
    const gcsPath = `devices/${deviceId}/${timestamp}.mp4`;
    
    // 1. Move to permanent storage immediately (for backup)
    const permanentPath = await moveToUploads(videoFile.path, sessionId, chunkIndex, deviceId);
    
    // 2. Upload to GCS immediately using the temp file
    const gcsResult = await uploadToGCPImmediately(videoFile.path, gcsPath, {
      ...metadata,
      uploadId,
      sessionId,
      chunkIndex,
      deviceId,
      timestamp: new Date().toISOString()
    });
    
    // 3. Store upload info for session tracking
    if (activeSessions.has(sessionId)) {
      const session = activeSessions.get(sessionId);
      session.uploads = session.uploads || [];
      session.uploads.push({
        uploadId,
        chunkIndex,
        gcsUri: gcsResult.success ? gcsResult.gcsUri : null,
        presignedUrl: gcsResult.success ? gcsResult.presignedUrl : null,
        expiresAt: gcsResult.success ? gcsResult.expiresAt : null,
        localPath: permanentPath,
        uploadStatus: gcsResult.success ? 'completed' : 'failed',
        gcsError: gcsResult.success ? null : gcsResult.error,
        timestamp: new Date()
      });
    }

    // 4. Clean up temp file after successful operations
    await cleanupTempFile(videoFile.path);
    
    // 5. Clean up metadata temp file from multer
    if (metadataFile) {
      await cleanupTempFile(metadataFile.path);
    }

    const totalDuration = Date.now() - startTime;
    
    console.log(`✅ Upload [${uploadId}] completed in ${totalDuration}ms`);
    console.log(`   📁 Local Storage: ✅ ${permanentPath}`);
    console.log(`   📤 GCS Upload: ${gcsResult.success ? '✅' : '❌'} ${gcsResult.success ? gcsResult.gcsUri : gcsResult.error}`);
    if (gcsResult.success) {
      console.log(`   🔗 Presigned URL: ✅ (48h validity)`);
    }

    // Send response with all upload details
    res.json({
      success: true,
      uploadId,
      sessionId,
      chunkIndex,
      localPath: permanentPath,
      gcsUpload: {
        success: gcsResult.success,
        gcsUri: gcsResult.success ? gcsResult.gcsUri : null,
        presignedUrl: gcsResult.success ? gcsResult.presignedUrl : null,
        expiresAt: gcsResult.success ? gcsResult.expiresAt : null,
        error: gcsResult.success ? null : gcsResult.error
      },
      processingTime: totalDuration,
      timestamp: new Date().toISOString(),
      message: gcsResult.success ? 
        'Video chunk uploaded successfully to GCS with 48h access URL' : 
        'Video chunk saved locally but GCS upload failed'
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Upload [${uploadId}] failed after ${duration}ms:`, error.message);
    
    res.status(500).json({
      success: false,
      uploadId,
      error: error.message,
      processingTime: duration,
      timestamp: new Date().toISOString()
    });
  }
});

// Get session status
app.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    res.json({
      success: true,
      session: {
        ...session,
        uploads: session.uploads || []
      }
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }
});

// Get upload status for a session
app.get('/session/:sessionId/upload-status', (req, res) => {
  const { sessionId } = req.params;
  
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    const uploads = session.uploads || [];
    
    const uploadStats = {
      total: uploads.length,
      completed: uploads.filter(u => u.status === 'completed').length,
      pending: uploads.filter(u => u.status === 'pending_gcs_upload').length,
      failed: uploads.filter(u => u.status === 'failed').length
    };
    
    const completedUploads = uploads
      .filter(u => u.status === 'completed')
      .map(u => ({
        uploadId: u.uploadId,
        chunkIndex: u.chunkIndex,
        gcsUri: u.gcsUri,
        presignedUrl: u.presignedUrl,
        expiresAt: u.expiresAt,
        gcsUploadedAt: u.gcsUploadedAt
      }));
    
    res.json({
      success: true,
      sessionId,
      uploadStats,
      completedUploads,
      allCompleted: uploadStats.pending === 0,
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }
});

// List all sessions
app.get('/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
    sessionId: id,
    ...session
  }));
  
  res.json({
    success: true,
    sessions,
    total: sessions.length
  });
});

// List all uploaded videos
app.get('/videos', async (req, res) => {
  try {
    if (!GCS_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'GCS not enabled'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({
      prefix: 'devices/', // Get all video files under devices/
    });

    const videos = await Promise.all(
      files
        .filter(file => file.name.endsWith('.mp4') || file.name.endsWith('.mov') || file.name.endsWith('.mkv'))
        .map(async (file) => {
          try {
            const [metadata] = await file.getMetadata();
            
            // Generate new presigned URL (48 hours)
            const [presignedUrl] = await file.getSignedUrl({
              action: 'read',
              expires: Date.now() + 48 * 60 * 60 * 1000,
            });

            const gcsUri = `gs://${BUCKET_NAME}/${file.name}`;
            const analysisData = analysisResults.get(gcsUri);

            return {
              filename: file.name,
              gcsUri,
              presignedUrl,
              expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
              size: metadata.size,
              created: metadata.timeCreated,
              updated: metadata.updated,
              analysisStatus: analysisData ? (analysisData.status === 'failed' ? 'failed' : 'completed') : 'pending',
              analysisCompletedAt: analysisData?.completedAt,
              deviceId: metadata.metadata?.deviceId || 'unknown',
              sessionId: file.name.split('/')[2] || 'unknown', // Extract from path
              chunkIndex: metadata.metadata?.chunkIndex || 'unknown'
            };
          } catch (error) {
            console.warn(`⚠️  Could not get metadata for ${file.name}:`, error.message);
            return {
              filename: file.name,
              gcsUri: `gs://${BUCKET_NAME}/${file.name}`,
              error: 'Metadata unavailable'
            };
          }
        })
    );

    res.json({
      success: true,
      videos: videos.filter(v => !v.error), // Only return successful ones
      total: videos.filter(v => !v.error).length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error listing videos:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get videos by device ID
app.get('/videos/device/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    
    if (!GCS_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'GCS not enabled'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({
      prefix: `devices/${deviceId}/`, // Filter by device ID
    });

    const videos = await Promise.all(
      files
        .filter(file => file.name.endsWith('.mp4') || file.name.endsWith('.mov') || file.name.endsWith('.mkv'))
        .map(async (file) => {
          try {
            const [metadata] = await file.getMetadata();
            
            // Generate new presigned URL (48 hours)
            const [presignedUrl] = await file.getSignedUrl({
              action: 'read',
              expires: Date.now() + 48 * 60 * 60 * 1000,
            });

            const gcsUri = `gs://${BUCKET_NAME}/${file.name}`;
            const analysisData = analysisResults.get(gcsUri);

            return {
              filename: file.name,
              gcsUri,
              presignedUrl,
              expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
              size: metadata.size,
              created: metadata.timeCreated,
              updated: metadata.updated,
              analysisStatus: analysisData ? (analysisData.status === 'failed' ? 'failed' : 'completed') : 'pending',
              analysisCompletedAt: analysisData?.completedAt,
              deviceId: metadata.metadata?.deviceId || deviceId,
              sessionId: file.name.split('/')[2] || 'unknown',
              chunkIndex: metadata.metadata?.chunkIndex || 'unknown'
            };
          } catch (error) {
            console.warn(`⚠️  Could not get metadata for ${file.name}:`, error.message);
            return {
              filename: file.name,
              gcsUri: `gs://${BUCKET_NAME}/${file.name}`,
              error: 'Metadata unavailable'
            };
          }
        })
    );

    const validVideos = videos.filter(v => !v.error);

    res.json({
      success: true,
      deviceId,
      videos: validVideos,
      total: validVideos.length,
      analysisStatus: {
        completed: validVideos.filter(v => v.analysisStatus === 'completed').length,
        pending: validVideos.filter(v => v.analysisStatus === 'pending').length,
        failed: validVideos.filter(v => v.analysisStatus === 'failed').length
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error listing videos for device:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get analysis results for a specific video
app.get('/analysis/:gcsUri(*)', async (req, res) => {
  try {
    const gcsUri = req.params.gcsUri;
    
    if (!gcsUri) {
      return res.status(400).json({
        success: false,
        error: 'GCS URI is required'
      });
    }

    // Reconstruct full GCS URI if needed
    const fullGcsUri = gcsUri.startsWith('gs://') ? gcsUri : `gs://${BUCKET_NAME}/${gcsUri}`;
    
    const analysisData = analysisResults.get(fullGcsUri);
    
    if (!analysisData) {
      return res.status(404).json({
        success: false,
        error: 'Analysis results not found for this video',
        gcsUri: fullGcsUri,
        message: 'Video may not have been analyzed yet. Use POST /analyze-video to start analysis.'
      });
    }

    res.json({
      success: true,
      gcsUri: fullGcsUri,
      analysis: analysisData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error retrieving analysis results:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get all analysis results
app.get('/analysis', (req, res) => {
  try {
    const allAnalysis = Array.from(analysisResults.entries()).map(([gcsUri, data]) => ({
      gcsUri,
      ...data
    }));

    const summary = {
      total: allAnalysis.length,
      completed: allAnalysis.filter(a => !a.error && !a.status).length,
      failed: allAnalysis.filter(a => a.status === 'failed').length,
      byType: {
        manual: allAnalysis.filter(a => a.type === 'manual').length,
        bulk: allAnalysis.filter(a => a.type === 'bulk').length
      }
    };

    res.json({
      success: true,
      analysis: allAnalysis,
      summary,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error retrieving all analysis results:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Trigger video analysis for specific video
app.post('/analyze-video', async (req, res) => {
  try {
    const { gcsUri, videoId } = req.body;

    if (!gcsUri) {
      return res.status(400).json({
        success: false,
        error: 'gcsUri is required'
      });
    }

    if (!VIDEO_AI_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Video AI not enabled'
      });
    }

    const analysisId = uuidv4();
    console.log(`🤖 Starting manual analysis [${analysisId}] for: ${gcsUri}`);

    // Start analysis (fire and forget)
    processVideoAnalysis(gcsUri, { 
      analysisId,
      videoId: videoId || gcsUri,
      triggeredAt: new Date().toISOString(),
      type: 'manual'
    })
      .then(result => {
        console.log(`✅ Manual analysis completed [${analysisId}]`);
        
        // Store analysis results for later retrieval
        analysisResults.set(gcsUri, {
          analysisId,
          gcsUri,
          result,
          completedAt: new Date().toISOString(),
          type: 'manual'
        });
        
        console.log(`💾 Analysis results stored for: ${gcsUri}`);
      })
      .catch(error => {
        console.error(`❌ Manual analysis failed [${analysisId}]:`, error.message);
        
        // Store error results too
        analysisResults.set(gcsUri, {
          analysisId,
          gcsUri,
          error: error.message,
          completedAt: new Date().toISOString(),
          type: 'manual',
          status: 'failed'
        });
      });

    res.json({
      success: true,
      analysisId,
      message: 'Video analysis started',
      gcsUri,
      estimatedCompletion: new Date(Date.now() + 5 * 60 * 1000).toISOString() // ~5 minutes
    });

  } catch (error) {
    console.error('❌ Error starting video analysis:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Trigger bulk analysis for all pending videos
app.post('/analyze-all-videos', async (req, res) => {
  try {
    if (!VIDEO_AI_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'Video AI not enabled'
      });
    }

    if (!GCS_ENABLED) {
      return res.status(503).json({
        success: false,
        error: 'GCS not enabled'
      });
    }

    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({
      prefix: 'devices/',
    });

    const videoFiles = files.filter(file => 
      file.name.endsWith('.mp4') || file.name.endsWith('.mov') || file.name.endsWith('.mkv')
    );

    let analysisTasks = [];
    let pendingCount = 0;

    for (const file of videoFiles) {
      try {
        const [metadata] = await file.getMetadata();
        const analysisStatus = metadata.metadata?.analysisStatus;
        
        if (analysisStatus === 'pending' || !analysisStatus) {
          const gcsUri = `gs://${BUCKET_NAME}/${file.name}`;
          const analysisId = uuidv4();
          
          analysisTasks.push({
            analysisId,
            gcsUri,
            filename: file.name
          });

          // Start analysis (fire and forget)
          processVideoAnalysis(gcsUri, {
            analysisId,
            filename: file.name,
            triggeredAt: new Date().toISOString(),
            type: 'bulk'
          })
            .then(result => {
              console.log(`✅ Bulk analysis completed [${analysisId}] for: ${file.name}`);
              
              // Store analysis results for later retrieval
              analysisResults.set(gcsUri, {
                analysisId,
                gcsUri,
                filename: file.name,
                result,
                completedAt: new Date().toISOString(),
                type: 'bulk'
              });
            })
            .catch(error => {
              console.error(`❌ Bulk analysis failed [${analysisId}] for ${file.name}:`, error.message);
              
              // Store error results too
              analysisResults.set(gcsUri, {
                analysisId,
                gcsUri,
                filename: file.name,
                error: error.message,
                completedAt: new Date().toISOString(),
                type: 'bulk',
                status: 'failed'
              });
            });

          pendingCount++;
        }
      } catch (error) {
        console.warn(`⚠️  Could not check analysis status for ${file.name}:`, error.message);
      }
    }

    res.json({
      success: true,
      message: `Started analysis for ${pendingCount} pending videos`,
      totalVideos: videoFiles.length,
      pendingAnalysis: pendingCount,
      alreadyAnalyzed: videoFiles.length - pendingCount,
      analysisTasks,
      estimatedCompletion: new Date(Date.now() + pendingCount * 2 * 60 * 1000).toISOString() // ~2 min per video
    });

  } catch (error) {
    console.error('❌ Error starting bulk analysis:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Debug endpoint
app.get('/debug/status', (req, res) => {
  res.json({
    timestamp: new Date(),
    activeSessions: activeSessions.size,
    services: {
      gcs: GCS_ENABLED,
      videoAI: VIDEO_AI_ENABLED,
      firebase: firebase.isInitialized
    },
    directories: {
      temp: TEMP_DIR,
      uploads: UPLOADS_DIR
    },
    server: 'Heimdall Security System v3.0'
  });
});

// Upload queue status endpoint
app.get('/api/upload-status', async (req, res) => {
  try {
    // Count temp files
    let tempFileCount = 0;
    try {
      const tempFiles = await fs.readdir(TEMP_DIR);
      tempFileCount = tempFiles.filter(f => 
        f.endsWith('.mp4') || f.endsWith('.mov') || f.endsWith('.mkv')
      ).length;
    } catch (error) {
      console.warn('Could not read temp directory:', error.message);
    }

    // Get session upload stats
    const allSessions = Array.from(activeSessions.values());
    const allUploads = allSessions.flatMap(session => session.uploads || []);
    
    const uploadStats = {
      completed: allUploads.filter(u => u.uploadStatus === 'completed').length,
      failed: allUploads.filter(u => u.uploadStatus === 'failed').length,
      pending: allUploads.filter(u => u.uploadStatus === 'pending_gcs_upload').length,
      total: allUploads.length
    };

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      tempFiles: tempFileCount,
      uploads: uploadStats,
      services: {
        gcs: GCS_ENABLED,
        videoAI: VIDEO_AI_ENABLED
      },
      activeSessions: activeSessions.size
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Debug endpoint for temp directory and upload status
app.get('/debug/temp-status', async (req, res) => {
  try {
    const tempFiles = await fs.readdir(TEMP_DIR);
    const videoFiles = tempFiles.filter(file => 
      (file.endsWith('.mp4') || file.endsWith('.mov') || file.endsWith('.mkv')) &&
      !file.includes('.metadata.json')
    );
    const metadataFiles = tempFiles.filter(file => file.includes('.metadata.json'));
    
    // Get pending uploads from all sessions
    const allSessions = Array.from(activeSessions.values());
    const pendingUploads = allSessions.reduce((acc, session) => {
      const pending = (session.uploads || []).filter(u => u.status === 'pending_gcs_upload');
      return acc.concat(pending.map(u => ({
        sessionId: session.sessionId,
        uploadId: u.uploadId,
        chunkIndex: u.chunkIndex,
        tempPath: u.tempPath
      })));
    }, []);
    
    res.json({
      timestamp: new Date(),
      tempDirectory: {
        path: TEMP_DIR,
        videoFiles: videoFiles.length,
        metadataFiles: metadataFiles.length,
        videoFilesList: videoFiles,
        metadataFilesList: metadataFiles
      },
      uploadStatus: {
        pendingGcsUploads: pendingUploads.length,
        pendingUploadsList: pendingUploads
      },
      services: {
        gcs: GCS_ENABLED,
        tempMonitoring: GCS_ENABLED ? 'Active (2s intervals)' : 'Disabled'
      }
    });
  } catch (error) {
    res.status(500).json({
      timestamp: new Date(),
      error: error.message,
      tempDirectory: TEMP_DIR
    });
  }
});

// ==============================================
// HEIMDALL AI SECURITY SYSTEM API ENDPOINTS
// ==============================================

// Socket.IO real-time communication
io.on('connection', (socket) => {
  console.log('📡 Client connected to real-time feed:', socket.id);
  
  socket.on('join_command_center', () => {
    socket.join('command_center');
    console.log('🎯 Client joined command center feed');
  });

  socket.on('join_responder', (responderId) => {
    socket.join(`responder_${responderId}`);
    console.log(`👮 Responder ${responderId} joined feed`);
  });

  socket.on('disconnect', () => {
    console.log('📡 Client disconnected:', socket.id);
  });
});

// Crowd Analysis Endpoints
app.post('/api/ai/analyze-crowd', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    const imageBuffer = await fs.readFile(req.file.path);
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    const analysis = await CrowdAnalyzer.analyzeCrowdDensity(imageBuffer, metadata);
    
    // Clean up temp file
    await fs.unlink(req.file.path);

    // Emit real-time update
    io.to('command_center').emit('crowd_analysis', analysis);

    res.json({
      success: true,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Crowd analysis failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/ai/predict-bottlenecks', async (req, res) => {
  try {
    const { currentConditions, historicalData } = req.body;

    if (!currentConditions) {
      return res.status(400).json({
        success: false,
        error: 'Current conditions data required'
      });
    }

    const prediction = await CrowdAnalyzer.predictBottlenecks(historicalData || [], currentConditions);
    
    // Emit real-time alert if high risk
    if (prediction.riskLevel === 'high') {
      io.to('command_center').emit('bottleneck_warning', prediction);
    }

    res.json({
      success: true,
      prediction,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Bottleneck prediction failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Anomaly Detection Endpoints
app.post('/api/ai/detect-anomalies', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    const videoBuffer = await fs.readFile(req.file.path);
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    const analysis = await AnomalyDetector.detectAnomalies(videoBuffer, metadata);
    
    // Clean up temp file
    await fs.unlink(req.file.path);

    // Emit real-time alert for anomalies
    if (analysis.severity === 'high' || analysis.severity === 'critical') {
      io.to('command_center').emit('anomaly_alert', analysis);
    }

    res.json({
      success: true,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Anomaly detection failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Threat Recognition Endpoints
app.post('/api/ai/recognize-threats', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No media file provided'
      });
    }

    const mediaBuffer = await fs.readFile(req.file.path);
    const mediaType = req.body.mediaType || 'image';
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    const analysis = await ThreatRecognizer.recognizeThreats(mediaBuffer, mediaType, metadata);
    
    // Clean up temp file
    await fs.unlink(req.file.path);

    // Emit critical threat alerts immediately
    if (analysis.threatLevel === 'critical') {
      io.to('command_center').emit('threat_alert', analysis);
      
      // Auto-dispatch emergency response for critical threats
      if (analysis.threats.some(t => t.type === 'WEAPON_DETECTED' || t.type === 'FIRE_SMOKE_DETECTED')) {
        const emergencyType = analysis.threats.some(t => t.type === 'WEAPON_DETECTED') ? 'SECURITY_THREAT' : 'FIRE';
        
        try {
          await EmergencyDispatchSystem.dispatchEmergency({
            type: emergencyType,
            location: metadata.location || { lat: 40.7128, lng: -74.0060, description: 'Unknown location' },
            description: `Auto-dispatched due to threat detection: ${analysis.threats.map(t => t.description).join(', ')}`,
            reportedBy: 'AI_THREAT_DETECTION',
            metadata: { threatAnalysis: analysis }
          });
        } catch (dispatchError) {
          console.error('❌ Auto-dispatch failed:', dispatchError.message);
        }
      }
    }

    res.json({
      success: true,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Threat recognition failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Sentiment Analysis Endpoints
app.post('/api/ai/analyze-sentiment', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No image file provided'
      });
    }

    const imageBuffer = await fs.readFile(req.file.path);
    const metadata = req.body.metadata ? JSON.parse(req.body.metadata) : {};

    const analysis = await SentimentAnalyzer.analyzeCrowdSentiment(imageBuffer, metadata);
    
    // Clean up temp file
    await fs.unlink(req.file.path);

    // Emit stress alerts
    if (analysis.stressLevel === 'high') {
      io.to('command_center').emit('stress_alert', analysis);
    }

    res.json({
      success: true,
      analysis,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Sentiment analysis failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Emergency Dispatch Endpoints
app.post('/api/emergency/dispatch', async (req, res) => {
  try {
    const incident = req.body;

    if (!incident.type || !EMERGENCY_TYPES[incident.type]) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or missing emergency type',
        validTypes: Object.keys(EMERGENCY_TYPES)
      });
    }

    const result = await EmergencyDispatchSystem.dispatchEmergency(incident);
    
    // Emit real-time update to command center
    io.to('command_center').emit('emergency_dispatch', result);

    // Notify assigned responders
    if (result.assignments) {
      result.assignments.forEach(assignment => {
        io.to(`responder_${assignment.responderId}`).emit('assignment', {
          incident,
          assignment,
          timestamp: new Date().toISOString()
        });
      });
    }

    res.json(result);

  } catch (error) {
    console.error('❌ Emergency dispatch failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/emergency/types', (req, res) => {
  res.json({
    success: true,
    emergencyTypes: EMERGENCY_TYPES,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/emergency/incidents', async (req, res) => {
  try {
    if (!firebase.db) {
      return res.status(503).json({
        success: false,
        error: 'Firebase not available'
      });
    }

    const snapshot = await firebase.db.ref('incidents').once('value');
    const incidents = snapshot.val() || {};

    const incidentList = Object.values(incidents).sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );

    res.json({
      success: true,
      incidents: incidentList,
      total: incidentList.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to get incidents:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/api/emergency/incidents/:incidentId', async (req, res) => {
  try {
    const { incidentId } = req.params;
    
    if (!firebase.db) {
      return res.status(503).json({
        success: false,
        error: 'Firebase not available'
      });
    }

    const snapshot = await firebase.db.ref(`incidents/${incidentId}`).once('value');
    const incident = snapshot.val();

    if (!incident) {
      return res.status(404).json({
        success: false,
        error: 'Incident not found'
      });
    }

    res.json({
      success: true,
      incident,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to get incident:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Responder Management
app.get('/api/responders', async (req, res) => {
  try {
    if (!firebase.db) {
      return res.status(503).json({
        success: false,
        error: 'Firebase not available'
      });
    }

    const snapshot = await firebase.db.ref('responders').once('value');
    const responders = snapshot.val() || {};

    res.json({
      success: true,
      responders: Object.entries(responders).map(([id, data]) => ({ id, ...data })),
      total: Object.keys(responders).length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to get responders:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/responders', async (req, res) => {
  try {
    const responder = req.body;
    
    if (!firebase.db) {
      return res.status(503).json({
        success: false,
        error: 'Firebase not available'
      });
    }

    const responderId = responder.id || uuidv4();
    const responderData = {
      ...responder,
      id: responderId,
      status: responder.status || 'available',
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    };

    await firebase.db.ref(`responders/${responderId}`).set(responderData);

    res.json({
      success: true,
      responder: responderData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to create responder:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.put('/api/responders/:responderId/status', async (req, res) => {
  try {
    const { responderId } = req.params;
    const { status, location } = req.body;
    
    if (!firebase.db) {
      return res.status(503).json({
        success: false,
        error: 'Firebase not available'
      });
    }

    const updates = {
      status,
      lastUpdated: new Date().toISOString()
    };

    if (location) {
      updates.location = location;
    }

    await firebase.db.ref(`responders/${responderId}`).update(updates);

    // Emit real-time update
    io.to('command_center').emit('responder_status_update', {
      responderId,
      status,
      location,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      responderId,
      updates,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to update responder status:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Real-time Analytics Dashboard
app.get('/api/dashboard/overview', async (req, res) => {
  try {
    const overview = {
      timestamp: new Date().toISOString(),
      activeSessions: activeSessions.size,
      services: {
        gcs: GCS_ENABLED,
        videoAI: VIDEO_AI_ENABLED,
        firebase: firebase.isInitialized,
        realtime: true
      }
    };

    // Get incident statistics
    if (firebase.db) {
      try {
        const [incidentsSnapshot, respondersSnapshot] = await Promise.all([
          firebase.db.ref('incidents').once('value'),
          firebase.db.ref('responders').once('value')
        ]);

        const incidents = incidentsSnapshot.val() || {};
        const responders = respondersSnapshot.val() || {};

        overview.incidents = {
          total: Object.keys(incidents).length,
          active: Object.values(incidents).filter(i => i.status === 'RESPONDING' || i.status === 'DISPATCHING').length,
          resolved: Object.values(incidents).filter(i => i.status === 'RESOLVED').length
        };

        overview.responders = {
          total: Object.keys(responders).length,
          available: Object.values(responders).filter(r => r.status === 'available').length,
          dispatched: Object.values(responders).filter(r => r.status === 'dispatched').length,
          offline: Object.values(responders).filter(r => r.status === 'offline').length
        };
      } catch (dbError) {
        console.warn('⚠️  Database stats unavailable:', dbError.message);
      }
    }

    res.json({
      success: true,
      overview,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to get dashboard overview:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// AI-Powered Query Endpoint (Gemini integration placeholder)
app.post('/api/ai/query', async (req, res) => {
  try {
    const { query, context } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    // For now, return a structured response based on query patterns
    // In production, this would integrate with Gemini for natural language processing
    const response = await processNaturalLanguageQuery(query, context);

    res.json({
      success: true,
      query,
      response,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ AI query failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Simple natural language query processor (placeholder for Gemini)
async function processNaturalLanguageQuery(query, context) {
  const lowercaseQuery = query.toLowerCase();

  // Incident-related queries
  if (lowercaseQuery.includes('what happened') || lowercaseQuery.includes('incident')) {
    if (firebase.db) {
      const snapshot = await firebase.db.ref('incidents').orderByChild('timestamp').limitToLast(5).once('value');
      const recentIncidents = Object.values(snapshot.val() || {});
      
      return {
        type: 'incident_summary',
        summary: `Recent incidents: ${recentIncidents.map(i => `${i.type} at ${i.location?.description || 'unknown location'}`).join(', ')}`,
        incidents: recentIncidents
      };
    }
  }

  // Crowd density queries
  if (lowercaseQuery.includes('crowd') || lowercaseQuery.includes('density')) {
    return {
      type: 'crowd_status',
      summary: 'Crowd analysis data would be retrieved from recent analytics',
      suggestion: 'Use the crowd analysis endpoint to get real-time density data'
    };
  }

  // Responder queries
  if (lowercaseQuery.includes('responder') || lowercaseQuery.includes('security')) {
    if (firebase.db) {
      const snapshot = await firebase.db.ref('responders').once('value');
      const responders = Object.values(snapshot.val() || {});
      const available = responders.filter(r => r.status === 'available').length;
      
      return {
        type: 'responder_status',
        summary: `${available} of ${responders.length} responders are currently available`,
        responders: responders
      };
    }
  }

  // Default response
  return {
    type: 'general',
    summary: 'I can help you with information about incidents, crowd analysis, responder status, and security alerts. Please ask specific questions about these topics.',
    capabilities: [
      'Recent incident reports',
      'Crowd density analysis',
      'Responder availability',
      'Security threat status',
      'Emergency response coordination'
    ]
  };
}

// Initialize and start server
async function startServer() {
  console.log('🚀 Starting Heimdall Backend v3.0...');
  
  // Initialize Google Cloud services
  await initializeGoogleCloudServices();
  
  // Start temp file monitoring
  startTempFileMonitoring();
  
  // Start the server with Socket.IO
  server.listen(PORT, () => {
    console.log(`✅ Heimdall Security System v3.0 running on port ${PORT}`);
    console.log(`🌐 Ready for AI-powered security monitoring`);
    console.log(`🔧 Services Status:`);
    console.log(`   🪣 GCS Upload: ${GCS_ENABLED ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`   🤖 Video AI: ${VIDEO_AI_ENABLED ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`   🔥 Firebase: ${firebase.isInitialized ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`   📡 Real-time: ✅ Socket.IO Active`);
    console.log(`   🚨 Emergency Dispatch: ✅ Ready`);
    console.log(`   🤖 AI Analysis: ✅ Crowd, Threat, Anomaly, Sentiment`);
    console.log(`   📁 Temp Directory: ${TEMP_DIR}`);
    console.log(`   📁 Uploads Directory: ${UPLOADS_DIR}`);
    console.log(`   🔗 Presigned URLs: 48-hour validity`);
    console.log(`   🔄 Temp Monitoring: ${GCS_ENABLED ? '✅ Active (2s intervals)' : '❌ Disabled'}`);
    console.log(`📡 WebSocket server ready for real-time communication`);
    console.log(`🎯 Command center: Connect and emit 'join_command_center'`);
    console.log(`👮 Responders: Connect and emit 'join_responder' with ID`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer().catch(error => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});